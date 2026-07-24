import { supabase, exigirSessao, sair } from "./supabaseClient.js";
import { formatarDataCurta, formatarDuracao, diasDesde, slugPrio, escapeHtml } from "./utils.js";

const STATUS_TABS = ["Aberta", "Em andamento", "Pausada", "Concluída", "Cancelada"];
const RETENCAO_DIAS = 7;

let perfil = null;
let allOS = [];
let temposOS = new Map(); // os_id -> { fechados: segundos, desde: ISO string | null }
let equipamentos = [];
let motivosPausa = [];
let motivosEmergencia = [];
let ajudanteAtivo = null; // { os_id, os_numero, os_equip }
let abaAtiva = "Aberta";
let viewMode = "equipe"; // 'equipe' | 'minhas' — só usado pelo gestor

const $ = (sel) => document.querySelector(sel);
const modalSlot = () => $("#modal-slot");

init();

async function init() {
  perfil = await exigirSessao();
  if (!perfil) return;

  $("#nome-usuario").textContent = perfil.nome;
  $("#chip-papel").textContent = perfil.papel === "gestor" ? "Gestor" : "Colaborador";
  if (perfil.papel === "gestor") {
    $("#chip-papel").classList.add("gestor");
    $("#link-admin").style.display = "inline-block";
    $("#btn-minhas-os").style.display = "inline-block";
  }

  $("#btn-sair").addEventListener("click", sair);
  $("#btn-nova-os").addEventListener("click", abrirModalNovaOS);
  $("#btn-minhas-os").addEventListener("click", () => {
    viewMode = viewMode === "equipe" ? "minhas" : "equipe";
    $("#btn-minhas-os").textContent = viewMode === "minhas" ? "Painel da equipe" : "Minhas O.S.";
    $("#titulo-painel").textContent = viewMode === "minhas" ? "Minhas O.S." : "Ordens de Serviço — Equipe";
    render();
  });

  $("#lista-os").addEventListener("click", onListaClick);

  await Promise.all([carregarLookups(), carregarOS(), carregarTempos(), carregarAjudanteAtivo()]);
  render();

  // Contador de "tempo de trabalho" das O.S. em andamento sobe sozinho,
  // sem bater no banco: atualiza só o texto dos spans a cada 30s.
  setInterval(tickTempos, 30000);

  // Realtime: qualquer mudança relevante recarrega a lista
  supabase.channel("voltos-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "ordens_servico" }, async () => {
      await Promise.all([carregarOS(), carregarTempos()]); render();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "ajudante_ativo" }, async () => {
      await carregarAjudanteAtivo(); render();
    })
    .subscribe();
}

// ---------------------------------------------------------------------
// Carregamento de dados
// ---------------------------------------------------------------------
async function carregarLookups() {
  const [eq, mp, me] = await Promise.all([
    supabase.from("equipamentos").select("*").eq("ativo", true).order("nome"),
    supabase.from("motivos_pausa").select("*").eq("ativo", true).order("ordem"),
    supabase.from("motivos_emergencia").select("*").eq("ativo", true).order("ordem"),
  ]);
  equipamentos = eq.data || [];
  motivosPausa = (mp.data || []).filter(m => !m.sistema); // motivo "sistema" não aparece como opção manual
  motivosEmergencia = me.data || [];
}

async function carregarOS() {
  const { data, error } = await supabase
    .from("ordens_servico")
    .select(`*,
      equipamentos(nome),
      criador:perfis!ordens_servico_criada_por_fkey(nome),
      executor:perfis!ordens_servico_executado_por_fkey(nome)`)
    .order("criada_em", { ascending: false });

  if (error) { console.error(error); return; }
  allOS = data || [];
}

async function carregarTempos() {
  const { data, error } = await supabase
    .from("vw_tempo_execucao_os")
    .select("os_id, segundos_fechados, em_execucao_desde");
  if (error) { console.error(error); return; }
  temposOS = new Map((data || []).map(t => [
    t.os_id,
    { fechados: Number(t.segundos_fechados) || 0, desde: t.em_execucao_desde },
  ]));
}

async function carregarAjudanteAtivo() {
  const { data } = await supabase
    .from("ajudante_ativo")
    .select("os_id, ordens_servico(numero, equipamentos(nome), equipamento_outro)")
    .eq("colaborador_id", perfil.id)
    .maybeSingle();
  ajudanteAtivo = data || null;
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function render() {
  renderBannerAjudante();
  renderTabs();
  renderLista();
}

function renderBannerAjudante() {
  const slot = $("#banner-ajudante-slot");
  if (!ajudanteAtivo) { slot.innerHTML = ""; return; }
  const os = ajudanteAtivo.ordens_servico;
  const equip = os?.equipamentos?.nome || os?.equipamento_outro || "—";
  slot.innerHTML = `
    <div class="banner-ajudante">
      <span>🔧 Você está ajudando: <strong>O.S. #${os?.numero} — ${escapeHtml(equip)}</strong></span>
      <button class="btn-ghost" data-action="sair-ajudante" data-os="${ajudanteAtivo.os_id}">Sair da ajuda</button>
    </div>`;
}

function contarPorStatus(status) {
  return osParaTab(status).length;
}

function renderTabs() {
  $("#tabs").innerHTML = STATUS_TABS.map(status => `
    <button class="tab ${status === abaAtiva ? "ativa" : ""}" data-tab="${status}">
      ${status} <span class="count">${contarPorStatus(status)}</span>
    </button>
  `).join("");
  $("#tabs").querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => { abaAtiva = btn.dataset.tab; render(); });
  });
}

function osParaTab(status) {
  let rows = allOS.filter(os => os.status === status);

  const souColaboradorOuMinhas = perfil.papel === "colaborador" || (perfil.papel === "gestor" && viewMode === "minhas");

  if (status === "Aberta") {
    // todo mundo vê todas as abertas (qualquer um pode adotar)
  } else if (status === "Em andamento") {
    // A equipe inteira precisa ver as O.S. em andamento dos outros pra
    // poder entrar como ajudante (o botão "Ajudar" só aparece no card de
    // uma O.S. em andamento de outra pessoa). Por isso o colaborador vê
    // todas — só o gestor no modo "Minhas O.S." é que filtra pras dele.
    if (perfil.papel === "gestor" && viewMode === "minhas") {
      rows = rows.filter(os => os.executado_por === perfil.id);
    }
  } else if (status === "Pausada") {
    // pausadas da equipe inteira sempre visíveis (para poder retomar)
  } else if (status === "Concluída" || status === "Cancelada") {
    if (souColaboradorOuMinhas) {
      rows = rows.filter(os => os.executado_por === perfil.id || os.criada_por === perfil.id);
    }
    if (perfil.papel === "colaborador") {
      rows = rows.filter(os => {
        const marco = status === "Concluída" ? os.concluida_em : os.cancelada_em;
        return marco ? diasDesde(marco) <= RETENCAO_DIAS : true;
      });
    }
  }
  return rows;
}

function renderLista() {
  const rows = osParaTab(abaAtiva);
  const lista = $("#lista-os");

  if (rows.length === 0) {
    lista.innerHTML = `<div class="empty-state"><div class="icon">⚡</div>Nenhuma O.S. em "${abaAtiva}" por aqui.</div>`;
    return;
  }
  lista.innerHTML = rows.map(osCardHtml).join("");
}

function osCardHtml(os) {
  const equip = os.equipamentos?.nome || os.equipamento_outro || "Equipamento não informado";
  const souExecutor = os.executado_por === perfil.id;
  const souGestor = perfil.papel === "gestor";
  const possoAdotar = os.status === "Aberta" && !ajudanteAtivo;
  const possoCancelarComoColaborador = os.status === "Aberta" && os.criada_por === perfil.id;
  const jaTenhoTrabalhoAtivo = allOS.some(o => o.executado_por === perfil.id && o.status === "Em andamento") || !!ajudanteAtivo;

  let acoes = "";

  if (os.status === "Aberta") {
    if (possoAdotar && !jaTenhoTrabalhoAtivo) acoes += botao("adotar", os.id, "Adotar", "btn-primary");
    if (souGestor || possoCancelarComoColaborador) acoes += botao("cancelar", os.id, "Cancelar", "btn-danger");
  }

  if (os.status === "Em andamento") {
    if (souExecutor) {
      acoes += botao("pausar", os.id, "Pausar", "btn-secondary");
      acoes += botao("concluir", os.id, "Concluir", "btn-primary");
      acoes += botao("material", os.id, "+ Material", "btn-ghost");
    } else if (!jaTenhoTrabalhoAtivo) {
      acoes += botao("ajudar", os.id, "Ajudar", "btn-secondary");
    }
    if (souGestor) acoes += botao("cancelar", os.id, "Cancelar", "btn-danger");
  }

  if (os.status === "Pausada") {
    if (!jaTenhoTrabalhoAtivo) acoes += botao("retomar", os.id, "Retomar", "btn-primary");
    if (souGestor) acoes += botao("cancelar", os.id, "Cancelar", "btn-danger");
  }

  return `
    <div class="os-card ${slugPrio(os.prioridade)}">
      <div class="os-card-top">
        <div>
          <div class="os-numero">O.S. #${os.numero}</div>
          <div class="os-equip">${escapeHtml(equip)}</div>
          <div class="os-setor">${escapeHtml(os.setor_solicitante)} · ${escapeHtml(os.tipo_servico)}${os.tipo_manutencao ? " · " + escapeHtml(os.tipo_manutencao) : ""}</div>
        </div>
        <div class="tag-prio"><span class="led-prio"></span>${escapeHtml(os.prioridade)}</div>
      </div>
      <div class="os-desc">${escapeHtml(os.descricao)}</div>
      <div class="os-meta">
        <span>Aberta por ${escapeHtml(os.criador?.nome || "—")} em ${formatarDataCurta(os.criada_em)}</span>
        ${os.executor ? `<span>Executando: ${escapeHtml(os.executor.nome)}</span>` : ""}
        ${os.tag ? `<span>Tag: ${escapeHtml(os.tag)}</span>` : ""}
        ${tempoOSHtml(os)}
      </div>
      ${acoes ? `<div class="os-actions">${acoes}</div>` : ""}
    </div>`;
}

function botao(action, osId, label, classe) {
  return `<button class="${classe}" data-action="${action}" data-os="${osId}">${label}</button>`;
}

// Tempo de trabalho ATIVO da O.S. (descontando pausas). Para uma O.S. em
// execução, soma o intervalo aberto (agora - em_execucao_desde) por cima
// do que já fechou; para as demais, usa só o tempo fechado (congelado).
function segundosDaOS(os) {
  const t = temposOS.get(os.id);
  if (!t) return 0;
  const emAndamento = os.status === "Em andamento" && t.desde;
  const extra = emAndamento ? (Date.now() - new Date(t.desde).getTime()) / 1000 : 0;
  return t.fechados + Math.max(0, extra);
}

function tempoOSHtml(os) {
  // Aberta nunca teve trabalho; sem dado de tempo, também não mostra nada
  // (ex.: antes de rodar o 08_tempo_os.sql, a view não existe e a lista
  // vem vazia — melhor não exibir "0h00" enganoso).
  if (os.status === "Aberta" || !temposOS.has(os.id)) return "";
  const seg = segundosDaOS(os);
  // Cancelada sem nenhum trabalho registrado: não polui o card.
  if (os.status === "Cancelada" && seg <= 0) return "";

  const rotulo = os.status === "Concluída" ? "Levou " : "";
  // spans em andamento carregam os dados pro contador subir sozinho (tickTempos)
  const t = temposOS.get(os.id);
  const dataAttrs = (os.status === "Em andamento" && t?.desde)
    ? ` data-fechados="${t.fechados}" data-desde="${t.desde}"`
    : "";
  return `<span class="os-tempo" data-os="${os.id}"${dataAttrs}>⏱ ${rotulo}${formatarDuracao(seg)} de trabalho</span>`;
}

// Atualiza só o texto dos contadores em andamento, sem re-renderizar a
// lista (não interfere em modais nem em cliques em andamento).
function tickTempos() {
  document.querySelectorAll(".os-tempo[data-desde]").forEach(span => {
    const fechados = Number(span.dataset.fechados) || 0;
    const desde = new Date(span.dataset.desde).getTime();
    const seg = fechados + Math.max(0, (Date.now() - desde) / 1000);
    span.textContent = `⏱ ${formatarDuracao(seg)} de trabalho`;
  });
}

// ---------------------------------------------------------------------
// Ações (delegação de clique)
// ---------------------------------------------------------------------
async function onListaClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const osId = btn.dataset.os;

  if (action === "adotar") return chamarRpc("adotar_os", { p_os_id: osId }, btn);
  if (action === "retomar") return chamarRpc("retomar_os", { p_os_id: osId }, btn);
  if (action === "ajudar") return chamarRpc("entrar_ajudante", { p_os_id: osId }, btn);
  if (action === "sair-ajudante") return chamarRpc("sair_ajudante", { p_os_id: osId }, btn);
  if (action === "pausar") return abrirModalPausar(osId);
  if (action === "concluir") return abrirModalConcluir(osId);
  if (action === "cancelar") return abrirModalCancelar(osId);
  if (action === "material") return abrirModalMaterial(osId);
}

async function chamarRpc(nome, params, btnOrigem) {
  if (btnOrigem) { btnOrigem.disabled = true; }
  const { error } = await supabase.rpc(nome, params);
  if (error) { alert(error.message); if (btnOrigem) btnOrigem.disabled = false; return false; }
  await carregarOS(); await carregarAjudanteAtivo(); render();
  return true;
}

// delegação única também cobre o botão "Sair da ajuda" dentro do banner
document.getElementById("banner-ajudante-slot").addEventListener("click", onListaClick);

// ---------------------------------------------------------------------
// Modais
// ---------------------------------------------------------------------
function fecharModal() { modalSlot().innerHTML = ""; }

function abrirModal(html) {
  modalSlot().innerHTML = `<div class="modal-overlay" id="overlay">${html}</div>`;
  $("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") fecharModal(); });
  modalSlot().querySelectorAll("[data-fechar]").forEach(b => b.addEventListener("click", fecharModal));
}

function abrirModalNovaOS() {
  const opcoesEquip = equipamentos.map(e => `<option value="${e.id}">${escapeHtml(e.nome)}</option>`).join("");
  const setores = ["Produção", "Qualidade", "Segurança", "Logística", "Almoxarifado", "Utilidades", "Administrativo", "Elétrica"];
  const opcoesSetor = setores.map(s => `<option value="${s}">${s}</option>`).join("");
  const opcoesMotivoEmerg = motivosEmergencia.map(m => `<option value="${m.id}">${escapeHtml(m.descricao)}</option>`).join("");

  abrirModal(`
    <div class="modal">
      <h2>Nova O.S.</h2>
      <form id="form-nova-os">
        <div class="field"><label>Setor solicitante</label>
          <select id="f-setor" required><option value="">Selecione...</option>${opcoesSetor}</select></div>

        <div class="field"><label>Equipamento</label>
          <select id="f-equip"><option value="">Selecione...</option>${opcoesEquip}<option value="__outro__">Outro (digitar)</option></select></div>
        <div class="field" id="wrap-equip-outro" style="display:none">
          <label>Nome do equipamento</label><input id="f-equip-outro" type="text" /></div>

        <div class="field"><label>Tag (opcional)</label><input id="f-tag" type="text" /></div>

        <div class="field"><label>Tipo de serviço</label>
          <select id="f-tipo-servico" required>
            <option value="Manutenção">Manutenção</option>
            <option value="Confecção">Confecção</option>
            <option value="Instalação">Instalação</option>
          </select></div>

        <div class="field" id="wrap-tipo-manutencao"><label>Tipo de manutenção</label>
          <select id="f-tipo-manutencao">
            <option value="Preventiva">Preventiva</option>
            <option value="Corretiva">Corretiva</option>
            <option value="Preditiva">Preditiva</option>
          </select></div>

        <div class="field"><label>Descrição do serviço</label>
          <textarea id="f-descricao" rows="3" required></textarea></div>

        <div class="field"><label>Prioridade</label>
          <div class="radio-group">
            <label class="radio-option"><input type="radio" name="prio" value="Normal" checked /> Normal</label>
            <label class="radio-option"><input type="radio" name="prio" value="Prioritária" /> Prioritária</label>
            <label class="radio-option"><input type="radio" name="prio" value="Emergencial" /> Emergencial</label>
          </div></div>

        <div class="field" id="wrap-motivo-emerg" style="display:none">
          <label>Motivo da emergência</label>
          <select id="f-motivo-emerg"><option value="">Selecione...</option>${opcoesMotivoEmerg}<option value="__outro__">Outro (digitar)</option></select>
          <input id="f-motivo-emerg-outro" type="text" style="display:none; margin-top:8px" placeholder="Descreva o motivo" />
        </div>

        <p class="error-msg" id="erro-nova-os" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primary">Abrir O.S.</button>
        </div>
      </form>
    </div>`);

  $("#f-equip").addEventListener("change", (e) => {
    $("#wrap-equip-outro").style.display = e.target.value === "__outro__" ? "block" : "none";
  });
  $("#f-tipo-servico").addEventListener("change", (e) => {
    $("#wrap-tipo-manutencao").style.display = e.target.value === "Manutenção" ? "block" : "none";
  });
  document.querySelectorAll('input[name="prio"]').forEach(r => r.addEventListener("change", (e) => {
    $("#wrap-motivo-emerg").style.display = e.target.value === "Emergencial" ? "block" : "none";
  }));
  $("#f-motivo-emerg").addEventListener("change", (e) => {
    $("#f-motivo-emerg-outro").style.display = e.target.value === "__outro__" ? "block" : "none";
  });

  $("#form-nova-os").addEventListener("submit", async (e) => {
    e.preventDefault();
    const equipVal = $("#f-equip").value;
    const prioridade = document.querySelector('input[name="prio"]:checked').value;
    const motivoEmergVal = $("#f-motivo-emerg").value;

    const payload = {
      setor_solicitante: $("#f-setor").value,
      equipamento_id: equipVal && equipVal !== "__outro__" ? equipVal : null,
      equipamento_outro: equipVal === "__outro__" ? $("#f-equip-outro").value : null,
      tag: $("#f-tag").value || null,
      tipo_servico: $("#f-tipo-servico").value,
      tipo_manutencao: $("#f-tipo-servico").value === "Manutenção" ? $("#f-tipo-manutencao").value : null,
      descricao: $("#f-descricao").value,
      prioridade,
      motivo_emergencia_id: prioridade === "Emergencial" && motivoEmergVal !== "__outro__" ? motivoEmergVal || null : null,
      motivo_emergencia_outro: prioridade === "Emergencial" && motivoEmergVal === "__outro__" ? $("#f-motivo-emerg-outro").value : null,
      criada_por: perfil.id,
      status: "Aberta",
    };

    const { error } = await supabase.from("ordens_servico").insert(payload);
    if (error) { $("#erro-nova-os").textContent = error.message; $("#erro-nova-os").style.display = "block"; return; }
    fecharModal();
    await carregarOS(); abaAtiva = "Aberta"; render();
  });
}

function abrirModalPausar(osId) {
  const opcoes = motivosPausa.map(m => `
    <label class="radio-option"><input type="radio" name="motivo" value="${m.id}" /> ${escapeHtml(m.descricao)}</label>
  `).join("");

  abrirModal(`
    <div class="modal">
      <h2>Pausar O.S.</h2>
      <form id="form-pausar">
        <div class="field"><label>Motivo da pausa</label>
          <div class="radio-group">
            ${opcoes}
            <label class="radio-option"><input type="radio" name="motivo" value="__outro__" /> Outro</label>
          </div>
        </div>
        <div class="field" id="wrap-outro" style="display:none">
          <label>Descreva</label><input id="f-outro" type="text" />
        </div>
        <p class="error-msg" id="erro-pausar" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primary">Confirmar pausa</button>
        </div>
      </form>
    </div>`);

  document.querySelectorAll('input[name="motivo"]').forEach(r => r.addEventListener("change", (e) => {
    $("#wrap-outro").style.display = e.target.value === "__outro__" ? "block" : "none";
  }));

  $("#form-pausar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const sel = document.querySelector('input[name="motivo"]:checked');
    if (!sel) { $("#erro-pausar").textContent = "Escolha um motivo."; $("#erro-pausar").style.display = "block"; return; }
    const params = sel.value === "__outro__"
      ? { p_os_id: osId, p_motivo_pausa_id: null, p_motivo_outro: $("#f-outro").value }
      : { p_os_id: osId, p_motivo_pausa_id: sel.value, p_motivo_outro: null };
    const { error } = await supabase.rpc("pausar_os", params);
    if (error) { $("#erro-pausar").textContent = error.message; $("#erro-pausar").style.display = "block"; return; }
    fecharModal(); await carregarOS(); render();
  });
}

function abrirModalConcluir(osId) {
  abrirModal(`
    <div class="modal">
      <h2>Concluir O.S.</h2>
      <form id="form-concluir">
        <div class="field"><label>A manutenção foi eficiente?</label>
          <div class="radio-group">
            <label class="radio-option"><input type="radio" name="eficiente" value="sim" checked /> Sim</label>
            <label class="radio-option"><input type="radio" name="eficiente" value="nao" /> Não</label>
          </div>
        </div>
        <div class="field" id="wrap-acao" style="display:none">
          <label>Ação tomada</label>
          <select id="f-acao">
            <option value="Refazer">Refazer</option>
            <option value="Liberar">Liberar</option>
            <option value="Interromper uso">Interromper uso</option>
          </select>
        </div>
        <p class="error-msg" id="erro-concluir" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primary">Concluir O.S.</button>
        </div>
      </form>
    </div>`);

  document.querySelectorAll('input[name="eficiente"]').forEach(r => r.addEventListener("change", (e) => {
    $("#wrap-acao").style.display = e.target.value === "nao" ? "block" : "none";
  }));

  $("#form-concluir").addEventListener("submit", async (e) => {
    e.preventDefault();
    const eficiente = document.querySelector('input[name="eficiente"]:checked').value === "sim";
    const { error } = await supabase.rpc("concluir_os", {
      p_os_id: osId, p_manutencao_eficiente: eficiente, p_acao: eficiente ? null : $("#f-acao").value,
    });
    if (error) { $("#erro-concluir").textContent = error.message; $("#erro-concluir").style.display = "block"; return; }
    fecharModal(); await carregarOS(); abaAtiva = "Concluída"; render();
  });
}

function abrirModalCancelar(osId) {
  abrirModal(`
    <div class="modal">
      <h2>Cancelar O.S.</h2>
      <form id="form-cancelar">
        <div class="field"><label>Motivo do cancelamento</label>
          <textarea id="f-motivo-cancel" rows="3" required placeholder="Ex: aberta por engano, duplicada..."></textarea></div>
        <p class="error-msg" id="erro-cancelar" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Voltar</button>
          <button type="submit" class="btn-danger">Confirmar cancelamento</button>
        </div>
      </form>
    </div>`);

  $("#form-cancelar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await supabase.rpc("cancelar_os", { p_os_id: osId, p_motivo: $("#f-motivo-cancel").value });
    if (error) { $("#erro-cancelar").textContent = error.message; $("#erro-cancelar").style.display = "block"; return; }
    fecharModal(); await carregarOS(); abaAtiva = "Cancelada"; render();
  });
}

function abrirModalMaterial(osId) {
  abrirModal(`
    <div class="modal">
      <h2>Registrar material utilizado</h2>
      <form id="form-material">
        <div class="grid-2">
          <div class="field"><label>Material</label><input id="f-mat-nome" type="text" required /></div>
          <div class="field"><label>Quantidade</label><input id="f-mat-qtd" type="number" step="any" min="0.01" required /></div>
        </div>
        <p class="error-msg" id="erro-material" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Fechar</button>
          <button type="submit" class="btn-primary">Adicionar</button>
        </div>
      </form>
    </div>`);

  $("#form-material").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await supabase.rpc("registrar_material", {
      p_os_id: osId, p_nome: $("#f-mat-nome").value, p_quantidade: Number($("#f-mat-qtd").value),
    });
    if (error) { $("#erro-material").textContent = error.message; $("#erro-material").style.display = "block"; return; }
    fecharModal();
  });
}

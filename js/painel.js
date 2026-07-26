import { supabase, exigirSessao, sair } from "./supabaseClient.js";
import { formatarDataCurta, formatarDuracao, diasDesde, slugPrio, escapeHtml } from "./utils.js";

const STATUS_TABS = ["Aberta", "Em andamento", "Pausada", "Aguardando assinatura", "Concluída", "Cancelada"];
// Rótulo curto na aba (o status "Aguardando assinatura" é longo demais pro
// chip); o valor real continua sendo o status do banco.
const STATUS_LABEL = { "Aguardando assinatura": "Assinatura" };
const RETENCAO_DIAS = 7;

let perfil = null;
let allOS = [];
let temposOS = new Map(); // os_id -> { fechados: segundos, desde: ISO string | null }
let horaHomemOS = new Map(); // os_id -> segundos somando todas as pessoas (hora-homem)
let ajudantesPorOS = new Map(); // os_id -> [nomes] dos que estão ajudando agora
let assinaturasPorOS = new Map(); // os_id -> { inspetor?: nome, supervisor?: nome }
let riscoPorOS = new Map(); // os_id -> boolean (risco de contaminação; define se exige inspetor)
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
    $("#link-relatorio").style.display = "inline-block";
    $("#link-validacao").style.display = "inline-block";
    $("#link-indicadores").style.display = "inline-block";
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

  await Promise.all([carregarLookups(), carregarOS(), carregarTempos(), carregarHoraHomem(), carregarAjudanteAtivo(), carregarAjudantesPorOS(), carregarAssinaturas(), carregarRiscoContam()]);
  render();

  // Contador de "tempo de trabalho" das O.S. em andamento sobe sozinho,
  // sem bater no banco: atualiza só o texto dos spans a cada 30s.
  setInterval(tickTempos, 30000);

  // Realtime: qualquer mudança relevante recarrega a lista
  supabase.channel("voltos-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "ordens_servico" }, async () => {
      await Promise.all([carregarOS(), carregarTempos(), carregarHoraHomem(), carregarRiscoContam()]); render();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "ajudante_ativo" }, async () => {
      await Promise.all([carregarAjudanteAtivo(), carregarAjudantesPorOS(), carregarHoraHomem()]); render();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "assinaturas" }, async () => {
      await carregarAssinaturas(); render();
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

async function carregarAssinaturas() {
  // assinaturas com papel das O.S. aguardando assinatura (pra mostrar o
  // progresso Inspetor/Supervisor e o que ainda falta)
  const { data, error } = await supabase
    .from("assinaturas")
    .select("os_id, papel, nome_responsavel")
    .not("papel", "is", null);
  if (error) { console.error(error); return; }
  const mapa = new Map();
  (data || []).forEach(a => {
    if (!mapa.has(a.os_id)) mapa.set(a.os_id, {});
    mapa.get(a.os_id)[a.papel] = a.nome_responsavel;
  });
  assinaturasPorOS = mapa;
}

async function carregarRiscoContam() {
  // risco de contaminação por O.S. (define se a O.S. exige a assinatura
  // do inspetor, além da do supervisor)
  const { data, error } = await supabase
    .from("checklist_qualidade")
    .select("os_id, risco_contaminacao");
  if (error) { console.error(error); return; }
  riscoPorOS = new Map((data || []).map(c => [c.os_id, c.risco_contaminacao === true]));
}

async function carregarHoraHomem() {
  const { data, error } = await supabase
    .from("vw_horas_homem_os")
    .select("os_id, segundos_homem");
  if (error) { console.error(error); return; }
  horaHomemOS = new Map((data || []).map(h => [h.os_id, Number(h.segundos_homem) || 0]));
}

async function carregarAjudantesPorOS() {
  const { data, error } = await supabase
    .from("ajudante_ativo")
    .select("os_id, colaborador:perfis(nome)");
  if (error) { console.error(error); return; }
  const mapa = new Map();
  (data || []).forEach(a => {
    const nome = a.colaborador?.nome;
    if (!nome) return;
    if (!mapa.has(a.os_id)) mapa.set(a.os_id, []);
    mapa.get(a.os_id).push(nome);
  });
  ajudantesPorOS = mapa;
}

async function carregarAjudanteAtivo() {
  const { data } = await supabase
    .from("ajudante_ativo")
    .select("os_id, ordens_servico(numero, codigo, equipamentos(nome), equipamento_outro)")
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
      <span>🔧 Você está ajudando: <strong>O.S. ${escapeHtml(osLabel(os))} — ${escapeHtml(equip)}</strong></span>
      <button class="btn-ghost" data-action="sair-ajudante" data-os="${ajudanteAtivo.os_id}">Sair da ajuda</button>
    </div>`;
}

function contarPorStatus(status) {
  return osParaTab(status).length;
}

function renderTabs() {
  $("#tabs").innerHTML = STATUS_TABS.map(status => `
    <button class="tab ${status === abaAtiva ? "ativa" : ""}" data-tab="${status}">
      ${STATUS_LABEL[status] || status} <span class="count">${contarPorStatus(status)}</span>
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
  } else if (status === "Aguardando assinatura") {
    // Quem coleta a assinatura é quem executou; o colaborador vê só as
    // que ele concluiu. Gestor vê todas (ou só as dele em "Minhas O.S.").
    if (souColaboradorOuMinhas) rows = rows.filter(os => os.executado_por === perfil.id);
  } else if (status === "Concluída") {
    // Todos veem as concluídas da EQUIPE (transparência do tempo total).
    // O colaborador ainda com retenção de 7 dias pra não virar histórico
    // infinito; o gestor em "Minhas O.S." filtra pras dele.
    if (perfil.papel === "gestor" && viewMode === "minhas") {
      rows = rows.filter(os => os.executado_por === perfil.id || os.criada_por === perfil.id);
    }
    if (perfil.papel === "colaborador") {
      rows = rows.filter(os => os.concluida_em ? diasDesde(os.concluida_em) <= RETENCAO_DIAS : true);
    }
  } else if (status === "Cancelada") {
    // Canceladas seguem restritas: colaborador só vê as próprias (as que
    // executou/abriu), últimos 7 dias — não é foco de transparência.
    if (souColaboradorOuMinhas) {
      rows = rows.filter(os => os.executado_por === perfil.id || os.criada_por === perfil.id);
    }
    if (perfil.papel === "colaborador") {
      rows = rows.filter(os => os.cancelada_em ? diasDesde(os.cancelada_em) <= RETENCAO_DIAS : true);
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

  if (os.status === "Aguardando assinatura") {
    const ass = assinaturasPorOS.get(os.id) || {};
    // Inspetor: só quando há risco de contaminação, e no perfil do
    // colaborador que executou (é ele quem acompanha a inspeção).
    if (riscoPorOS.get(os.id) === true && souExecutor) {
      acoes += botao("assinar-inspetor", os.id, ass.inspetor ? "Inspetor ✓" : "Assinar inspetor", ass.inspetor ? "btn-ghost" : "btn-primary");
    }
    // Supervisor de Manutenção: só na tela do admin (gestor).
    if (souGestor) {
      acoes += botao("assinar-supervisor", os.id, ass.supervisor ? "Supervisor ✓" : "Assinar supervisor", ass.supervisor ? "btn-ghost" : "btn-primary");
      acoes += botao("cancelar", os.id, "Cancelar", "btn-danger");
    }
  }

  // Ver a assinatura já coletada (só gestor, nas concluídas)
  if (souGestor && os.status === "Concluída") acoes += botao("ver-assinatura", os.id, "Ver assinatura", "btn-ghost");

  // Gestor: detalhamento de tempo por pessoa em qualquer O.S. que já teve
  // trabalho (tudo menos "Aberta")
  if (souGestor && os.status !== "Aberta") acoes += botao("tempos", os.id, "Tempos", "btn-ghost");

  return `
    <div class="os-card ${slugPrio(os.prioridade)}">
      <div class="os-card-top">
        <div>
          <div class="os-numero">O.S. ${escapeHtml(osLabel(os))}</div>
          <div class="os-equip">${escapeHtml(equip)}</div>
          <div class="os-setor">${escapeHtml(os.setor_solicitante)} · ${escapeHtml(os.tipo_servico)}${os.tipo_manutencao ? " · " + escapeHtml(os.tipo_manutencao) : ""}</div>
        </div>
        <div class="tag-prio"><span class="led-prio"></span>${escapeHtml(os.prioridade)}</div>
      </div>
      <div class="os-desc">${escapeHtml(os.descricao)}</div>
      <div class="os-meta">
        <span>Aberta por ${escapeHtml(os.criador?.nome || "—")} em ${formatarDataCurta(os.criada_em)}</span>
        ${os.executor ? `<span>Executando: ${escapeHtml(os.executor.nome)}</span>` : ""}
        ${ajudantesHtml(os)}
        ${os.tag ? `<span>Tag: ${escapeHtml(os.tag)}</span>` : ""}
        ${os.chave ? `<span class="os-chave">🔑 ${escapeHtml(os.chave)}</span>` : ""}
        ${assinaturasHtml(os)}
        ${tempoOSHtml(os)}
        ${horaHomemHtml(os)}
      </div>
      ${acoes ? `<div class="os-actions">${acoes}</div>` : ""}
    </div>`;
}

function botao(action, osId, label, classe) {
  return `<button class="${classe}" data-action="${action}" data-os="${osId}">${label}</button>`;
}

// Identificador da O.S. no padrão da empresa (ex.: 07/26-P04). O.S. muito
// antigas, sem código, caem no #N interno como fallback.
function osLabel(os) {
  return os?.codigo || `#${os?.numero ?? ""}`;
}

// Nomes de quem está ajudando AGORA na O.S. (só faz sentido em andamento).
// Deixa o executor — e a equipe — ver quem entrou pra ajudar.
function ajudantesHtml(os) {
  if (os.status !== "Em andamento") return "";
  const nomes = ajudantesPorOS.get(os.id) || [];
  if (nomes.length === 0) return "";
  return `<span>Ajudando: ${nomes.map(escapeHtml).join(", ")}</span>`;
}

// Progresso das duas assinaturas (só na aba "Aguardando assinatura").
function assinaturasHtml(os) {
  if (os.status !== "Aguardando assinatura") return "";
  const ass = assinaturasPorOS.get(os.id) || {};
  const item = (rotulo, nome) => nome
    ? `${rotulo}: <span class="ass-ok">✓ ${escapeHtml(nome)}</span>`
    : `${rotulo}: <span class="ass-pend">pendente</span>`;
  const partes = [];
  // Inspetor aparece quando há risco; Supervisor só pro gestor.
  if (riscoPorOS.get(os.id) === true) partes.push(item("Inspetor", ass.inspetor));
  if (perfil.papel === "gestor") partes.push(item("Supervisor", ass.supervisor));
  return partes.length ? `<span>✍ ${partes.join(" · ")}</span>` : "";
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

  const trabalhoTerminou = os.status === "Concluída" || os.status === "Aguardando assinatura";
  const rotulo = trabalhoTerminou ? "Levou " : "";
  // spans em andamento carregam os dados pro contador subir sozinho (tickTempos)
  const t = temposOS.get(os.id);
  const dataAttrs = (os.status === "Em andamento" && t?.desde)
    ? ` data-fechados="${t.fechados}" data-desde="${t.desde}"`
    : "";
  return `<span class="os-tempo" data-os="${os.id}"${dataAttrs}>⏱ ${rotulo}${formatarDuracao(seg)} de trabalho</span>`;
}

// Hora-homem no card (só gestor): soma do esforço de todas as pessoas na
// O.S. Ajuda a bater o olho e ver quais O.S. puxaram mais gente sem abrir
// o modal. Enquanto o ⏱ (duração) mostra o relógio da O.S.
function horaHomemHtml(os) {
  if (perfil.papel !== "gestor" || os.status === "Aberta") return "";
  const seg = horaHomemOS.get(os.id);
  if (!seg) return "";
  return `<span class="os-homem">👥 ${formatarDuracao(seg)} hora-homem</span>`;
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
  if (action === "tempos") return abrirModalTempos(osId);
  if (action === "assinar-inspetor") return abrirModalAssinatura(osId, "inspetor");
  if (action === "assinar-supervisor") return abrirModalAssinatura(osId, "supervisor");
  if (action === "ver-assinatura") return abrirModalVerAssinatura(osId);
}

async function chamarRpc(nome, params, btnOrigem) {
  if (btnOrigem) { btnOrigem.disabled = true; }
  const { error } = await supabase.rpc(nome, params);
  if (error) { alert(error.message); if (btnOrigem) btnOrigem.disabled = false; return false; }
  await carregarOS(); await carregarAjudanteAtivo(); render();
  return true;
}

// Trava o botão de submit no primeiro envio, pra um duplo-clique não
// inserir a mesma coisa duas vezes (já causou O.S. e cadastros duplicados).
// Devolve { btn, ok }: ok=false quando já está enviando (aborta o handler).
function travarEnvio(e) {
  const btn = e.submitter || e.target.querySelector('button[type="submit"]');
  if (!btn) return { btn: null, ok: true };
  if (btn.dataset.enviando) return { btn, ok: false };
  btn.dataset.enviando = "1";
  btn.disabled = true;
  return { btn, ok: true };
}
function destravarEnvio(btn) {
  if (btn) { btn.disabled = false; delete btn.dataset.enviando; }
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
    const { btn: btnEnvio, ok } = travarEnvio(e);
    if (!ok) return; // já está inserindo — ignora clique repetido
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
    if (error) {
      $("#erro-nova-os").textContent = error.message; $("#erro-nova-os").style.display = "block";
      destravarEnvio(btnEnvio); return;
    }
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
        <div class="field"><label>Serviços realizados</label>
          <textarea id="f-servicos" rows="3" required placeholder="O que foi de fato executado no serviço"></textarea></div>

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

        <div class="field"><label>Há risco de contaminação?</label>
          <div class="radio-group">
            <label class="radio-option"><input type="radio" name="risco" value="nao" checked /> Não</label>
            <label class="radio-option"><input type="radio" name="risco" value="sim" /> Sim</label>
          </div>
        </div>
        <div class="field" id="wrap-contam" style="display:none">
          <label>Checklist de contaminação</label>
          <div class="check-group">
            <label class="check-option"><input type="checkbox" id="c-limpeza" /> Equipamento limpo</label>
            <label class="check-option"><input type="checkbox" id="c-area" /> Área limpa</label>
            <label class="check-option"><input type="checkbox" id="c-objetos" /> Sem objetos estranhos</label>
            <label class="check-option"><input type="checkbox" id="c-liberado" /> Equipamento liberado</label>
          </div>
        </div>

        <div class="field"><label>Observações (opcional)</label>
          <textarea id="f-observacoes" rows="2" placeholder="Observações adicionais"></textarea></div>

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
  document.querySelectorAll('input[name="risco"]').forEach(r => r.addEventListener("change", (e) => {
    $("#wrap-contam").style.display = e.target.value === "sim" ? "block" : "none";
  }));

  $("#form-concluir").addEventListener("submit", async (e) => {
    e.preventDefault();
    const eficiente = document.querySelector('input[name="eficiente"]:checked').value === "sim";
    const risco = document.querySelector('input[name="risco"]:checked').value === "sim";
    const erro = $("#erro-concluir");
    const servicos = $("#f-servicos").value.trim();
    if (!servicos) { erro.textContent = "Descreva os serviços realizados."; erro.style.display = "block"; return; }
    const { error } = await supabase.rpc("concluir_os", {
      p_os_id: osId,
      p_manutencao_eficiente: eficiente,
      p_acao: eficiente ? null : $("#f-acao").value,
      p_risco_contaminacao: risco,
      p_limpeza_equipamento: risco ? $("#c-limpeza").checked : null,
      p_area_limpa: risco ? $("#c-area").checked : null,
      p_ausencia_objetos_estranhos: risco ? $("#c-objetos").checked : null,
      p_equipamento_liberado: risco ? $("#c-liberado").checked : null,
      p_servicos_realizados: servicos,
      p_observacoes: $("#f-observacoes").value,
    });
    if (error) { erro.textContent = error.message; erro.style.display = "block"; return; }
    fecharModal();
    await Promise.all([carregarOS(), carregarTempos(), carregarAjudantesPorOS()]);
    abaAtiva = "Aguardando assinatura"; render();
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
        <div class="field"><label>Material utilizado</label>
          <input id="f-mat-nome" type="text" required placeholder="Ex.: 2 disjuntores 20A, 3 m de cabo 2,5mm" /></div>
        <p class="error-msg" id="erro-material" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Fechar</button>
          <button type="submit" class="btn-primary">Adicionar</button>
        </div>
      </form>
    </div>`);

  $("#form-material").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { btn: btnEnvio, ok } = travarEnvio(e);
    if (!ok) return;
    const { error } = await supabase.rpc("registrar_material", {
      p_os_id: osId, p_nome: $("#f-mat-nome").value,
    });
    if (error) {
      $("#erro-material").textContent = error.message; $("#erro-material").style.display = "block";
      destravarEnvio(btnEnvio); return;
    }
    fecharModal();
  });
}

// Gestor: detalhamento de tempo por pessoa (quem executou, quem ajudou,
// tempo de cada um) + tempo total da O.S. (relógio).
async function abrirModalTempos(osId) {
  const os = allOS.find(o => o.id === osId);
  const duracao = os ? formatarDuracao(segundosDaOS(os)) : "—";

  abrirModal(`
    <div class="modal">
      <h2>Tempos — O.S. ${escapeHtml(osLabel(os))}</h2>
      <div class="tempos-stats">
        <div class="stat-tile">
          <span>Duração</span><strong class="mono">${duracao}</strong>
          <small>relógio da O.S., sem pausas</small>
        </div>
        <div class="stat-tile">
          <span>Hora-homem</span><strong class="mono" id="stat-homem">—</strong>
          <small>soma do esforço de cada pessoa</small>
        </div>
      </div>
      <div id="tempos-lista"><p class="carregando">Carregando...</p></div>
      <p class="nota-horas">A hora-homem passa da duração quando executor e ajudante trabalham ao mesmo tempo — cada um conta o próprio esforço. Razão alta = O.S. que exigiu mais gente.</p>
      <div class="modal-actions"><button type="button" class="btn-secondary" data-fechar>Fechar</button></div>
    </div>`);

  const { data, error } = await supabase.rpc("tempos_por_os", { p_os_id: osId });
  const lista = $("#tempos-lista");
  if (error) { lista.innerHTML = `<p class="error-msg" style="display:block">${escapeHtml(error.message)}</p>`; return; }
  if (!data || data.length === 0) { lista.innerHTML = `<p class="vazio">Ninguém trabalhou nesta O.S. ainda.</p>`; return; }

  const totalHomem = data.reduce((soma, r) => soma + Number(r.segundos_trabalhados), 0);
  $("#stat-homem").textContent = formatarDuracao(totalHomem);

  lista.innerHTML = data.map(r => `
    <div class="detalhe-linha">
      <span class="detalhe-equip">${escapeHtml(r.nome)}</span>
      <span class="detalhe-tag">${escapeHtml(r.papeis)}</span>
      <strong class="mono">${formatarDuracao(Number(r.segundos_trabalhados))}</strong>
    </div>`).join("");
}

// Coleta de assinatura: canvas assinável (dedo no celular / mouse no PC).
// Ao confirmar, chama assinar_os, que grava a assinatura e move a O.S.
// de "Aguardando assinatura" para "Concluída".
function abrirModalAssinatura(osId, papel) {
  const os = allOS.find(o => o.id === osId);
  const titulo = papel === "inspetor" ? "Inspetor" : "Supervisor de Manutenção";
  abrirModal(`
    <div class="modal">
      <h2>Assinatura do ${titulo} — O.S. ${escapeHtml(osLabel(os))}</h2>
      <form id="form-assinatura">
        <div class="field"><label>Nome de quem está assinando</label>
          <input id="f-resp" type="text" required placeholder="Nome completo do ${titulo.toLowerCase()}" /></div>
        <div class="field">
          <label>Assinatura</label>
          <div class="sign-wrap">
            <canvas id="sign-canvas" class="sign-canvas"></canvas>
            <button type="button" class="btn-ghost sign-clear" id="btn-limpar-sign">Limpar</button>
          </div>
        </div>
        <p class="error-msg" id="erro-assinatura" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primary">Confirmar assinatura</button>
        </div>
      </form>
    </div>`);

  const canvas = $("#sign-canvas");
  const pad = criarSignaturePad(canvas);
  $("#btn-limpar-sign").addEventListener("click", () => pad.limpar());

  $("#form-assinatura").addEventListener("submit", async (e) => {
    e.preventDefault();
    const erro = $("#erro-assinatura");
    const nome = $("#f-resp").value.trim();
    if (!nome) { erro.textContent = "Informe o nome de quem está assinando."; erro.style.display = "block"; return; }
    if (pad.vazio()) { erro.textContent = "A assinatura está em branco."; erro.style.display = "block"; return; }

    const btn = e.submitter; if (btn) btn.disabled = true;
    const { error } = await supabase.rpc("assinar_os", {
      p_os_id: osId, p_papel: papel, p_nome_responsavel: nome, p_assinatura_png: pad.dataUrl(),
    });
    if (error) { erro.textContent = error.message; erro.style.display = "block"; if (btn) btn.disabled = false; return; }
    fecharModal();
    await Promise.all([carregarOS(), carregarTempos(), carregarAssinaturas()]);
    // se as duas foram coletadas, a O.S. já virou Concluída
    const atual = allOS.find(o => o.id === osId);
    if (atual && atual.status === "Concluída") abaAtiva = "Concluída";
    render();
  });
}

async function abrirModalVerAssinatura(osId) {
  const os = allOS.find(o => o.id === osId);
  abrirModal(`
    <div class="modal">
      <h2>Assinaturas — O.S. ${escapeHtml(osLabel(os))}</h2>
      <div id="ver-assinatura"><p class="carregando">Carregando...</p></div>
      <div class="modal-actions"><button type="button" class="btn-secondary" data-fechar>Fechar</button></div>
    </div>`);

  const { data, error } = await supabase
    .from("assinaturas")
    .select("papel, nome_responsavel, assinatura_png, coletado_em, coletor:perfis!assinaturas_coletado_por_fkey(nome)")
    .eq("os_id", osId)
    .order("coletado_em");

  const alvo = $("#ver-assinatura");
  if (error) { alvo.innerHTML = `<p class="error-msg" style="display:block">${escapeHtml(error.message)}</p>`; return; }
  if (!data || data.length === 0) { alvo.innerHTML = `<p class="vazio">Nenhuma assinatura registrada nesta O.S.</p>`; return; }

  const rotulo = (p) => p === "inspetor" ? "Inspetor" : p === "supervisor" ? "Supervisor de Manutenção" : "Responsável";
  alvo.innerHTML = data.map(a => `
    <div class="assinatura-bloco">
      <div class="assinatura-papel">${escapeHtml(rotulo(a.papel))}</div>
      <div class="assinatura-view">
        <img src="${a.assinatura_png}" alt="Assinatura de ${escapeHtml(a.nome_responsavel)}" />
      </div>
      <div class="os-meta" style="margin-top:8px">
        <span>${escapeHtml(a.nome_responsavel)}</span>
        <span>Coletada por ${escapeHtml(a.coletor?.nome || "—")} em ${formatarDataCurta(a.coletado_em)}</span>
      </div>
    </div>`).join("");
}

// Signature pad minimalista sobre <canvas>, com Pointer Events (funciona
// pra mouse e toque). Ajusta a resolução ao devicePixelRatio pra não
// ficar borrado, e trava o scroll da página durante o traço.
function criarSignaturePad(canvas) {
  const ctx = canvas.getContext("2d");
  let desenhando = false, temTraco = false, ultimo = null;

  function ajustarTamanho() {
    const ratio = window.devicePixelRatio || 1;
    const larguraCss = canvas.clientWidth || 400;
    const alturaCss = 160;
    canvas.width = larguraCss * ratio;
    canvas.height = alturaCss * ratio;
    canvas.style.height = alturaCss + "px";
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#12161F"; // traço escuro sobre fundo claro do canvas
  }
  // espera o layout do modal fechar pra medir a largura real
  requestAnimationFrame(ajustarTamanho);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inicio = (e) => { desenhando = true; ultimo = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); };
  const mover = (e) => {
    if (!desenhando) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(ultimo.x, ultimo.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ultimo = p; temTraco = true; e.preventDefault();
  };
  const fim = () => { desenhando = false; };

  canvas.addEventListener("pointerdown", inicio);
  canvas.addEventListener("pointermove", mover);
  canvas.addEventListener("pointerup", fim);
  canvas.addEventListener("pointercancel", fim);

  return {
    limpar() { ctx.clearRect(0, 0, canvas.width, canvas.height); temTraco = false; },
    vazio() { return !temTraco; },
    dataUrl() {
      // fundo branco pra assinatura não sair transparente no PNG
      const fundo = document.createElement("canvas");
      fundo.width = canvas.width; fundo.height = canvas.height;
      const fctx = fundo.getContext("2d");
      fctx.fillStyle = "#FFFFFF"; fctx.fillRect(0, 0, fundo.width, fundo.height);
      fctx.drawImage(canvas, 0, 0);
      return fundo.toDataURL("image/png");
    },
  };
}

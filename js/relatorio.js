import { supabase, exigirSessao, sair } from "./supabaseClient.js";
import { formatarDuracao, formatarDataCurta, slugPrio, escapeHtml } from "./utils.js";

const $ = (sel) => document.querySelector(sel);

let perfil = null;
let periodoAtivo = "semana-passada";
let janela = { de: null, ate: null }; // Date | null — null = sem limite
let linhas = [];

const PERIODOS = [
  { id: "semana", label: "Esta semana" },
  { id: "semana-passada", label: "Semana passada" },
  { id: "mes", label: "Este mês" },
  { id: "mes-passado", label: "Mês passado" },
  { id: "tudo", label: "Tudo" },
];

const PRIORIDADES = ["Emergencial", "Prioritária", "Normal"];

init();

async function init() {
  perfil = await exigirSessao();
  if (!perfil) return;
  // Relatório é do gestor. Colaborador é mandado de volta ao painel.
  if (perfil.papel !== "gestor") { window.location.href = "painel.html"; return; }

  $("#nome-usuario").textContent = perfil.nome;
  $("#btn-sair").addEventListener("click", sair);

  $("#periodos").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-periodo]");
    if (!btn) return;
    periodoAtivo = btn.dataset.periodo;
    janela = janelaDoPreset(periodoAtivo);
    sincronizarInputsData();
    carregar();
  });

  $("#form-periodo").addEventListener("submit", (e) => {
    e.preventDefault();
    const de = $("#f-de").value ? new Date($("#f-de").value + "T00:00:00") : null;
    const ate = $("#f-ate").value ? new Date($("#f-ate").value + "T00:00:00") : null;
    if (ate) ate.setDate(ate.getDate() + 1); // "até" inclusivo pro fim do dia
    if (de && ate && ate <= de) { alert('A data "até" precisa ser igual ou posterior à "de".'); return; }
    periodoAtivo = "custom";
    janela = { de, ate };
    carregar();
  });

  janela = janelaDoPreset(periodoAtivo);
  sincronizarInputsData();
  carregar();
}

// ---------------------------------------------------------------------
// Período (mesma lógica da tela de Horas, + "semana passada")
// ---------------------------------------------------------------------
function janelaDoPreset(id) {
  const agora = new Date();
  const inicioDoDia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const segundaDestaSemana = () => {
    const seg = inicioDoDia(agora);
    seg.setDate(seg.getDate() - ((agora.getDay() + 6) % 7));
    return seg;
  };

  if (id === "semana") return { de: segundaDestaSemana(), ate: null };
  if (id === "semana-passada") {
    const seg = segundaDestaSemana();
    const segAnterior = new Date(seg); segAnterior.setDate(seg.getDate() - 7);
    return { de: segAnterior, ate: seg };
  }
  if (id === "mes") return { de: new Date(agora.getFullYear(), agora.getMonth(), 1), ate: null };
  if (id === "mes-passado") {
    return {
      de: new Date(agora.getFullYear(), agora.getMonth() - 1, 1),
      ate: new Date(agora.getFullYear(), agora.getMonth(), 1),
    };
  }
  return { de: null, ate: null }; // tudo
}

function sincronizarInputsData() {
  const paraInput = (d) => (d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : "");
  $("#f-de").value = paraInput(janela.de);
  if (janela.ate) {
    const visivel = new Date(janela.ate); visivel.setDate(visivel.getDate() - 1);
    $("#f-ate").value = paraInput(visivel);
  } else {
    $("#f-ate").value = "";
  }
}

function renderPeriodos() {
  $("#periodos").innerHTML = PERIODOS.map(p => `
    <button class="tab ${p.id === periodoAtivo ? "ativa" : ""}" data-periodo="${p.id}">${p.label}</button>
  `).join("");
}

// ---------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------
async function carregar() {
  renderPeriodos();
  $("#conteudo-relatorio").innerHTML = `<p class="carregando">Calculando...</p>`;

  const { data, error } = await supabase.rpc("relatorio_os", {
    p_inicio: janela.de ? janela.de.toISOString() : null,
    p_fim: janela.ate ? janela.ate.toISOString() : null,
  });

  if (error) {
    $("#conteudo-relatorio").innerHTML = `
      <div class="empty-state"><div class="icon">⚠️</div>
        Não consegui carregar o relatório.<br />
        <span class="mono" style="font-size:12px">${escapeHtml(error.message)}</span>
      </div>`;
    return;
  }
  linhas = data || [];
  render();
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function render() {
  const el = $("#conteudo-relatorio");

  if (linhas.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">📋</div>Nenhuma atividade de O.S. neste período.</div>`;
    return;
  }

  const totalDuracao = linhas.reduce((s, l) => s + Number(l.segundos_duracao), 0);
  const totalHomem = linhas.reduce((s, l) => s + Number(l.segundos_homem), 0);
  const porPrioridade = PRIORIDADES.map(p => ({
    prioridade: p,
    qtd: linhas.filter(l => l.prioridade === p).length,
  }));

  el.innerHTML = `
    <div class="rel-resumo">
      <div class="stat-tile"><span>O.S. com atividade</span><strong class="mono">${linhas.length}</strong></div>
      <div class="stat-tile"><span>Duração total</span><strong class="mono" style="color:var(--cyan)">${formatarDuracao(totalDuracao)}</strong><small>relógio das O.S., sem pausas</small></div>
      <div class="stat-tile"><span>Hora-homem total</span><strong class="mono" style="color:var(--accent)">${formatarDuracao(totalHomem)}</strong><small>soma do esforço de todos</small></div>
    </div>

    <div class="rel-prioridades">
      ${porPrioridade.map(p => `
        <div class="prio-chip ${slugPrio(p.prioridade)}">
          <span class="led-prio"></span>
          <span class="prio-nome">${p.prioridade}</span>
          <strong>${p.qtd}</strong>
        </div>`).join("")}
    </div>

    <h3 style="margin:22px 0 10px">Histórico do período</h3>
    <div class="rel-tabela">
      <div class="rel-linha rel-cabecalho">
        <span>O.S.</span><span>Equipamento</span><span>Prioridade</span><span>Status</span>
        <span class="rel-num">Duração</span><span class="rel-num">Hora-homem</span>
      </div>
      ${linhas.map(linhaHtml).join("")}
    </div>
    <p class="nota-horas">Considera o esforço feito dentro do período: uma O.S. que atravessa a virada entra em cada período só com a parte trabalhada nele.</p>`;
}

function linhaHtml(l) {
  return `
    <div class="rel-linha">
      <span class="mono">#${l.numero}</span>
      <span>${escapeHtml(l.equipamento)}</span>
      <span class="rel-prio ${slugPrio(l.prioridade)}"><span class="led-prio"></span>${escapeHtml(l.prioridade)}</span>
      <span class="rel-status">${escapeHtml(l.status)}</span>
      <span class="rel-num mono" style="color:var(--cyan)">${formatarDuracao(Number(l.segundos_duracao))}</span>
      <span class="rel-num mono" style="color:var(--accent)">${formatarDuracao(Number(l.segundos_homem))}</span>
    </div>`;
}

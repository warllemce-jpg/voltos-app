import { supabase, exigirSessao, sair } from "./supabaseClient.js";
import { escapeHtml } from "./utils.js";

const $ = (sel) => document.querySelector(sel);

let perfil = null;
let periodoAtivo = "mes";
let janela = { de: null, ate: null };
let dados = null;

const PERIODOS = [
  { id: "semana", label: "Esta semana" },
  { id: "semana-passada", label: "Semana passada" },
  { id: "mes", label: "Este mês" },
  { id: "mes-passado", label: "Mês passado" },
  { id: "tudo", label: "Tudo" },
];

init();

async function init() {
  perfil = await exigirSessao();
  if (!perfil) return;
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
    if (ate) ate.setDate(ate.getDate() + 1);
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
// Período (mesma lógica das telas de Relatório/Horas)
// ---------------------------------------------------------------------
function janelaDoPreset(id) {
  const agora = new Date();
  const inicioDoDia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const segunda = () => {
    const seg = inicioDoDia(agora);
    seg.setDate(seg.getDate() - ((agora.getDay() + 6) % 7));
    return seg;
  };
  if (id === "semana") return { de: segunda(), ate: null };
  if (id === "semana-passada") {
    const s = segunda(), a = new Date(s); a.setDate(s.getDate() - 7);
    return { de: a, ate: s };
  }
  if (id === "mes") return { de: new Date(agora.getFullYear(), agora.getMonth(), 1), ate: null };
  if (id === "mes-passado") {
    return { de: new Date(agora.getFullYear(), agora.getMonth() - 1, 1), ate: new Date(agora.getFullYear(), agora.getMonth(), 1) };
  }
  return { de: null, ate: null };
}

function sincronizarInputsData() {
  const paraInput = (d) => (d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : "");
  $("#f-de").value = paraInput(janela.de);
  if (janela.ate) { const v = new Date(janela.ate); v.setDate(v.getDate() - 1); $("#f-ate").value = paraInput(v); }
  else $("#f-ate").value = "";
}

function renderPeriodos() {
  $("#periodos").innerHTML = PERIODOS.map(p => `
    <button class="tab ${p.id === periodoAtivo ? "ativa" : ""}" data-periodo="${p.id}">${p.label}</button>`).join("");
}

// ---------------------------------------------------------------------
// Formatação de duração amigável (min / h / d)
// ---------------------------------------------------------------------
function fmtDur(seg) {
  seg = Math.round(Number(seg) || 0);
  if (seg <= 0) return "—";
  if (seg < 3600) return `${Math.round(seg / 60)}min`;
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60);
  if (h < 24) return `${h}h${String(m).padStart(2, "0")}`;
  const d = Math.floor(h / 24), hr = h % 24;
  return `${d}d ${hr}h`;
}

// ---------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------
async function carregar() {
  renderPeriodos();
  $("#conteudo-indicadores").innerHTML = `<p class="carregando">Calculando...</p>`;

  const { data, error } = await supabase.rpc("indicadores", {
    p_inicio: janela.de ? janela.de.toISOString() : null,
    p_fim: janela.ate ? janela.ate.toISOString() : null,
  });

  if (error) {
    $("#conteudo-indicadores").innerHTML = `
      <div class="empty-state"><div class="icon">⚠️</div>Não consegui carregar os indicadores.<br />
        <span class="mono" style="font-size:12px">${escapeHtml(error.message)}</span></div>`;
    return;
  }
  dados = data || {};
  render();
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function render() {
  const d = dados;
  const mttr = d.mttr || {}, resp = d.resposta || {}, ef = d.eficiencia || {}, mix = d.mix_manutencao || {};
  const efPct = ef.total ? Math.round((ef.eficientes / ef.total) * 100) : null;
  const prev = mix.Preventiva || 0, corr = mix.Corretiva || 0, pred = mix.Preditiva || 0;

  $("#conteudo-indicadores").innerHTML = `
    <div class="ind-kpis">
      ${tile("MTTR", mttr.concluidas ? fmtDur(mttr.media_seg) : "—",
             `duração média · ${mttr.concluidas || 0} concluída(s)`, "cyan")}
      ${tile("Tempo de resposta", resp.iniciadas ? fmtDur(resp.media_seg) : "—",
             `abertura → início · ${resp.iniciadas || 0} O.S.`, "cyan")}
      ${tile("Manutenção eficiente", efPct === null ? "—" : efPct + "%",
             `${ef.eficientes || 0} de ${ef.total || 0} concluídas`, "verde")}
      ${tile("Preventiva ÷ Corretiva", corr ? (prev / corr).toFixed(2) : (prev ? "∞" : "—"),
             `${prev} prev. · ${corr} corr. · ${pred} pred.`, "accent")}
    </div>

    ${mixHtml(prev, corr, pred)}
    ${pausasHtml(d.pausas || [], d.acoes || {})}
    ${backlogHtml(d.backlog || {})}

    <p class="nota-horas">
      Períodos: MTTR e eficiência contam as O.S. <strong>concluídas</strong> no período; resposta, as
      <strong>iniciadas</strong>; mix, as <strong>abertas</strong>. Backlog é a foto de agora (não filtra período).
    </p>`;
}

function tile(titulo, valor, sub, cor) {
  return `
    <div class="stat-tile">
      <span>${escapeHtml(titulo)}</span>
      <strong class="mono" style="color:var(--${cor})">${escapeHtml(valor)}</strong>
      <small>${escapeHtml(sub)}</small>
    </div>`;
}

function mixHtml(prev, corr, pred) {
  const total = prev + corr + pred;
  if (total === 0) return "";
  const seg = (n, cls) => n ? `<span class="mix-seg ${cls}" style="flex:${n}" title="${n}"></span>` : "";
  return `
    <div class="ind-bloco">
      <h3>Tipo de manutenção (abertas no período)</h3>
      <div class="mix-bar">
        ${seg(prev, "mix-prev")}${seg(corr, "mix-corr")}${seg(pred, "mix-pred")}
      </div>
      <div class="mix-legenda">
        <span><i class="dot mix-prev"></i> Preventiva ${prev}</span>
        <span><i class="dot mix-corr"></i> Corretiva ${corr}</span>
        <span><i class="dot mix-pred"></i> Preditiva ${pred}</span>
      </div>
    </div>`;
}

function pausasHtml(pausas, acoes) {
  const acoesEntries = Object.entries(acoes);
  const acoesLinha = acoesEntries.length
    ? `<p class="ind-acoes">Quando não foi eficiente: ${acoesEntries.map(([a, n]) => `${escapeHtml(a)} (${n})`).join(" · ")}</p>`
    : "";

  if (pausas.length === 0) {
    return `<div class="ind-bloco"><h3>Motivos de pausa</h3><p class="vazio">Nenhuma pausa no período.</p>${acoesLinha}</div>`;
  }
  const maiorSeg = Math.max(...pausas.map(p => Number(p.seg)), 1);
  return `
    <div class="ind-bloco">
      <h3>Motivos de pausa (tempo perdido)</h3>
      ${pausas.map(p => {
        const largura = Math.round((Number(p.seg) / maiorSeg) * 100);
        return `
        <div class="pausa-linha">
          <div class="pausa-info">
            <div class="pausa-motivo">${escapeHtml(p.motivo)} <span class="pausa-qtd">${p.qtd}×</span></div>
            <div class="barra"><span style="width:${largura}%"></span></div>
          </div>
          <strong class="mono pausa-tempo">${fmtDur(p.seg)}</strong>
        </div>`;
      }).join("")}
      ${acoesLinha}
    </div>`;
}

function backlogHtml(b) {
  const faixas = b.faixas || {}, status = b.por_status || {};
  const emerg = b.emergenciais_paradas || 0;
  const statusChips = Object.entries(status).map(([s, n]) => `<span class="chip-status">${escapeHtml(s)} ${n}</span>`).join("");
  return `
    <div class="ind-bloco">
      <h3>Backlog agora <span class="ind-sub">(O.S. não concluídas)</span></h3>
      <div class="backlog-topo">
        <div class="backlog-total"><strong class="mono">${b.total || 0}</strong><span>em aberto</span></div>
        <div class="backlog-chips">${statusChips || '<span class="vazio">nada em aberto</span>'}</div>
      </div>
      ${b.total ? `
        <div class="backlog-faixas">
          <span class="faixa"><b>${faixas.ate_1d || 0}</b> &lt; 1 dia</span>
          <span class="faixa"><b>${faixas.d1_3 || 0}</b> 1–3 dias</span>
          <span class="faixa"><b>${faixas.d3_7 || 0}</b> 3–7 dias</span>
          <span class="faixa alerta"><b>${faixas.mais_7d || 0}</b> +7 dias</span>
          <span class="faixa">mais antiga: <b>${b.mais_antiga_dias || 0}d</b></span>
        </div>` : ""}
      ${emerg ? `<p class="backlog-emerg">🔴 ${emerg} O.S. emergencial(is) parada(s) esperando.</p>` : ""}
    </div>`;
}

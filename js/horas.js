import { supabase, exigirSessao, sair } from "./supabaseClient.js";
import { formatarDuracao, escapeHtml, osLabel } from "./utils.js";

const $ = (sel) => document.querySelector(sel);

let perfil = null;
let periodoAtivo = "mes";
let janela = { de: null, ate: null }; // Date | null — null = sem limite daquele lado
let linhas = [];
let expandido = null; // colaborador_id com o detalhe por O.S. aberto
let detalhe = [];     // resultado de horas_por_periodo_os do expandido

const PERIODOS = [
  { id: "semana", label: "Esta semana" },
  { id: "mes", label: "Este mês" },
  { id: "mes-passado", label: "Mês passado" },
  { id: "tudo", label: "Tudo" },
];

init();

async function init() {
  perfil = await exigirSessao();
  if (!perfil) return;

  $("#nome-usuario").textContent = perfil.nome;
  $("#btn-sair").addEventListener("click", sair);
  if (perfil.papel === "gestor") {
    $("#link-relatorio").style.display = "inline-block";
    $("#link-validacao").style.display = "inline-block";
    $("#link-indicadores").style.display = "inline-block";
  }
  if (perfil.papel !== "gestor") $("#titulo-horas").textContent = "Minhas horas";

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
    // "até" é inclusivo pro usuário: 31/07 significa até o fim do dia 31
    const ate = $("#f-ate").value ? new Date($("#f-ate").value + "T00:00:00") : null;
    if (ate) ate.setDate(ate.getDate() + 1);
    if (de && ate && ate <= de) {
      alert('A data "até" precisa ser igual ou posterior à data "de".');
      return;
    }
    periodoAtivo = "custom";
    janela = { de, ate };
    carregar();
  });

  $("#conteudo-horas").addEventListener("click", onConteudoClick);

  janela = janelaDoPreset(periodoAtivo);
  sincronizarInputsData();
  carregar(); // já renderiza os botões de período
}

// ---------------------------------------------------------------------
// Período
// ---------------------------------------------------------------------
function janelaDoPreset(id) {
  const agora = new Date();
  const inicioDoDia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (id === "semana") {
    // semana começando na segunda-feira
    const seg = inicioDoDia(agora);
    const diasDesdeSegunda = (agora.getDay() + 6) % 7;
    seg.setDate(seg.getDate() - diasDesdeSegunda);
    return { de: seg, ate: null };
  }
  if (id === "mes") {
    return { de: new Date(agora.getFullYear(), agora.getMonth(), 1), ate: null };
  }
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
  // o "ate" guardado é exclusivo (dia seguinte 00:00); mostra o dia anterior
  if (janela.ate) {
    const visivel = new Date(janela.ate);
    visivel.setDate(visivel.getDate() - 1);
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
  $("#conteudo-horas").innerHTML = `<p class="carregando">Calculando...</p>`;
  expandido = null;
  detalhe = [];

  const { data, error } = await supabase.rpc("horas_por_periodo", {
    p_inicio: janela.de ? janela.de.toISOString() : null,
    p_fim: janela.ate ? janela.ate.toISOString() : null,
  });

  if (error) {
    $("#conteudo-horas").innerHTML = `
      <div class="empty-state">
        <div class="icon">⚠️</div>
        Não consegui carregar as horas.<br />
        <span class="mono" style="font-size:12px">${escapeHtml(error.message)}</span>
      </div>`;
    return;
  }

  linhas = data || [];
  // colaborador só vê as próprias horas
  if (perfil.papel !== "gestor") linhas = linhas.filter(l => l.colaborador_id === perfil.id);
  render();
}

async function carregarDetalhe(colaboradorId) {
  const { data, error } = await supabase.rpc("horas_por_periodo_os", {
    p_colaborador_id: colaboradorId,
    p_inicio: janela.de ? janela.de.toISOString() : null,
    p_fim: janela.ate ? janela.ate.toISOString() : null,
  });
  if (error) { alert(error.message); return; }
  detalhe = data || [];
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function render() {
  const el = $("#conteudo-horas");

  if (linhas.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">⏱️</div>Nenhuma hora registrada neste período.</div>`;
    return;
  }

  const total = linhas.reduce((soma, l) => soma + Number(l.segundos_trabalhados), 0);
  const maior = Math.max(...linhas.map(l => Number(l.segundos_trabalhados)), 1);

  el.innerHTML = `
    <div class="horas-total">
      <span>${perfil.papel === "gestor" ? "Total da equipe" : "Seu total"} — ${escapeHtml(rotuloPeriodo())}</span>
      <strong class="mono">${formatarDuracao(total)}</strong>
    </div>
    ${linhas.map(l => linhaHtml(l, maior)).join("")}
    <p class="nota-horas">
      O.S. em andamento entram com o tempo corrido até agora. Recarregue para atualizar.
    </p>`;
}

function linhaHtml(l, maior) {
  const segundos = Number(l.segundos_trabalhados);
  const largura = Math.round((segundos / maior) * 100);
  const aberto = expandido === l.colaborador_id;

  return `
    <div class="horas-card ${aberto ? "aberto" : ""}">
      <button class="horas-row" data-colab="${l.colaborador_id}">
        <div class="horas-info">
          <div class="horas-nome">
            ${escapeHtml(l.nome)}
            ${l.papel === "gestor" ? `<span class="chip-papel gestor">Gestor</span>` : ""}
            ${l.ativo ? "" : `<span class="chip-papel">Inativo</span>`}
          </div>
          <div class="barra"><span style="width:${largura}%"></span></div>
        </div>
        <div class="horas-valor">
          <strong class="mono">${formatarDuracao(segundos)}</strong>
          <span>${l.os_distintas} O.S.</span>
        </div>
      </button>
      ${aberto ? detalheHtml() : ""}
    </div>`;
}

function detalheHtml() {
  if (detalhe.length === 0) {
    return `<div class="horas-detalhe"><p class="vazio">Nenhuma O.S. neste período.</p></div>`;
  }
  return `
    <div class="horas-detalhe">
      ${detalhe.map(d => `
        <div class="detalhe-linha">
          <span class="mono">${escapeHtml(osLabel(d))}</span>
          <span class="detalhe-equip">${escapeHtml(d.equipamento)}</span>
          <span class="detalhe-tag">${escapeHtml(d.papel)} · ${escapeHtml(d.status)}</span>
          <strong class="mono">${formatarDuracao(Number(d.segundos_trabalhados))}</strong>
        </div>`).join("")}
    </div>`;
}

function rotuloPeriodo() {
  const preset = PERIODOS.find(p => p.id === periodoAtivo);
  if (preset) return preset.label.toLowerCase();
  const fmt = (d) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const ateVisivel = janela.ate ? new Date(janela.ate.getTime() - 1) : null;
  if (janela.de && ateVisivel) return `${fmt(janela.de)} a ${fmt(ateVisivel)}`;
  if (janela.de) return `desde ${fmt(janela.de)}`;
  if (ateVisivel) return `até ${fmt(ateVisivel)}`;
  return "tudo";
}

async function onConteudoClick(e) {
  const btn = e.target.closest("[data-colab]");
  if (!btn) return;
  const id = btn.dataset.colab;

  if (expandido === id) { expandido = null; detalhe = []; render(); return; }

  expandido = id;
  detalhe = [];
  await carregarDetalhe(id);
  if (expandido === id) render();
}

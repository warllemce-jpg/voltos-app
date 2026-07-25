import { supabase, exigirSessao, sair } from "./supabaseClient.js";
import { escapeHtml } from "./utils.js";

const $ = (sel) => document.querySelector(sel);

let perfil = null;
let modo = "pendentes"; // 'pendentes' | 'validadas'
let linhas = [];
let eventosPorOS = new Map(); // os_id -> [{evento, hora, editado}]

init();

async function init() {
  perfil = await exigirSessao();
  if (!perfil) return;
  // A planilha de validação vive no perfil do admin.
  if (perfil.papel !== "gestor") { window.location.href = "painel.html"; return; }

  $("#nome-usuario").textContent = perfil.nome;
  $("#btn-sair").addEventListener("click", sair);

  $("#tabs-val").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-modo]");
    if (!btn) return;
    modo = btn.dataset.modo;
    document.querySelectorAll("#tabs-val .tab").forEach(t => t.classList.toggle("ativa", t.dataset.modo === modo));
    carregar();
  });

  $("#lista-validacao").addEventListener("click", onListaClick);

  carregar();

  // Auto-refresh de 30s. Não recarrega enquanto alguém digita num input.
  setInterval(() => {
    const editando = document.activeElement && document.activeElement.classList?.contains("val-input");
    if (!editando) carregar();
  }, 30000);
}

async function carregar() {
  const el = $("#lista-validacao");
  if (linhas.length === 0) el.innerHTML = `<p class="carregando">Carregando...</p>`;

  const { data, error } = await supabase
    .from("ordens_servico")
    .select("id, codigo, numero, setor_solicitante, status, chave, equipamentos(nome), equipamento_outro")
    .neq("status", "Cancelada")
    .order("codigo");

  if (error) {
    el.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>Não consegui carregar.<br />
      <span class="mono" style="font-size:12px">${escapeHtml(error.message)}</span></div>`;
    return;
  }

  const todas = data || [];
  linhas = modo === "pendentes" ? todas.filter(o => !o.chave) : todas.filter(o => o.chave);

  // Linha do tempo (início/pausa/retorno/finalização) das O.S. exibidas
  eventosPorOS = new Map();
  const ids = linhas.map(o => o.id);
  if (ids.length) {
    const { data: evs } = await supabase.rpc("eventos_os", { p_os_ids: ids });
    (evs || []).forEach(e => {
      if (!eventosPorOS.has(e.os_id)) eventosPorOS.set(e.os_id, []);
      eventosPorOS.get(e.os_id).push(e);
    });
  }

  render();
}

function render() {
  const el = $("#lista-validacao");

  if (linhas.length === 0) {
    const msg = modo === "pendentes"
      ? "Nenhuma O.S. pendente de chave. 🎉"
      : "Nenhuma O.S. com chave ainda.";
    el.innerHTML = `<div class="empty-state"><div class="icon">🔑</div>${msg}</div>`;
    return;
  }

  el.innerHTML = linhas.map(cardHtml).join("");
}

function cardHtml(os) {
  const equip = os.equipamentos?.nome || os.equipamento_outro || "—";
  const rotuloBtn = os.chave ? "Atualizar" : "Salvar";
  return `
    <div class="val-card" data-os="${os.id}">
      <div class="val-head">
        <div class="val-id">
          <span class="mono val-codigo">${escapeHtml(os.codigo || "#" + os.numero)}</span>
          <span class="val-equip">${escapeHtml(equip)}</span>
          <span class="val-status">${escapeHtml(os.status)}</span>
        </div>
        <div class="val-acao">
          <input class="val-input" type="text" inputmode="numeric" pattern="\\d*" maxlength="20"
                 value="${escapeHtml(os.chave || "")}" placeholder="chave (mín. 10 díg.)" />
          <button class="btn-primary val-salvar" data-os="${os.id}">${rotuloBtn}</button>
        </div>
      </div>
      <p class="error-msg val-erro" data-erro="${os.id}" style="display:none"></p>
      ${timelineHtml(os.id)}
    </div>`;
}

function timelineHtml(osId) {
  const evs = eventosPorOS.get(osId) || [];
  if (evs.length === 0) {
    return `<div class="val-timeline"><span class="tl-vazio">Ainda não iniciada.</span></div>`;
  }
  return `
    <div class="val-timeline">
      ${evs.map(e => `
        <div class="tl-linha">
          <span class="tl-evento">${escapeHtml(e.evento)}</span>
          <span class="tl-hora mono">${fmtDataHora(e.hora)}${e.editado ? ` <span class="tl-edit">(ajustado)</span>` : ""}</span>
        </div>`).join("")}
    </div>`;
}

function fmtDataHora(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

async function onListaClick(e) {
  const btn = e.target.closest(".val-salvar");
  if (!btn) return;
  const osId = btn.dataset.os;
  const card = btn.closest(".val-card");
  const input = card.querySelector(".val-input");
  const erro = card.querySelector(`[data-erro="${osId}"]`);
  const chave = input.value.trim();

  erro.style.display = "none";
  if (!/^\d{10,}$/.test(chave)) {
    erro.textContent = "A chave deve ter só números, no mínimo 10 dígitos.";
    erro.style.display = "block";
    return;
  }

  btn.disabled = true;
  const { error } = await supabase.rpc("definir_chave", { p_os_id: osId, p_chave: chave });
  if (error) {
    erro.textContent = error.message;
    erro.style.display = "block";
    btn.disabled = false;
    return;
  }
  await carregar();
}

import { supabase, exigirSessao, sair } from "./supabaseClient.js";
import { escapeHtml } from "./utils.js";

const $ = (sel) => document.querySelector(sel);
let perfil = null;
let abaAtiva = "colaboradores";

init();

async function init() {
  perfil = await exigirSessao();
  if (!perfil) return;
  if (perfil.papel !== "gestor") { window.location.href = "painel.html"; return; }

  $("#nome-usuario").textContent = perfil.nome;
  $("#btn-sair").addEventListener("click", sair);

  document.querySelectorAll("#tabs-admin [data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      abaAtiva = btn.dataset.tab;
      document.querySelectorAll("#tabs-admin .tab").forEach(t => t.classList.toggle("ativa", t.dataset.tab === abaAtiva));
      renderAba();
    });
  });

  renderAba();
}

function renderAba() {
  if (abaAtiva === "colaboradores") return renderColaboradores();
  if (abaAtiva === "equipamentos") return renderEquipamentos();
  if (abaAtiva === "motivos") return renderMotivos();
}

// ---------------------------------------------------------------------
// COLABORADORES
// ---------------------------------------------------------------------
async function renderColaboradores() {
  const el = $("#conteudo-admin");
  el.innerHTML = `<p>Carregando...</p>`;

  const { data: colaboradores } = await supabase.from("perfis").select("*").order("nome");

  el.innerHTML = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:14px;">
      <button class="btn-primary" id="btn-novo-colab">+ Novo colaborador</button>
    </div>
    ${(colaboradores || []).map(c => `
      <div class="os-card" style="--led:${c.ativo ? "#3DDC84" : "#FF5A5F"}">
        <div class="os-card-top">
          <div>
            <div class="os-equip">${escapeHtml(c.nome)}</div>
            <div class="os-setor">usuário: ${escapeHtml(c.login_id)} · ${c.papel}${c.turno ? " · " + c.turno : ""} ${c.ativo ? "" : "· INATIVO"}</div>
          </div>
        </div>
        <div class="os-actions">
          <button class="btn-secondary" data-action="resetar-pin" data-id="${c.id}" data-nome="${escapeHtml(c.nome)}">Resetar PIN</button>
          <button class="btn-secondary" data-action="toggle-ativo" data-id="${c.id}" data-ativo="${c.ativo}">${c.ativo ? "Desativar" : "Reativar"}</button>
        </div>
      </div>
    `).join("") || `<div class="empty-state">Nenhum colaborador cadastrado ainda.</div>`}
  `;

  $("#btn-novo-colab").addEventListener("click", abrirModalNovoColaborador);

  el.querySelectorAll('[data-action="resetar-pin"]').forEach(b => b.addEventListener("click", () =>
    abrirModalResetarPin(b.dataset.id, b.dataset.nome)));

  el.querySelectorAll('[data-action="toggle-ativo"]').forEach(b => b.addEventListener("click", async () => {
    const novoValor = b.dataset.ativo !== "true";
    await supabase.from("perfis").update({ ativo: novoValor }).eq("id", b.dataset.id);
    renderColaboradores();
  }));
}

function abrirModal(html) {
  $("#modal-slot").innerHTML = `<div class="modal-overlay" id="overlay">${html}</div>`;
  $("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") fecharModal(); });
  document.querySelectorAll("[data-fechar]").forEach(b => b.addEventListener("click", fecharModal));
}
function fecharModal() { $("#modal-slot").innerHTML = ""; }

function abrirModalNovoColaborador() {
  abrirModal(`
    <div class="modal">
      <h2>Novo colaborador</h2>
      <form id="form-novo-colab">
        <div class="field"><label>Nome completo</label><input id="f-nome" type="text" required /></div>
        <div class="field"><label>PIN (4 dígitos)</label>
          <input id="f-pin" class="pin-input" type="text" inputmode="numeric" pattern="\\d{4}" maxlength="4" required /></div>
        <div class="field"><label>Papel</label>
          <select id="f-papel"><option value="colaborador">Colaborador</option><option value="gestor">Gestor</option></select></div>
        <div class="field"><label>Turno (opcional)</label>
          <select id="f-turno">
            <option value="">—</option>
            <option value="07h-17h">07h–17h</option>
            <option value="13h-23h">13h–23h</option>
            <option value="21h-07h">21h–07h</option>
          </select></div>
        <p class="error-msg" id="erro-colab" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primary">Cadastrar</button>
        </div>
      </form>
    </div>`);

  $("#form-novo-colab").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.functions.invoke("create-colaborador", {
      body: {
        nome: $("#f-nome").value,
        pin: $("#f-pin").value,
        papel: $("#f-papel").value,
        turno: $("#f-turno").value || null,
      },
    });
    if (error || data?.error) {
      $("#erro-colab").textContent = data?.error || error.message;
      $("#erro-colab").style.display = "block";
      return;
    }
    fecharModal();
    alert(`Colaborador cadastrado! Usuário de login: ${data.login_id}`);
    renderColaboradores();
  });
}

function abrirModalResetarPin(colaboradorId, nome) {
  abrirModal(`
    <div class="modal">
      <h2>Resetar PIN — ${escapeHtml(nome)}</h2>
      <form id="form-reset-pin">
        <div class="field"><label>Novo PIN (4 dígitos)</label>
          <input id="f-novo-pin" class="pin-input" type="text" inputmode="numeric" pattern="\\d{4}" maxlength="4" required /></div>
        <p class="error-msg" id="erro-reset" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primary">Salvar novo PIN</button>
        </div>
      </form>
    </div>`);

  $("#form-reset-pin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.functions.invoke("reset-pin", {
      body: { colaborador_id: colaboradorId, novo_pin: $("#f-novo-pin").value },
    });
    if (error || data?.error) {
      $("#erro-reset").textContent = data?.error || error.message;
      $("#erro-reset").style.display = "block";
      return;
    }
    fecharModal();
    alert("PIN atualizado com sucesso.");
  });
}

// ---------------------------------------------------------------------
// EQUIPAMENTOS
// ---------------------------------------------------------------------
async function renderEquipamentos() {
  const el = $("#conteudo-admin");
  const { data: equipamentos } = await supabase.from("equipamentos").select("*").order("nome");

  el.innerHTML = `
    <form id="form-novo-equip" style="display:flex; gap:10px; margin-bottom:16px;">
      <input id="f-equip-nome" type="text" placeholder="Nome do equipamento" required style="flex:1" />
      <button type="submit" class="btn-primary">Adicionar</button>
    </form>
    ${(equipamentos || []).map(eq => `
      <div class="os-card" style="--led:${eq.ativo ? "#3DDC84" : "#FF5A5F"}">
        <div class="os-card-top">
          <div class="os-equip">${escapeHtml(eq.nome)}</div>
          <button class="btn-ghost" data-id="${eq.id}" data-ativo="${eq.ativo}" data-action="toggle-equip">
            ${eq.ativo ? "Desativar" : "Reativar"}
          </button>
        </div>
      </div>
    `).join("") || `<div class="empty-state">Nenhum equipamento cadastrado.</div>`}
  `;

  $("#form-novo-equip").addEventListener("submit", async (e) => {
    e.preventDefault();
    await supabase.from("equipamentos").insert({ nome: $("#f-equip-nome").value });
    renderEquipamentos();
  });

  el.querySelectorAll('[data-action="toggle-equip"]').forEach(b => b.addEventListener("click", async () => {
    await supabase.from("equipamentos").update({ ativo: b.dataset.ativo !== "true" }).eq("id", b.dataset.id);
    renderEquipamentos();
  }));
}

// ---------------------------------------------------------------------
// MOTIVOS (pausa + emergência)
// ---------------------------------------------------------------------
async function renderMotivos() {
  const el = $("#conteudo-admin");
  const [{ data: mp }, { data: me }] = await Promise.all([
    supabase.from("motivos_pausa").select("*").order("ordem"),
    supabase.from("motivos_emergencia").select("*").order("ordem"),
  ]);

  const listaMotivos = (lista, tabela) => (lista || []).map(m => `
    <div class="os-card" style="--led:${m.ativo ? "#3DDC84" : "#FF5A5F"}">
      <div class="os-card-top">
        <div class="os-equip">${escapeHtml(m.descricao)} ${m.sistema ? " <span style='color:var(--text-dim);font-size:12px'>(automático)</span>" : ""}</div>
        ${!m.sistema ? `<button class="btn-ghost" data-id="${m.id}" data-tabela="${tabela}" data-ativo="${m.ativo}" data-action="toggle-motivo">${m.ativo ? "Desativar" : "Reativar"}</button>` : ""}
      </div>
    </div>`).join("");

  el.innerHTML = `
    <h3>Motivos de pausa</h3>
    <form id="form-novo-mp" style="display:flex; gap:10px; margin-bottom:16px;">
      <input id="f-mp-nome" type="text" placeholder="Novo motivo de pausa" required style="flex:1" />
      <button type="submit" class="btn-primary">Adicionar</button>
    </form>
    ${listaMotivos(mp, "motivos_pausa")}

    <h3 style="margin-top:28px">Motivos de emergência</h3>
    <form id="form-novo-me" style="display:flex; gap:10px; margin-bottom:16px;">
      <input id="f-me-nome" type="text" placeholder="Novo motivo de emergência" required style="flex:1" />
      <button type="submit" class="btn-primary">Adicionar</button>
    </form>
    ${listaMotivos(me, "motivos_emergencia")}
  `;

  $("#form-novo-mp").addEventListener("submit", async (e) => {
    e.preventDefault();
    await supabase.from("motivos_pausa").insert({ descricao: $("#f-mp-nome").value, ordem: 50 });
    renderMotivos();
  });
  $("#form-novo-me").addEventListener("submit", async (e) => {
    e.preventDefault();
    await supabase.from("motivos_emergencia").insert({ descricao: $("#f-me-nome").value, ordem: 50 });
    renderMotivos();
  });

  el.querySelectorAll('[data-action="toggle-motivo"]').forEach(b => b.addEventListener("click", async () => {
    await supabase.from(b.dataset.tabela).update({ ativo: b.dataset.ativo !== "true" }).eq("id", b.dataset.id);
    renderMotivos();
  }));
}

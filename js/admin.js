import { supabase, exigirSessao, sair } from "./supabaseClient.js";
import { escapeHtml } from "./utils.js";

const $ = (sel) => document.querySelector(sel);
let perfil = null;
let abaAtiva = "colaboradores";

// Nome repetido agora é barrado pelo banco (índice único sobre
// lower(trim(...)) — ver 06_dedupe_unicidade.sql). Sem tratar o erro, o
// formulário simplesmente não fazia nada e parecia travado.
function mensagemDeErro(error) {
  if (!error) return null;
  if (error.code === "23505") {
    const alvo = (error.message || "") + (error.details || "");
    if (alvo.includes("uniq_equipamentos_tag")) return "Já existe um equipamento com essa TAG.";
    return "Já existe um item com esse nome.";
  }
  if (error.code === "23514") return "Valor inválido (verifique o formato da TAG: 0000-00 ou 00000-00).";
  return error.message;
}

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
          <button class="btn-secondary" data-action="editar-colab" data-id="${c.id}">Editar</button>
          <button class="btn-secondary" data-action="resetar-pin" data-id="${c.id}" data-nome="${escapeHtml(c.nome)}">Resetar PIN</button>
          <button class="btn-secondary" data-action="toggle-ativo" data-id="${c.id}" data-ativo="${c.ativo}">${c.ativo ? "Desativar" : "Reativar"}</button>
        </div>
      </div>
    `).join("") || `<div class="empty-state">Nenhum colaborador cadastrado ainda.</div>`}
  `;

  $("#btn-novo-colab").addEventListener("click", abrirModalNovoColaborador);

  el.querySelectorAll('[data-action="editar-colab"]').forEach(b => b.addEventListener("click", () =>
    abrirModalEditarColaborador((colaboradores || []).find(c => c.id === b.dataset.id))));

  el.querySelectorAll('[data-action="resetar-pin"]').forEach(b => b.addEventListener("click", () =>
    abrirModalResetarPin(b.dataset.id, b.dataset.nome)));

  el.querySelectorAll('[data-action="toggle-ativo"]').forEach(b => b.addEventListener("click", async () => {
    const novoValor = b.dataset.ativo !== "true";
    await supabase.from("perfis").update({ ativo: novoValor }).eq("id", b.dataset.id);
    renderColaboradores();
  }));
}

function abrirModalEditarColaborador(c) {
  if (!c) return;
  const turnos = ["", "07h-17h", "13h-23h", "21h-07h"];
  const opTurno = turnos.map(t => `<option value="${t}" ${c.turno === t || (!c.turno && t === "") ? "selected" : ""}>${t || "—"}</option>`).join("");
  abrirModal(`
    <div class="modal">
      <h2>Editar colaborador</h2>
      <form id="form-editar-colab">
        <div class="field"><label>Nome completo</label>
          <input id="f-ed-nome" type="text" required value="${escapeHtml(c.nome).replaceAll('"', "&quot;")}" /></div>
        <div class="field"><label>Papel</label>
          <select id="f-ed-papel">
            <option value="colaborador" ${c.papel === "colaborador" ? "selected" : ""}>Colaborador</option>
            <option value="gestor" ${c.papel === "gestor" ? "selected" : ""}>Gestor</option>
          </select></div>
        <div class="field"><label>Especialidade (opcional)</label>
          <select id="f-ed-especialidade">
            <option value="" ${!c.especialidade ? "selected" : ""}>—</option>
            <option value="Mecânica" ${c.especialidade === "Mecânica" ? "selected" : ""}>Mecânica</option>
            <option value="Elétrica" ${c.especialidade === "Elétrica" ? "selected" : ""}>Elétrica</option>
          </select></div>
        <div class="field"><label>Turno (opcional)</label>
          <select id="f-ed-turno">${opTurno}</select></div>
        <p style="color:var(--text-dim); font-size:12px; margin:-4px 0 8px">
          O usuário de login (<b>${escapeHtml(c.login_id)}</b>) não muda ao editar o nome.</p>
        <p class="error-msg" id="erro-ed-colab" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primary">Salvar</button>
        </div>
      </form>
      <hr style="border:none; border-top:1px solid var(--border); margin:18px 0 14px" />
      <button type="button" id="btn-apagar-colab" class="btn-danger">Apagar cadastro</button>
      <div id="confirma-apagar" style="display:none; margin-top:12px">
        <p style="font-size:13px; margin-bottom:10px">Apagar <b>${escapeHtml(c.nome)}</b> definitivamente?
          Só é possível se não houver O.S. no histórico — caso contrário, use <b>Desativar</b>.</p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-cancel-apagar>Voltar</button>
          <button type="button" id="btn-apagar-sim" class="btn-danger">Sim, apagar</button>
        </div>
      </div>
    </div>`);

  $("#form-editar-colab").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await supabase.from("perfis").update({
      nome: $("#f-ed-nome").value.trim(),
      papel: $("#f-ed-papel").value,
      turno: $("#f-ed-turno").value || null,
      especialidade: $("#f-ed-especialidade").value || null,
    }).eq("id", c.id);
    const msg = mensagemDeErro(error);
    if (msg) { $("#erro-ed-colab").textContent = msg; $("#erro-ed-colab").style.display = "block"; return; }
    fecharModal();
    renderColaboradores();
  });

  $("#btn-apagar-colab").addEventListener("click", () => {
    $("#btn-apagar-colab").style.display = "none";
    $("#confirma-apagar").style.display = "block";
  });
  $("[data-cancel-apagar]").addEventListener("click", () => {
    $("#confirma-apagar").style.display = "none";
    $("#btn-apagar-colab").style.display = "inline-flex";
  });
  $("#btn-apagar-sim").addEventListener("click", async () => {
    const btn = $("#btn-apagar-sim"); btn.disabled = true; btn.textContent = "Apagando...";
    const { data, error } = await supabase.functions.invoke("delete-colaborador", {
      body: { colaborador_id: c.id },
    });
    if (error || data?.error) {
      $("#erro-ed-colab").textContent = data?.error || error.message;
      $("#erro-ed-colab").style.display = "block";
      btn.disabled = false; btn.textContent = "Sim, apagar";
      return;
    }
    fecharModal();
    renderColaboradores();
  });
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
        <div class="field"><label>PIN (6 dígitos)</label>
          <input id="f-pin" class="pin-input" type="text" inputmode="numeric" pattern="\\d{6}" maxlength="6" required /></div>
        <div class="field"><label>Papel</label>
          <select id="f-papel"><option value="colaborador">Colaborador</option><option value="gestor">Gestor</option></select></div>
        <div class="field"><label>Especialidade (opcional)</label>
          <select id="f-especialidade">
            <option value="">—</option>
            <option value="Mecânica">Mecânica</option>
            <option value="Elétrica">Elétrica</option>
          </select>
          <p style="color:var(--text-dim); font-size:12px; margin:4px 0 0">Só serve de sugestão automática ao abrir uma O.S.; o colaborador pode trocar na hora.</p></div>
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
        especialidade: $("#f-especialidade").value || null,
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
        <div class="field"><label>Novo PIN (6 dígitos)</label>
          <input id="f-novo-pin" class="pin-input" type="text" inputmode="numeric" pattern="\\d{6}" maxlength="6" required /></div>
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
const TAG_RE = /^\d{4,5}-\d{2}$/; // ativo: 0000-00 ou 00000-00
const attrEsc = (v) => escapeHtml(v || "").replaceAll('"', "&quot;");

async function renderEquipamentos() {
  const el = $("#conteudo-admin");
  const { data: equipamentos } = await supabase.from("equipamentos").select("*").order("nome");

  el.innerHTML = `
    <form id="form-novo-equip" style="display:flex; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
      <input id="f-equip-nome" type="text" placeholder="Nome do equipamento" required style="flex:2; min-width:180px" />
      <input id="f-equip-tag" type="text" placeholder="TAG / ativo (ex: 1234-56)" inputmode="numeric" style="flex:1; min-width:140px" />
      <button type="submit" class="btn-primary">Adicionar</button>
    </form>
    <p class="error-msg" id="erro-equip" style="display:none; text-align:left; margin-bottom:16px"></p>
    ${(equipamentos || []).map(eq => `
      <div class="os-card" style="--led:${eq.ativo ? "#3DDC84" : "#FF5A5F"}">
        <div class="os-card-top">
          <div>
            <div class="os-equip">${escapeHtml(eq.nome)}</div>
            <div class="os-setor">${eq.tag ? "🏷️ " + escapeHtml(eq.tag) : "<span style='color:var(--text-dim)'>sem TAG</span>"}${eq.ativo ? "" : " · INATIVO"}</div>
          </div>
          <div class="os-actions" style="margin:0">
            <button class="btn-secondary" data-action="editar-equip" data-id="${eq.id}">Editar</button>
            <button class="btn-ghost" data-id="${eq.id}" data-ativo="${eq.ativo}" data-action="toggle-equip">
              ${eq.ativo ? "Desativar" : "Reativar"}
            </button>
          </div>
        </div>
      </div>
    `).join("") || `<div class="empty-state">Nenhum equipamento cadastrado.</div>`}
  `;

  $("#form-novo-equip").addEventListener("submit", async (e) => {
    e.preventDefault();
    const tag = $("#f-equip-tag").value.trim();
    if (tag && !TAG_RE.test(tag)) {
      $("#erro-equip").textContent = "TAG inválida. Use o formato 0000-00 ou 00000-00.";
      $("#erro-equip").style.display = "block"; return;
    }
    const { error } = await supabase.from("equipamentos").insert({ nome: $("#f-equip-nome").value.trim(), tag: tag || null });
    const msg = mensagemDeErro(error);
    if (msg) { $("#erro-equip").textContent = msg; $("#erro-equip").style.display = "block"; return; }
    renderEquipamentos();
  });

  el.querySelectorAll('[data-action="editar-equip"]').forEach(b => b.addEventListener("click", () =>
    abrirModalEditarEquipamento((equipamentos || []).find(eq => eq.id === b.dataset.id))));

  el.querySelectorAll('[data-action="toggle-equip"]').forEach(b => b.addEventListener("click", async () => {
    await supabase.from("equipamentos").update({ ativo: b.dataset.ativo !== "true" }).eq("id", b.dataset.id);
    renderEquipamentos();
  }));
}

function abrirModalEditarEquipamento(eq) {
  if (!eq) return;
  abrirModal(`
    <div class="modal">
      <h2>Editar equipamento</h2>
      <form id="form-editar-equip">
        <div class="field"><label>Nome do equipamento</label>
          <input id="f-ed-equip-nome" type="text" required value="${attrEsc(eq.nome)}" /></div>
        <div class="field"><label>TAG / ativo (opcional)</label>
          <input id="f-ed-equip-tag" type="text" inputmode="numeric" placeholder="0000-00 ou 00000-00" value="${attrEsc(eq.tag)}" /></div>
        <p class="error-msg" id="erro-ed-equip" style="display:none"></p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primary">Salvar</button>
        </div>
      </form>
      <hr style="border:none; border-top:1px solid var(--border); margin:18px 0 14px" />
      <button type="button" id="btn-apagar-equip" class="btn-danger">Apagar equipamento</button>
      <div id="confirma-apagar-equip" style="display:none; margin-top:12px">
        <p style="font-size:13px; margin-bottom:10px">Apagar <b>${escapeHtml(eq.nome)}</b> definitivamente?
          Só é possível se ele não estiver em nenhuma O.S. — caso contrário, use <b>Desativar</b>.</p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-cancel-apagar-equip>Voltar</button>
          <button type="button" id="btn-apagar-equip-sim" class="btn-danger">Sim, apagar</button>
        </div>
      </div>
    </div>`);

  $("#form-editar-equip").addEventListener("submit", async (e) => {
    e.preventDefault();
    const tag = $("#f-ed-equip-tag").value.trim();
    if (tag && !TAG_RE.test(tag)) {
      $("#erro-ed-equip").textContent = "TAG inválida. Use o formato 0000-00 ou 00000-00.";
      $("#erro-ed-equip").style.display = "block"; return;
    }
    const { error } = await supabase.from("equipamentos")
      .update({ nome: $("#f-ed-equip-nome").value.trim(), tag: tag || null }).eq("id", eq.id);
    const msg = mensagemDeErro(error);
    if (msg) { $("#erro-ed-equip").textContent = msg; $("#erro-ed-equip").style.display = "block"; return; }
    fecharModal();
    renderEquipamentos();
  });

  $("#btn-apagar-equip").addEventListener("click", () => {
    $("#btn-apagar-equip").style.display = "none";
    $("#confirma-apagar-equip").style.display = "block";
  });
  $("[data-cancel-apagar-equip]").addEventListener("click", () => {
    $("#confirma-apagar-equip").style.display = "none";
    $("#btn-apagar-equip").style.display = "inline-flex";
  });
  $("#btn-apagar-equip-sim").addEventListener("click", async () => {
    const btn = $("#btn-apagar-equip-sim"); btn.disabled = true; btn.textContent = "Apagando...";
    const { error } = await supabase.from("equipamentos").delete().eq("id", eq.id);
    if (error) {
      // 23503 = ainda referenciado por alguma O.S.
      const msg = error.code === "23503"
        ? "Este equipamento está em uso em alguma O.S. e não pode ser apagado. Use \"Desativar\"."
        : (mensagemDeErro(error) || error.message);
      $("#erro-ed-equip").textContent = msg; $("#erro-ed-equip").style.display = "block";
      btn.disabled = false; btn.textContent = "Sim, apagar";
      return;
    }
    fecharModal();
    renderEquipamentos();
  });
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
    <form id="form-novo-mp" style="display:flex; gap:10px; margin-bottom:6px;">
      <input id="f-mp-nome" type="text" placeholder="Novo motivo de pausa" required style="flex:1" />
      <button type="submit" class="btn-primary">Adicionar</button>
    </form>
    <p class="error-msg" id="erro-mp" style="display:none; text-align:left; margin-bottom:16px"></p>
    ${listaMotivos(mp, "motivos_pausa")}

    <h3 style="margin-top:28px">Motivos de emergência</h3>
    <form id="form-novo-me" style="display:flex; gap:10px; margin-bottom:6px;">
      <input id="f-me-nome" type="text" placeholder="Novo motivo de emergência" required style="flex:1" />
      <button type="submit" class="btn-primary">Adicionar</button>
    </form>
    <p class="error-msg" id="erro-me" style="display:none; text-align:left; margin-bottom:16px"></p>
    ${listaMotivos(me, "motivos_emergencia")}
  `;

  $("#form-novo-mp").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await supabase.from("motivos_pausa").insert({ descricao: $("#f-mp-nome").value.trim(), ordem: 50 });
    const msg = mensagemDeErro(error);
    if (msg) { $("#erro-mp").textContent = msg; $("#erro-mp").style.display = "block"; return; }
    renderMotivos();
  });
  $("#form-novo-me").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await supabase.from("motivos_emergencia").insert({ descricao: $("#f-me-nome").value.trim(), ordem: 50 });
    const msg = mensagemDeErro(error);
    if (msg) { $("#erro-me").textContent = msg; $("#erro-me").style.display = "block"; return; }
    renderMotivos();
  });

  el.querySelectorAll('[data-action="toggle-motivo"]').forEach(b => b.addEventListener("click", async () => {
    await supabase.from(b.dataset.tabela).update({ ativo: b.dataset.ativo !== "true" }).eq("id", b.dataset.id);
    renderMotivos();
  }));
}

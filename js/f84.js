import { supabase, exigirSessao } from "./supabaseClient.js";
import { escapeHtml } from "./utils.js";

// Metadados FIXOS do formulário (seção 1/8 da especificação — nunca mudam,
// exceto Versão/Data de revisão se a estrutura do form for alterada).
const DOC = { codigo: "F84", versao: "06", emissao: "20/04/2020", revisao: "31/01/2025" };
const RODAPE = [
  "Itaueira Industrial Ltda   CNPJ: 48.654.734/0001-10   Insc. Estadual: 07.099.749-7",
  "Rod. 304 km 19, s/n Zona Rural Palhano – CE / CEP: 62910-000   Fone: 85.98225-9919 / E-mail: scp.qualidade@itaueira.com",
];

const $ = (sel) => document.querySelector(sel);

init();

async function init() {
  const perfil = await exigirSessao();
  if (!perfil) return;

  $("#btn-imprimir").addEventListener("click", () => window.print());

  const osId = new URLSearchParams(location.search).get("os");
  if (!osId) { erro("O.S. não informada."); return; }

  const { data: os, error } = await supabase
    .from("ordens_servico")
    .select(`*, equipamentos(nome), executor:perfis!ordens_servico_executado_por_fkey(nome)`)
    .eq("id", osId).maybeSingle();
  if (error || !os) { erro(error?.message || "O.S. não encontrada."); return; }

  const [{ data: eventos }, { data: materiais }, { data: checklist }, { data: assinaturas }] = await Promise.all([
    supabase.from("os_eventos").select("tipo_evento, criado_em").eq("os_id", osId).in("tipo_evento", ["inicio", "conclusao"]).order("criado_em"),
    supabase.from("materiais_utilizados").select("nome").eq("os_id", osId).order("criado_em"),
    supabase.from("checklist_qualidade").select("*").eq("os_id", osId).maybeSingle(),
    supabase.from("assinaturas").select("papel, nome_responsavel, assinatura_png, coletado_em").eq("os_id", osId),
  ]);

  document.title = `O.S. ${os.codigo || "#" + os.numero} — F84`;
  render(os, eventos || [], materiais || [], checklist || {}, assinaturas || []);
}

function erro(msg) {
  $("#f84-doc").innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${escapeHtml(msg)}</div>`;
}

// ---------------------------------------------------------------------
// Formatação e helpers de campo
// ---------------------------------------------------------------------
function fmtData(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"; }
function fmtHora(iso) { return iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—"; }

// caixa de seleção marcada/vazia
function cx(on) { return `<span class="cx${on ? " on" : ""}"></span>`; }

// grupo de opção única: marca a escolhida
function opcaoUnica(opcoes, escolhida) {
  return `<span class="opts">${opcoes.map(o => `<span class="opt">${cx(o === escolhida)} ${escapeHtml(o)}</span>`).join("")}</span>`;
}
// par Sim/Não a partir de um booleano (null = nenhum marcado)
function simNao(valor) {
  return `<span class="opts"><span class="opt">${cx(valor === true)} Sim</span><span class="opt">${cx(valor === false)} Não</span></span>`;
}
// campo rótulo: valor
function campo(rotulo, valorHtml, classe = "") {
  return `<div class="f84-campo ${classe}"><span class="f84-rot">${escapeHtml(rotulo)}</span><span class="f84-val">${valorHtml}</span></div>`;
}
function txt(v) { return v ? escapeHtml(v) : "—"; }

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function render(os, eventos, materiais, ck, assinaturas) {
  const inicio = eventos.find(e => e.tipo_evento === "inicio");
  const fim = eventos.find(e => e.tipo_evento === "conclusao");
  const equip = os.equipamentos?.nome || os.equipamento_outro || "—";
  const assinatura = (papel) => assinaturas.find(a => a.papel === papel);
  const insp = assinatura("inspetor");
  const sup = assinatura("supervisor");
  const risco = ck.risco_contaminacao === true;

  const materiaisHtml = materiais.length
    ? materiais.map(m => escapeHtml(m.nome)).join(" · ")
    : "—";

  $("#f84-doc").innerHTML = `
  <div class="f84-page">
    <!-- Cabeçalho -->
    <header class="f84-cab">
      <div class="f84-logo"><img src="logo_itaueira.png" alt="itaueira" /></div>
      <div class="f84-titulo">ORDEM DE SERVIÇO</div>
      <div class="f84-meta">
        <div><b>Código:</b> ${DOC.codigo}</div>
        <div><b>Versão:</b> ${DOC.versao}</div>
        <div><b>Data de emissão:</b> ${DOC.emissao}</div>
        <div><b>Data de revisão:</b> ${DOC.revisao}</div>
      </div>
    </header>

    <!-- Seção 4 -->
    <section class="f84-secao">
      <h2>Dados da Ordem de Serviço</h2>
      <div class="f84-grid">
        ${campo("Chave", txt(os.chave))}
        ${campo("N° da Solicitação", txt(os.codigo))}
        ${campo("Equipamento", escapeHtml(equip))}
        ${campo("Tag", txt(os.tag))}
        ${campo("Setor", txt(os.setor_solicitante))}
        ${campo("Tipo de serviço", opcaoUnica(["Manutenção", "Confecção", "Instalação"], os.tipo_servico), "full")}
        ${campo("Tipo de manutenção", opcaoUnica(["Preventiva", "Corretiva", "Preditiva"], os.tipo_manutencao), "full")}
      </div>
    </section>

    <!-- Seção 5 -->
    <section class="f84-secao">
      <h2>Fechamento da Ordem de Serviço</h2>
      <div class="f84-grid">
        ${campo("Data de início", fmtData(inicio?.criado_em))}
        ${campo("Hora de início", fmtHora(inicio?.criado_em))}
        ${campo("Data da finalização", fmtData(fim?.criado_em))}
        ${campo("Hora da finalização", fmtHora(fim?.criado_em))}
        ${campo("Executado por", txt(os.executor?.nome), "full")}
        ${campo("Serviços Realizados", txt(os.servicos_realizados), "full bloco")}
        ${campo("Materiais utilizados no Serviço", materiaisHtml, "full bloco")}
        ${campo("Manutenção Eficiente?", simNao(ck.manutencao_eficiente ?? null))}
        ${campo("Ação", opcaoUnica(["Refazer", "Liberar", "Interromper uso"], ck.acao))}
        ${campo("Observações", txt(os.observacoes), "full bloco")}
      </div>
    </section>

    <!-- Seção 6 (condicional) -->
    <section class="f84-secao">
      <h2>Segurança Alimentar / Risco de Contaminação</h2>
      <div class="f84-grid">
        ${campo("A manutenção apresenta risco de contaminação para linhas de processamento vizinhas ou equipamentos utilizados no processo de alimentos?", simNao(ck.risco_contaminacao ?? null), "full")}
      </div>
      ${risco ? `
        <div class="f84-grid">
          ${campo("Limpeza do equipamento realizada?", simNao(ck.limpeza_equipamento ?? null))}
          ${campo("Área ao redor do equipamento limpa?", simNao(ck.area_limpa ?? null))}
          ${campo("Ausência de objetos estranhos na área?", simNao(ck.ausencia_objetos_estranhos ?? null))}
          ${campo("Equipamento liberado para uso?", simNao(ck.equipamento_liberado ?? null))}
          ${campo("Inspeção realizada por", txt(insp?.nome_responsavel))}
          ${campo("Data da Avaliação", fmtData(insp?.coletado_em || ck.preenchido_em))}
          ${campo("Supervisor de Manutenção", txt(sup?.nome_responsavel), "full")}
        </div>` : `<p class="f84-na">Sem risco de contaminação — bloco não aplicável.</p>`}
    </section>

    <!-- Assinaturas coletadas -->
    <section class="f84-secao f84-assinaturas">
      <h2>Assinaturas</h2>
      <div class="f84-assrow">
        ${risco ? blocoAssinatura("Inspetor", insp) : ""}
        ${blocoAssinatura("Supervisor de Manutenção", sup)}
      </div>
    </section>

    <footer class="f84-rodape">
      ${RODAPE.map(l => `<div>${escapeHtml(l)}</div>`).join("")}
    </footer>
  </div>`;
}

function blocoAssinatura(rotulo, ass) {
  return `
    <div class="f84-ass">
      <div class="f84-ass-img">${ass?.assinatura_png ? `<img src="${ass.assinatura_png}" alt="assinatura" />` : ""}</div>
      <div class="f84-ass-linha"></div>
      <div class="f84-ass-nome">${ass ? escapeHtml(ass.nome_responsavel) : "—"}</div>
      <div class="f84-ass-rot">${escapeHtml(rotulo)}</div>
    </div>`;
}

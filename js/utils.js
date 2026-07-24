export function formatarData(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", timeStyle: undefined, hour: "2-digit", minute: "2-digit" });
}

export function formatarDataCurta(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " +
    d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function formatarDuracao(segundos) {
  segundos = Number(segundos);
  if (!Number.isFinite(segundos) || segundos < 0) segundos = 0;
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}`;
}

export function diasDesde(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

export function slugPrio(prioridade) {
  return { "Normal": "prio-normal", "Prioritária": "prio-prioritaria", "Emergencial": "prio-emergencial" }[prioridade] || "prio-normal";
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

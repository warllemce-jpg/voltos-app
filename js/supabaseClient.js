import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Slugifica igual ao Edge Function create-colaborador, pra tolerar
// maiúsculas/espaços/acentos na hora de digitar o login.
export function slugify(nome) {
  return nome
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

// Garante que existe sessão e devolve o perfil (nome, papel, etc.).
// Redireciona pro login se não houver sessão válida.
export async function exigirSessao() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }
  const { data: perfil, error } = await supabase
    .from("perfis").select("*").eq("id", session.user.id).single();

  if (error || !perfil || !perfil.ativo) {
    await supabase.auth.signOut();
    window.location.href = "index.html";
    return null;
  }
  return perfil;
}

export async function sair() {
  await supabase.auth.signOut();
  window.location.href = "index.html";
}

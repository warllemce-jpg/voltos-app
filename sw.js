// VoltOS — Service Worker mínimo (Fase 1)
// Objetivo único aqui: satisfazer o requisito técnico de instalabilidade
// do PWA. NÃO implementa fila offline nem cache de dados — isso é Fase 2
// (ver seção 11 da especificação). O app hoje exige internet ativa.

const CACHE_NAME = "voltos-shell-v2";
const SHELL = [
  "./index.html",
  "./painel.html",
  "./admin.html",
  "./horas.html",
  "./relatorio.html",
  "./validacao.html",
  "./css/style.css",
  "./manifest.json",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first pro shell estático: sempre tenta a versão nova e só cai no
// cache se estiver sem rede. Era cache-first antes, e isso fazia o navegador
// continuar servindo HTML/JS velho depois de cada deploy (ver seção 5.1 do
// HANDOFF) — o cache do PWA só existe aqui pra instalabilidade, não vale
// pagar por ele com atualização quebrada.
// Chamadas ao Supabase não passam por aqui em momento nenhum.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // não mexe em chamadas ao Supabase
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((resposta) => {
        if (resposta.ok) {
          const copia = resposta.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        }
        return resposta;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || Promise.reject(new Error("offline"))))
  );
});

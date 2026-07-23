// VoltOS — Service Worker mínimo (Fase 1)
// Objetivo único aqui: satisfazer o requisito técnico de instalabilidade
// do PWA. NÃO implementa fila offline nem cache de dados — isso é Fase 2
// (ver seção 11 da especificação). O app hoje exige internet ativa.

const CACHE_NAME = "voltos-shell-v1";
const SHELL = [
  "./index.html",
  "./painel.html",
  "./admin.html",
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

// Cache-first só pra shell estático; tudo que é dado (Supabase) vai direto
// pra rede, sem interceptação — evita servir dado velho escondido em cache.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // não mexe em chamadas ao Supabase

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

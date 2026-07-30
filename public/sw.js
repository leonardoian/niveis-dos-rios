// Service worker do painel — só existe pra receber notificações push (Web
// Push API). Não faz cache de assets nem funciona offline de propósito: é
// uma ferramenta de monitoramento em tempo real, cache agressivo de HTML/
// dados antigos seria pior que não ter nada (mostraria nível desatualizado
// como se fosse atual).

self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch (e) {
    dados = { title: 'Níveis dos Rios', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(dados.title || 'Níveis dos Rios', {
      body: dados.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: dados.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || '/'));
});

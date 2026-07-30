// Notificações push (index.html só) — depende de js/comum.js (mostrarAviso)
// já carregado antes. Chave pública VAPID: não é secreta (só a privada é,
// e essa fica só no ambiente do Vercel — ver lib/push.js/README).
const VAPID_PUBLIC_KEY = 'BD81kIdkJiu1t4fe_5BTEd2tFHjXXVFsKq-xA47AeYyDvLGTd_WbTFH7A_zVhBg7gvssbXn5AzUerfkac7jqLCc';

const btnNotificacoes = document.getElementById('notificacoesToggle');

// PushManager.subscribe() espera a chave pública como Uint8Array, não como
// a string base64url que o web-push gera — conversão padrão da Web Push API.
function urlBase64ParaUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Segura = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bruto = atob(base64Segura);
  return Uint8Array.from([...bruto].map((c) => c.charCodeAt(0)));
}

function atualizarBotao(ativo) {
  if (!btnNotificacoes) return;
  btnNotificacoes.textContent = ativo ? '🔕 Notificações ativas' : '🔔 Ativar notificações';
  btnNotificacoes.dataset.ativo = ativo ? '1' : '0';
}

async function obterRegistroEInscricao() {
  const registro = await navigator.serviceWorker.register('/sw.js');
  const inscricao = await registro.pushManager.getSubscription();
  return { registro, inscricao };
}

async function ativarNotificacoes() {
  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    mostrarAviso('aviso', 'Permissão de notificação negada — ative nas configurações do navegador se mudar de ideia.');
    return;
  }

  try {
    const { registro } = await obterRegistroEInscricao();
    const inscricao = await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ParaUint8Array(VAPID_PUBLIC_KEY),
    });

    const r = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inscricao.toJSON()),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    atualizarBotao(true);
  } catch (e) {
    mostrarAviso('aviso', 'Não foi possível ativar as notificações: ' + e.message);
  }
}

async function desativarNotificacoes() {
  try {
    const { inscricao } = await obterRegistroEInscricao();
    if (inscricao) {
      await fetch('/api/push', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: inscricao.endpoint }),
      });
      await inscricao.unsubscribe();
    }
  } catch (e) {
    mostrarAviso('aviso', 'Não foi possível desativar as notificações: ' + e.message);
  } finally {
    atualizarBotao(false);
  }
}

if (btnNotificacoes) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    // Navegador sem suporte (ex.: Safari/iOS mais antigo) — esconde em vez
    // de deixar um botão que sempre falha ao clicar.
    btnNotificacoes.hidden = true;
  } else {
    btnNotificacoes.addEventListener('click', async () => {
      const ativo = btnNotificacoes.dataset.ativo === '1';
      btnNotificacoes.disabled = true;
      if (ativo) await desativarNotificacoes();
      else await ativarNotificacoes();
      btnNotificacoes.disabled = false;
    });

    obterRegistroEInscricao()
      .then(({ inscricao }) => atualizarBotao(!!inscricao))
      .catch(() => {}); // registro do SW falhou silenciosamente — botão fica no estado padrão
  }
}

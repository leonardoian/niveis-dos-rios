// Notificações push (index.html só) — depende de js/comum.js (mostrarAviso)
// já carregado antes. Chave pública VAPID: não é secreta (só a privada é,
// e essa fica só no ambiente do Vercel — ver lib/push.js/README).
const VAPID_PUBLIC_KEY = 'BD81kIdkJiu1t4fe_5BTEd2tFHjXXVFsKq-xA47AeYyDvLGTd_WbTFH7A_zVhBg7gvssbXn5AzUerfkac7jqLCc';

const btnNotificacoes = document.getElementById('notificacoesToggle');
const btnPreferencias = document.getElementById('notifPreferencias');

// Preferência de estações, espelhada em localStorage. A fonte da verdade é
// o banco (é ele que o envio consulta), mas guardar aqui evita que o modal
// abra vazio antes de qualquer salvamento — não há GET /api/push pra ler a
// inscrição de volta, e criar um exporia a preferência de qualquer endpoint
// a quem soubesse a URL dele.
const CHAVE_PREFERENCIA = 'notifSlugs';

function slugsSalvos() {
  try {
    const cru = localStorage.getItem(CHAVE_PREFERENCIA);
    const lista = cru ? JSON.parse(cru) : null;
    return Array.isArray(lista) ? lista : null;
  } catch {
    return null; // localStorage indisponível/corrompido — trata como "todas"
  }
}

function guardarSlugs(slugs) {
  try {
    if (slugs === null) localStorage.removeItem(CHAVE_PREFERENCIA);
    else localStorage.setItem(CHAVE_PREFERENCIA, JSON.stringify(slugs));
  } catch { /* sem localStorage: a preferência já foi pro banco, que é o que vale */ }
}

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
  // Escolher estações só faz sentido com notificação ligada — o botão fica
  // escondido em vez de desabilitado pra não virar enfeite morto na barra.
  if (btnPreferencias) btnPreferencias.hidden = !ativo;
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
      body: JSON.stringify({ ...inscricao.toJSON(), slugs: slugsSalvos() }),
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

// ---- Modal de preferência por estação ----
// Depende de `dados` (window global preenchido por js/painel.js) pra listar
// as estações — mesma fonte que o modal de comparação já usa. Se o painel
// ainda não carregou, o modal avisa em vez de abrir vazio.

const overlayNotif = document.getElementById('modalNotifOverlay');

function estacoesDisponiveis() {
  return (typeof dados !== 'undefined' && dados && Array.isArray(dados.estacoes)) ? dados.estacoes : [];
}

function renderizarListaNotif() {
  const el = document.getElementById('notifLista');
  const estacoes = estacoesDisponiveis();
  if (estacoes.length === 0) {
    el.innerHTML = '<p class="modal-vazio">O painel ainda está carregando as estações. Feche e abra de novo em instantes.</p>';
    return;
  }
  const selecionados = slugsSalvos();
  el.innerHTML = estacoes.map((e) => `
    <label class="comparar-item">
      <input type="checkbox" value="${e.slug}" ${selecionados === null || selecionados.includes(e.slug) ? 'checked' : ''}>
      ${e.cidade}/${e.uf}
    </label>
  `).join('');
}

function marcarTodos(marcado) {
  document.querySelectorAll('#notifLista input[type=checkbox]').forEach((i) => { i.checked = marcado; });
}

function abrirNotif() {
  renderizarListaNotif();
  const status = document.getElementById('notifStatus');
  status.hidden = true;
  overlayNotif.hidden = false;
}

function fecharNotif() {
  overlayNotif.hidden = true;
}

async function salvarPreferencias() {
  const status = document.getElementById('notifStatus');
  const marcados = [...document.querySelectorAll('#notifLista input[type=checkbox]:checked')].map((i) => i.value);
  const total = estacoesDisponiveis().length;
  // Todas marcadas (ou nenhuma) = null: "todas" tem uma representação só,
  // e é a que acompanha uma estação nova que entre no painel depois.
  const slugs = marcados.length === 0 || marcados.length === total ? null : marcados;

  try {
    const { inscricao } = await obterRegistroEInscricao();
    if (!inscricao) throw new Error('inscrição não encontrada — reative as notificações');

    const r = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...inscricao.toJSON(), slugs }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    guardarSlugs(slugs);
    status.textContent = slugs === null
      ? '✓ Salvo — você recebe alerta de todas as estações.'
      : `✓ Salvo — você recebe alerta de ${slugs.length} estaç${slugs.length === 1 ? 'ão' : 'ões'}.`;
    status.hidden = false;
  } catch (e) {
    status.textContent = 'Não foi possível salvar: ' + e.message;
    status.hidden = false;
  }
}

if (btnPreferencias && overlayNotif) {
  btnPreferencias.addEventListener('click', abrirNotif);
  document.getElementById('modalNotifFechar').addEventListener('click', fecharNotif);
  overlayNotif.addEventListener('click', (ev) => { if (ev.target === overlayNotif) fecharNotif(); });
  document.getElementById('notifTodas').addEventListener('click', () => marcarTodos(true));
  document.getElementById('notifNenhuma').addEventListener('click', () => marcarTodos(false));
  document.getElementById('notifSalvar').addEventListener('click', salvarPreferencias);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !overlayNotif.hidden) fecharNotif();
  });
}

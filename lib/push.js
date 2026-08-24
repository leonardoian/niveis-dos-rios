import webpush from 'web-push';

// Notificações push (Web Push API nativa — Service Worker + VAPID, sem
// depender de Telegram/Firebase/terceiro pago). Feature opcional: se as
// variáveis VAPID não estiverem configuradas no ambiente, não quebra a
// coleta — só não envia nada (mesmo espírito de atualizarPrevisoes() em
// coletar.js, que tolera fontes ausentes).
let configurado = false;

// Pura (recebe o env como argumento em vez de ler process.env direto) pra
// dar pra testar sem mockar nada — ver tests/push.test.js.
export function temVapidConfigurado(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

function configurar() {
  if (configurado) return true;
  if (!temVapidConfigurado(process.env)) return false;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configurado = true;
  return true;
}

const ROTULOS_NOTIFICACAO = {
  normal: 'voltou ao normal',
  atencao: 'entrou em atenção',
  alerta: 'entrou em alerta',
  alagado: 'está alagada',
};

// alerta = {cidade, status, tipo?}. tipo ausente ou 'nivel' = comportamento
// original (mesmo formato que registrarAlertas() sempre retornou, não
// quebra chamadores antigos). tipo === 'chuva' = alerta de chuva acumulada
// (registrarAlertasChuva() em coletar.js), com {chuvaMmAcumulada,
// janelaHoras} no objeto. Pura — monta o payload sem tocar em rede/banco.
export function montarPayloadAlerta(alerta) {
  if (alerta.tipo === 'chuva') {
    const corpo = alerta.status === 'chuva_alerta'
      ? `${alerta.chuvaMmAcumulada.toFixed(0)}mm em ${alerta.janelaHoras}h — atenção`
      : 'chuva acumulada voltou a ficar abaixo do limiar';
    return JSON.stringify({
      title: `🌧️ ${alerta.cidade}`,
      body: corpo,
      url: '/',
    });
  }

  return JSON.stringify({
    title: `🌊 ${alerta.cidade}`,
    body: ROTULOS_NOTIFICACAO[alerta.status] || alerta.status,
    url: '/',
  });
}

// Hosts dos serviços de push dos navegadores. `endpoint` chega de qualquer
// visitante (POST /api/push é público de propósito) e depois vira uma
// requisição SAINDO do nosso servidor a cada alerta — o `web-push` só checa
// que é string não-vazia, não o host. Sem allowlist, dava pra registrar
// http://169.254.169.254/... ou qualquer host interno e transformar a
// coleta num SSRF cego, disparado de novo a cada alerta. Prefixo com ponto
// = casa subdomínio (o serviço distribui por região, ex.:
// wns2-par02p.notify.windows.com); sem ponto = host exato.
const HOSTS_PUSH = [
  'fcm.googleapis.com',              // Chrome/Chromium
  'web.push.apple.com',              // Safari/iOS
  '.push.services.mozilla.com',      // Firefox
  '.notify.windows.com',             // Edge/Windows
];

// Limites generosos (o p256dh real tem ~88 chars e o auth ~24), só pra
// impedir que a tabela vire depósito de blob arbitrário.
const MAX_ENDPOINT = 1000;
const MAX_CHAVE = 255;

// Pura (sem rede/banco) pra dar pra testar isolada — ver tests/push.test.js.
export function endpointPermitido(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT) return false;

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  return HOSTS_PUSH.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
}

// Formato das chaves de criptografia da inscrição — só presença e tamanho,
// o conteúdo em si quem valida é o próprio web-push na hora de assinar.
export function chavesValidas(keys) {
  if (!keys) return false;
  const { p256dh, auth } = keys;
  return typeof p256dh === 'string' && p256dh.length > 0 && p256dh.length <= MAX_CHAVE
      && typeof auth === 'string' && auth.length > 0 && auth.length <= MAX_CHAVE;
}

// 404/410 = inscrição expirou/foi revogada no navegador — autolimpeza,
// senão acumula lixo pra sempre em push_subscriptions. Qualquer outro erro
// (rede instável, payload rejeitado etc.) só loga e mantém a inscrição.
export function ehInscricaoExpirada(erro) {
  return erro?.statusCode === 404 || erro?.statusCode === 410;
}

// alertas = [{cidade, status}, ...]. Notifica TODOS os inscritos sobre TODA
// mudança de status (decisão de escopo: sem preferência por estação, sem
// filtro de "só entrando em risco" — mesmo critério que já popula a tabela
// alertas hoje — ver README).
export async function enviarNotificacoesAlerta(alertas) {
  if (!alertas || alertas.length === 0) return { enviadas: 0 };
  if (!configurar()) return { enviadas: 0, aviso: 'VAPID não configurado' };

  // Import tardio de propósito: ./db.js lança se DATABASE_URL não estiver
  // definida (falha rápida, ver lib/db.js) — um import no topo do arquivo
  // quebraria a suite de testes (tests/push.test.js só testa as funções
  // puras acima, sem banco configurado), do mesmo jeito que
  // tests/calculo.test.js/feed.test.js hoje só testam módulos que não
  // tocam em ./db.js.
  const { sql } = await import('./db.js');
  const gravadas = await sql`SELECT id, endpoint, p256dh, auth FROM push_subscriptions`;

  // Refiltra na saída, não só na entrada: linhas gravadas ANTES da
  // allowlist existir continuam na tabela, e é aqui que o endpoint vira
  // requisição de verdade. Segunda barreira barata contra o mesmo SSRF.
  const inscricoes = gravadas.filter((i) => endpointPermitido(i.endpoint));
  if (inscricoes.length === 0) return { enviadas: 0 };

  let enviadas = 0;
  const tarefas = [];

  for (const alerta of alertas) {
    const payload = montarPayloadAlerta(alerta);

    for (const insc of inscricoes) {
      const assinatura = { endpoint: insc.endpoint, keys: { p256dh: insc.p256dh, auth: insc.auth } };
      tarefas.push(
        webpush.sendNotification(assinatura, payload)
          .then(() => { enviadas += 1; })
          .catch(async (erro) => {
            if (ehInscricaoExpirada(erro)) {
              await sql`DELETE FROM push_subscriptions WHERE id = ${insc.id}`;
            } else {
              console.error('Falha ao enviar notificação push:', erro.message);
            }
          })
      );
    }
  }

  await Promise.allSettled(tarefas);
  return { enviadas };
}

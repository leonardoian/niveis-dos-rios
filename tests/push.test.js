import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temVapidConfigurado, montarPayloadAlerta, ehInscricaoExpirada, endpointPermitido, chavesValidas } from '../lib/push.js';

test('temVapidConfigurado: true quando as 3 variáveis estão presentes', () => {
  assert.equal(
    temVapidConfigurado({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', VAPID_SUBJECT: 'mailto:x@x.com' }),
    true
  );
});

test('temVapidConfigurado: false faltando qualquer uma das 3', () => {
  assert.equal(temVapidConfigurado({}), false);
  assert.equal(temVapidConfigurado({ VAPID_PUBLIC_KEY: 'a' }), false);
  assert.equal(temVapidConfigurado({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' }), false);
});

test('montarPayloadAlerta: estação entrando em alerta', () => {
  const payload = JSON.parse(montarPayloadAlerta({ cidade: 'Lajeado', status: 'alerta' }));
  assert.equal(payload.title, '🌊 Lajeado');
  assert.equal(payload.body, 'entrou em alerta');
  assert.equal(payload.url, '/');
});

test('montarPayloadAlerta: estação voltando ao normal (também notifica, por decisão de escopo)', () => {
  const payload = JSON.parse(montarPayloadAlerta({ cidade: 'Taquara', status: 'normal' }));
  assert.equal(payload.body, 'voltou ao normal');
});

test('montarPayloadAlerta: status desconhecido cai pro texto cru em vez de quebrar', () => {
  const payload = JSON.parse(montarPayloadAlerta({ cidade: 'X', status: 'algo_novo' }));
  assert.equal(payload.body, 'algo_novo');
});

test('montarPayloadAlerta: sem tipo (regressão) continua com título 🌊, comportamento de nível', () => {
  const payload = JSON.parse(montarPayloadAlerta({ cidade: 'Feliz', status: 'atencao' }));
  assert.equal(payload.title, '🌊 Feliz');
});

test('montarPayloadAlerta: tipo chuva, status chuva_alerta', () => {
  const payload = JSON.parse(montarPayloadAlerta({
    cidade: 'Muçum', status: 'chuva_alerta', tipo: 'chuva', chuvaMmAcumulada: 42, janelaHoras: 6,
  }));
  assert.equal(payload.title, '🌧️ Muçum');
  assert.equal(payload.body, '42mm em 6h — atenção');
  assert.equal(payload.url, '/');
});

test('montarPayloadAlerta: tipo chuva, status chuva_normal', () => {
  const payload = JSON.parse(montarPayloadAlerta({
    cidade: 'Taquara', status: 'chuva_normal', tipo: 'chuva', chuvaMmAcumulada: 10, janelaHoras: 6,
  }));
  assert.equal(payload.body, 'chuva acumulada voltou a ficar abaixo do limiar');
});

test('ehInscricaoExpirada: 404 e 410 contam como expirada', () => {
  assert.equal(ehInscricaoExpirada({ statusCode: 404 }), true);
  assert.equal(ehInscricaoExpirada({ statusCode: 410 }), true);
});

test('ehInscricaoExpirada: outros códigos não contam (ex.: 500, erro de rede sem statusCode)', () => {
  assert.equal(ehInscricaoExpirada({ statusCode: 500 }), false);
  assert.equal(ehInscricaoExpirada({}), false);
  assert.equal(ehInscricaoExpirada(new Error('timeout')), false);
});

// ---- allowlist de endpoint (anti-SSRF) ----
// POST /api/push é público, então `endpoint` é dado hostil: ele acaba virando
// uma requisição SAINDO do nosso servidor a cada alerta.

test('endpointPermitido: aceita os 4 serviços de push reais', () => {
  const bons = [
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://web.push.apple.com/QAbc123',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=xyz',
  ];
  for (const e of bons) assert.equal(endpointPermitido(e), true, e);
});

test('endpointPermitido: recusa host interno/metadata (o SSRF que isso existe pra barrar)', () => {
  const ruins = [
    'http://169.254.169.254/latest/meta-data/',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/admin',
    'https://127.0.0.1:5432/',
    'https://10.0.0.5/interno',
    'https://exemplo.com/qualquer',
  ];
  for (const e of ruins) assert.equal(endpointPermitido(e), false, e);
});

test('endpointPermitido: exige HTTPS mesmo em host permitido', () => {
  assert.equal(endpointPermitido('http://fcm.googleapis.com/fcm/send/abc'), false);
});

test('endpointPermitido: sufixo não pode ser burlado por host parecido', () => {
  // "…mozilla.com.evil.test" e "evilpush.services.mozilla.com" não são
  // subdomínio de .push.services.mozilla.com.
  assert.equal(endpointPermitido('https://updates.push.services.mozilla.com.evil.test/x'), false);
  assert.equal(endpointPermitido('https://fcm.googleapis.com.evil.test/x'), false);
  assert.equal(endpointPermitido('https://naofcm.googleapis.com/x'), false);
});

test('endpointPermitido: tipo errado, vazio, URL inválida ou gigante retorna false', () => {
  assert.equal(endpointPermitido(undefined), false);
  assert.equal(endpointPermitido(null), false);
  assert.equal(endpointPermitido(42), false);
  assert.equal(endpointPermitido(''), false);
  assert.equal(endpointPermitido('nao-e-url'), false);
  assert.equal(endpointPermitido('https://fcm.googleapis.com/' + 'a'.repeat(1001)), false);
});

test('chavesValidas: par completo passa', () => {
  assert.equal(chavesValidas({ p256dh: 'BExemplo', auth: 'authExemplo' }), true);
});

test('chavesValidas: faltando, vazio, tipo errado ou grande demais falha', () => {
  assert.equal(chavesValidas(undefined), false);
  assert.equal(chavesValidas({}), false);
  assert.equal(chavesValidas({ p256dh: 'x' }), false);
  assert.equal(chavesValidas({ p256dh: 'x', auth: '' }), false);
  assert.equal(chavesValidas({ p256dh: 'x', auth: 123 }), false);
  assert.equal(chavesValidas({ p256dh: 'a'.repeat(256), auth: 'x' }), false);
});

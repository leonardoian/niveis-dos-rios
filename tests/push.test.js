import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temVapidConfigurado, montarPayloadAlerta, ehInscricaoExpirada } from '../lib/push.js';

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

test('ehInscricaoExpirada: 404 e 410 contam como expirada', () => {
  assert.equal(ehInscricaoExpirada({ statusCode: 404 }), true);
  assert.equal(ehInscricaoExpirada({ statusCode: 410 }), true);
});

test('ehInscricaoExpirada: outros códigos não contam (ex.: 500, erro de rede sem statusCode)', () => {
  assert.equal(ehInscricaoExpirada({ statusCode: 500 }), false);
  assert.equal(ehInscricaoExpirada({}), false);
  assert.equal(ehInscricaoExpirada(new Error('timeout')), false);
});

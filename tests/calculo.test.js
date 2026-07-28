import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classificar, calcularVelocidade, calcularFrescor, calcularVariacao24h, calcularEtaCota } from '../lib/calculo.js';

test('classificar: abaixo de 60% da cota é normal', () => {
  assert.equal(classificar(5, 10), 'normal');
});

test('classificar: 60% é atenção (limite inclusivo)', () => {
  assert.equal(classificar(6, 10), 'atencao');
});

test('classificar: 80% é alerta (limite inclusivo)', () => {
  assert.equal(classificar(8, 10), 'alerta');
});

test('classificar: 100% ou mais é alagado', () => {
  assert.equal(classificar(10, 10), 'alagado');
  assert.equal(classificar(15, 10), 'alagado');
});

test('classificar: sem leitura retorna sem_dado', () => {
  assert.equal(classificar(null, 10), 'sem_dado');
});

test('calcularVelocidade: subida de 1m em 1h = 100 cm/h', () => {
  assert.equal(calcularVelocidade(11, 10, '2026-01-01T13:00:00Z', '2026-01-01T12:00:00Z'), 100);
});

test('calcularVelocidade: descida vira número negativo', () => {
  assert.equal(calcularVelocidade(9, 10, '2026-01-01T13:00:00Z', '2026-01-01T12:00:00Z'), -100);
});

test('calcularVelocidade: sem leitura atual ou anterior retorna null', () => {
  assert.equal(calcularVelocidade(null, 10, '2026-01-01T13:00:00Z', '2026-01-01T12:00:00Z'), null);
  assert.equal(calcularVelocidade(10, null, '2026-01-01T13:00:00Z', '2026-01-01T12:00:00Z'), null);
});

test('calcularVelocidade: intervalo zero ou negativo retorna null (evita divisão por zero)', () => {
  assert.equal(calcularVelocidade(10, 9, '2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z'), null);
  assert.equal(calcularVelocidade(10, 9, '2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z'), null);
});

test('calcularFrescor: leitura de agora mesmo é ao_vivo', () => {
  const agora = Date.parse('2026-01-01T12:00:00Z');
  const r = calcularFrescor('2026-01-01T12:00:00Z', agora);
  assert.equal(r.status, 'ao_vivo');
  assert.equal(r.idadeSegundos, 0);
});

test('calcularFrescor: 30 min atrás é atrasado', () => {
  const agora = Date.parse('2026-01-01T12:30:00Z');
  assert.equal(calcularFrescor('2026-01-01T12:00:00Z', agora).status, 'atrasado');
});

test('calcularFrescor: exatamente 20 min ainda é ao_vivo (limite inclusivo)', () => {
  const agora = Date.parse('2026-01-01T12:20:00Z');
  assert.equal(calcularFrescor('2026-01-01T12:00:00Z', agora).status, 'ao_vivo');
});

test('calcularFrescor: 2h atrás é obsoleto', () => {
  const agora = Date.parse('2026-01-01T14:00:00Z');
  assert.equal(calcularFrescor('2026-01-01T12:00:00Z', agora).status, 'obsoleto');
});

test('calcularFrescor: sem leitura nenhuma retorna sem_dado', () => {
  const r = calcularFrescor(null);
  assert.equal(r.status, 'sem_dado');
  assert.equal(r.idadeSegundos, null);
});

test('calcularVariacao24h: subida de 34cm em 24h', () => {
  assert.equal(calcularVariacao24h(12.74, 12.40), 34);
});

test('calcularVariacao24h: descida vira número negativo', () => {
  assert.equal(calcularVariacao24h(12.0, 12.5), -50);
});

test('calcularVariacao24h: sem nível atual ou sem referência de 24h retorna null', () => {
  assert.equal(calcularVariacao24h(null, 12.4), null);
  assert.equal(calcularVariacao24h(12.4, null), null);
});

test('calcularEtaCota: subindo, longe da cota', () => {
  // nivel=6.5 cota=10 margem=3.5 velocidade=5cm/h -> 3.5*100/5 = 70h
  const r = calcularEtaCota(6.5, 10, 3.5, 5, 65);
  assert.equal(r.classe, 'subindo');
  assert.equal(r.horas, 70);
  assert.equal(r.alvoNivel, 10);
});

test('calcularEtaCota: descendo, ainda acima do limiar de normal (60% da cota)', () => {
  // nivel=7.0 cota=10 (normal=6.0) velocidade=-4cm/h -> margem até normal=1.0 -> 1.0*100/4 = 25h
  const r = calcularEtaCota(7.0, 10, 3.0, -4, 70);
  assert.equal(r.classe, 'descendo');
  assert.equal(r.horas, 25);
  assert.equal(r.alvoNivel, 6);
});

test('calcularEtaCota: subindo mas já passou a cota retorna null', () => {
  assert.equal(calcularEtaCota(10.5, 10, -0.5, 3, 105), null);
});

test('calcularEtaCota: descendo mas já está normal retorna null', () => {
  assert.equal(calcularEtaCota(5.0, 10, 5.0, -2, 50), null);
});

test('calcularEtaCota: velocidade zero ou nula retorna null', () => {
  assert.equal(calcularEtaCota(6.5, 10, 3.5, 0, 65), null);
  assert.equal(calcularEtaCota(6.5, 10, 3.5, null, 65), null);
});

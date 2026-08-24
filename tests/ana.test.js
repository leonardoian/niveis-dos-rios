import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESTACOES_ANA, codigosParaLotes, converterCotaParaMetros, converterChuvaMm, converterDataHoraAna, calcularChuvaAcumulada, deduplicarLeituras } from '../lib/ana.js';

test('ESTACOES_ANA: tem exatamente 12 estações mapeadas', () => {
  assert.equal(Object.keys(ESTACOES_ANA).length, 12);
});

test('ESTACOES_ANA: não inclui lajeado nem rocasales (ambiguidade não resolvida)', () => {
  assert.equal('lajeado' in ESTACOES_ANA, false);
  assert.equal('rocasales' in ESTACOES_ANA, false);
});

test('ESTACOES_ANA: inclui portoalegre com o código já validado (Usina do Gasômetro)', () => {
  assert.equal(ESTACOES_ANA.portoalegre, '87450020');
});

test('codigosParaLotes: divide em lotes de até 10 (limite da API)', () => {
  const codigos = Object.values(ESTACOES_ANA); // 12 códigos
  const lotes = codigosParaLotes(codigos);
  assert.equal(lotes.length, 2);
  assert.equal(lotes[0].length, 10);
  assert.equal(lotes[1].length, 2);
});

test('codigosParaLotes: menos códigos que o tamanho do lote vira um lote só', () => {
  const lotes = codigosParaLotes(['a', 'b', 'c'], 10);
  assert.deepEqual(lotes, [['a', 'b', 'c']]);
});

test('codigosParaLotes: lista vazia retorna nenhum lote', () => {
  assert.deepEqual(codigosParaLotes([]), []);
});

test('converterCotaParaMetros: centímetros (string, formato da API) vira metros', () => {
  assert.equal(converterCotaParaMetros('171.00'), 1.71);
  assert.equal(converterCotaParaMetros('242.00'), 2.42);
});

test('converterCotaParaMetros: null/undefined/inválido retorna null em vez de quebrar', () => {
  assert.equal(converterCotaParaMetros(null), null);
  assert.equal(converterCotaParaMetros(undefined), null);
  assert.equal(converterCotaParaMetros('não é número'), null);
});

test('converterChuvaMm: número válido (string, formato da API) fica como está, em mm', () => {
  assert.equal(converterChuvaMm('0.00'), 0);
  assert.equal(converterChuvaMm('12.40'), 12.4);
});

test('converterChuvaMm: null/undefined/inválido retorna null em vez de quebrar', () => {
  assert.equal(converterChuvaMm(null), null);
  assert.equal(converterChuvaMm(undefined), null);
  assert.equal(converterChuvaMm('não é número'), null);
});

test('converterDataHoraAna: interpreta como horário de Brasília (UTC-3), não UTC', () => {
  // Confirmado numa chamada real durante a investigação: uma leitura às
  // 15:15 (hora de Brasília) é 18:15 em UTC.
  assert.equal(converterDataHoraAna('2026-07-30 15:15:00.0'), '2026-07-30T18:15:00.000Z');
});

test('converterDataHoraAna: vazio/nulo retorna null', () => {
  assert.equal(converterDataHoraAna(null), null);
  assert.equal(converterDataHoraAna(''), null);
});

test('converterDataHoraAna: string inválida retorna null em vez de "Invalid Date"', () => {
  assert.equal(converterDataHoraAna('isso não é uma data'), null);
});

test('calcularChuvaAcumulada: lista vazia retorna null (sem dado)', () => {
  assert.equal(calcularChuvaAcumulada([]), null);
});

test('calcularChuvaAcumulada: uma única leitura retorna 0 (sem delta pra somar)', () => {
  assert.equal(calcularChuvaAcumulada([{ chuvaMm: 12, medidoEm: '2026-07-30T12:00:00Z' }]), 0);
});

test('calcularChuvaAcumulada: sequência monotônica crescente soma o total', () => {
  const leituras = [
    { chuvaMm: 0, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: 5, medidoEm: '2026-07-30T13:00:00Z' },
    { chuvaMm: 12, medidoEm: '2026-07-30T14:00:00Z' },
  ];
  assert.equal(calcularChuvaAcumulada(leituras), 12);
});

test('calcularChuvaAcumulada: queda no meio (reset) soma só os deltas positivos', () => {
  const leituras = [
    { chuvaMm: 5, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: 12, medidoEm: '2026-07-30T13:00:00Z' }, // +7
    { chuvaMm: 3, medidoEm: '2026-07-30T14:00:00Z' },  // queda — ignorada
    { chuvaMm: 9, medidoEm: '2026-07-30T15:00:00Z' },  // +6
  ];
  assert.equal(calcularChuvaAcumulada(leituras), 13);
});

test('calcularChuvaAcumulada: ignora leituras com chuvaMm null/undefined', () => {
  const leituras = [
    { chuvaMm: 2, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: null, medidoEm: '2026-07-30T12:30:00Z' },
    { chuvaMm: 8, medidoEm: '2026-07-30T13:00:00Z' },
    { chuvaMm: undefined, medidoEm: '2026-07-30T13:30:00Z' },
  ];
  assert.equal(calcularChuvaAcumulada(leituras), 6);
});

test('calcularChuvaAcumulada: todas as leituras null/undefined retorna null', () => {
  const leituras = [
    { chuvaMm: null, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: undefined, medidoEm: '2026-07-30T13:00:00Z' },
  ];
  assert.equal(calcularChuvaAcumulada(leituras), null);
});

test('calcularChuvaAcumulada: ordena internamente antes de somar (entrada fora de ordem)', () => {
  const leituras = [
    { chuvaMm: 9, medidoEm: '2026-07-30T15:00:00Z' },
    { chuvaMm: 0, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: 5, medidoEm: '2026-07-30T13:00:00Z' },
  ];
  assert.equal(calcularChuvaAcumulada(leituras), 9);
});

// ---- deduplicarLeituras ----
// Guardamos as 48h inteiras que a API devolve, então a mesma (estação,
// instante) pode aparecer repetida entre lotes — e vai tudo num bulk insert.

test('deduplicarLeituras: mesma estação+instante vira uma linha só', () => {
  const r = deduplicarLeituras([
    { slug: 'mucum', nivel: 10.0, medidoEm: '2026-08-01T00:00:00.000Z', chuvaMm: 1 },
    { slug: 'mucum', nivel: 10.0, medidoEm: '2026-08-01T00:00:00.000Z', chuvaMm: 1 },
  ]);
  assert.equal(r.length, 1);
});

test('deduplicarLeituras: mesma estação em instantes diferentes são linhas distintas', () => {
  const r = deduplicarLeituras([
    { slug: 'mucum', nivel: 10.0, medidoEm: '2026-08-01T00:00:00.000Z' },
    { slug: 'mucum', nivel: 10.2, medidoEm: '2026-08-01T00:15:00.000Z' },
  ]);
  assert.equal(r.length, 2);
});

test('deduplicarLeituras: estações diferentes no mesmo instante não colidem', () => {
  const r = deduplicarLeituras([
    { slug: 'mucum', nivel: 10.0, medidoEm: '2026-08-01T00:00:00.000Z' },
    { slug: 'feliz', nivel: 3.0, medidoEm: '2026-08-01T00:00:00.000Z' },
  ]);
  assert.equal(r.length, 2);
});

test('deduplicarLeituras: lista vazia continua vazia', () => {
  assert.deepEqual(deduplicarLeituras([]), []);
});

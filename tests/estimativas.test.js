import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planejarEstimativaCota,
  classeVariacao,
  agregarAcertoPorVersao,
  skillScore,
} from '../lib/calculo.js';

// Série de leituras a cada 15 min terminando em `fim`, cobrindo `horas`,
// com o nível variando `cmH` por hora a partir de `nivelFinal` (contado pra
// trás). `ruido` opcional soma um valor por índice (pra simular tremor de
// instrumento entre leituras consecutivas).
function serie({ fim = '2026-01-01T15:00:00Z', horas = 3, nivelFinal, cmH, ruido = () => 0 }) {
  const fimMs = Date.parse(fim);
  const passos = Math.round(horas * 4);
  const leituras = [];
  for (let i = passos; i >= 0; i--) {
    const t = fimMs - i * 15 * 60_000;
    const nivel = nivelFinal - (cmH * (i * 15)) / 60 / 100 + ruido(i);
    leituras.push({ nivel: Number(nivel.toFixed(2)), medidoEm: new Date(t).toISOString() });
  }
  return leituras;
}

const BASE = { cota: 10, janelaHoras: 3, horizonteMaxH: 48 };

// ---------------------------------------------------------------------
// planejarEstimativaCota — as regras de geração da v2
// ---------------------------------------------------------------------

test('planejarEstimativaCota: cobertura insuficiente da janela não emite', () => {
  // Estação nova: só 1h de leituras numa janela de 3h (precisa de ≥ 1,5h).
  const leituras = serie({ horas: 1, nivelFinal: 8, cmH: 10 });
  const plano = planejarEstimativaCota({ ...BASE, leituras });
  assert.equal(plano.emitir, false);
  assert.equal(plano.motivo, 'cobertura_insuficiente');
});

test('planejarEstimativaCota: buraco de coleta (só as duas últimas leituras) não emite', () => {
  // Exatamente o par que a v1 usaria — e que bastava pra ela estimar.
  const leituras = [
    { nivel: 8.0, medidoEm: '2026-01-01T14:45:00Z' },
    { nivel: 8.05, medidoEm: '2026-01-01T15:00:00Z' },
  ];
  const plano = planejarEstimativaCota({ ...BASE, leituras });
  assert.equal(plano.emitir, false);
  assert.equal(plano.motivo, 'cobertura_insuficiente');
});

test('planejarEstimativaCota: uma leitura só, ou nenhuma, não emite', () => {
  assert.equal(planejarEstimativaCota({ ...BASE, leituras: [] }).motivo, 'sem_leitura');
  const uma = [{ nivel: 8, medidoEm: '2026-01-01T15:00:00Z' }];
  assert.equal(planejarEstimativaCota({ ...BASE, leituras: uma }).motivo, 'cobertura_insuficiente');
});

test('planejarEstimativaCota: horizonte acima de 48h não emite', () => {
  // 2 m de margem a 2 cm/h = 100h.
  const leituras = serie({ nivelFinal: 8, cmH: 2 });
  const plano = planejarEstimativaCota({ ...BASE, leituras });
  assert.equal(plano.emitir, false);
  assert.equal(plano.motivo, 'alem_do_horizonte');
  assert.ok(plano.horas > 48);
});

test('planejarEstimativaCota: exatamente 48h ainda emite (o teto é inclusivo)', () => {
  // 2,4 m de margem a 5 cm/h = 48h cravadas.
  const leituras = serie({ nivelFinal: 7.6, cmH: 5 });
  const plano = planejarEstimativaCota({ ...BASE, leituras });
  assert.equal(plano.emitir, true);
  assert.equal(plano.horas, 48);
});

test('planejarEstimativaCota: usa a velocidade SUSTENTADA, não o tremor das duas últimas', () => {
  // Subida real de 10 cm/h por 3h, mas a última leitura tremeu +5 cm. A
  // instantânea daria (5 + 2,5) cm em 15 min = 30 cm/h; a sustentada fica
  // perto dos 10 cm/h reais.
  const leituras = serie({ nivelFinal: 8, cmH: 10, ruido: (i) => (i === 0 ? 0.05 : 0) });
  const plano = planejarEstimativaCota({ ...BASE, leituras });
  assert.equal(plano.emitir, true);
  assert.equal(plano.classe, 'subindo');
  // (8,05 − 7,70) m em 3h = 11,7 cm/h.
  assert.equal(plano.velocidadeCmH, 11.7);
  assert.equal(plano.nivel, 8.05);
  assert.equal(plano.alvoNivel, 10);
  assert.ok(Math.abs(plano.horas - (195 / 11.7)) < 1e-9);
});

test('planejarEstimativaCota: descida sustentada gera "volta ao normal"', () => {
  // 9 m (90% da cota) descendo 10 cm/h: 3 m até 6 m = 30h.
  const leituras = serie({ nivelFinal: 9, cmH: -10 });
  const plano = planejarEstimativaCota({ ...BASE, leituras });
  assert.equal(plano.emitir, true);
  assert.equal(plano.classe, 'descendo');
  assert.equal(plano.alvoNivel, 6);
  assert.equal(plano.horas, 30);
});

test('planejarEstimativaCota: rio parado na janela não tem ETA', () => {
  const leituras = serie({ nivelFinal: 8, cmH: 0 });
  assert.equal(planejarEstimativaCota({ ...BASE, leituras }).motivo, 'sem_eta');
});

test('planejarEstimativaCota: ordem das leituras não importa', () => {
  const leituras = serie({ nivelFinal: 8, cmH: 10 });
  const a = planejarEstimativaCota({ ...BASE, leituras });
  const b = planejarEstimativaCota({ ...BASE, leituras: leituras.slice().reverse() });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------
// agregarAcertoPorVersao — v1 e v2 nunca se misturam
// ---------------------------------------------------------------------

test('agregarAcertoPorVersao: separa v1 de v2 e não soma as duas', () => {
  const avaliadas = [
    // v1: 1 acerto em 4, concentrada em horizonte longo (o viés que a v2 corrige).
    { estimadorVersao: 1, horasEstimadas: 3, resultado: 'acertou' },
    { estimadorVersao: 1, horasEstimadas: 100, resultado: 'errou' },
    { estimadorVersao: 1, horasEstimadas: 200, resultado: 'errou' },
    { estimadorVersao: 1, horasEstimadas: 480, resultado: 'errou' },
    // v2: 2 acertos em 3.
    { estimadorVersao: 2, horasEstimadas: 2, resultado: 'acertou' },
    { estimadorVersao: 2, horasEstimadas: 10, resultado: 'acertou' },
    { estimadorVersao: 2, horasEstimadas: 30, resultado: 'errou' },
  ];
  const r = agregarAcertoPorVersao(avaliadas, { 1: 0, 2: 5 });

  assert.deepEqual(r.map((v) => v.versao), [1, 2]);

  const [v1, v2] = r;
  assert.equal(v1.totalAvaliadas, 4);
  assert.equal(v1.acertos, 1);
  assert.equal(v1.taxa, 0.25);
  assert.equal(v1.pendentes, 0);
  assert.deepEqual(v1.porFaixa.map((f) => [f.total, f.acertos]), [[1, 1], [0, 0], [3, 0]]);

  assert.equal(v2.totalAvaliadas, 3);
  assert.equal(v2.acertos, 2);
  assert.equal(v2.taxa, 0.67);
  assert.equal(v2.pendentes, 5);
  assert.deepEqual(v2.porFaixa.map((f) => [f.total, f.acertos]), [[1, 1], [1, 1], [1, 0]]);
  assert.equal(v2.porFaixa[1].taxa, 1);
});

test('agregarAcertoPorVersao: versão só com pendentes aparece com taxa NULL', () => {
  const r = agregarAcertoPorVersao([{ estimadorVersao: 1, horasEstimadas: 3, resultado: 'errou' }], { 2: 7 });
  assert.equal(r.length, 2);
  assert.equal(r[1].versao, 2);
  assert.equal(r[1].totalAvaliadas, 0);
  assert.equal(r[1].pendentes, 7);
  assert.equal(r[1].taxa, null);
  assert.ok(r[1].porFaixa.every((f) => f.total === 0 && f.taxa === null));
});

test('agregarAcertoPorVersao: sem nada devolve lista vazia', () => {
  assert.deepEqual(agregarAcertoPorVersao([], {}), []);
});

// ---------------------------------------------------------------------
// Estratificação por sentido da variação
// ---------------------------------------------------------------------

test('classeVariacao: pelo sinal, sem faixa morta, NULL vira indefinido', () => {
  assert.equal(classeVariacao(0.1), 'subindo');
  assert.equal(classeVariacao('2.5'), 'subindo'); // NUMERIC chega como string do driver
  assert.equal(classeVariacao(-0.1), 'descendo');
  assert.equal(classeVariacao(0), 'estavel');
  assert.equal(classeVariacao('0.0'), 'estavel');
  assert.equal(classeVariacao(null), 'indefinido');
  assert.equal(classeVariacao(undefined), 'indefinido');
});

test('skill score estratificado: bate com o cálculo manual numa amostra sintética', () => {
  // Pares (tendencia, persistencia) do mesmo alvo, com a velocidade da emissão.
  // Erros em metros escolhidos pra dar contas redondas na mão.
  const pares = [
    // subindo: tendência erra 0,1 e 0,1; persistência erra 0,3 e 0,1.
    //   MSE_t = (0,01 + 0,01)/2 = 0,01; MSE_p = (0,09 + 0,01)/2 = 0,05
    //   SS = 1 − 0,01/0,05 = 0,8
    { v: 5, erroT: 0.1, erroP: 0.3 },
    { v: 12, erroT: -0.1, erroP: 0.1 },
    // descendo: tendência erra 0,3; persistência 0,1 → SS = 1 − 0,09/0,01 = −8
    { v: -3, erroT: 0.3, erroP: -0.1 },
    // estável: as duas projeções são iguais por construção → SS = 0
    { v: 0, erroT: 0.2, erroP: 0.2 },
    // indefinido: sem velocidade (tendência nem existiria; aqui só pra
    // provar que a linha não some nem contamina outra classe).
    { v: null, erroT: 0.5, erroP: 0.5 },
  ];

  const porClasse = new Map();
  for (const p of pares) {
    const c = classeVariacao(p.v);
    const acc = porClasse.get(c) ?? { n: 0, somaErro2Metodo: 0, somaErro2Persistencia: 0 };
    acc.n += 1;
    acc.somaErro2Metodo += p.erroT ** 2;
    acc.somaErro2Persistencia += p.erroP ** 2;
    porClasse.set(c, acc);
  }

  const ss = Object.fromEntries([...porClasse].map(([c, somas]) => [c, skillScore(somas)]));

  assert.equal(ss.subindo.nPareado, 2);
  assert.equal(ss.subindo.ss, 0.8);
  assert.equal(ss.descendo.nPareado, 1);
  assert.equal(ss.descendo.ss, -8);
  assert.equal(ss.estavel.ss, 0);
  assert.equal(ss.indefinido.nPareado, 1);

  // As classes particionam a amostra: o n estratificado soma o total.
  const nTotal = Object.values(ss).reduce((s, x) => s + x.nPareado, 0);
  assert.equal(nTotal, pares.length);

  // E o SS agregado NÃO é a média dos estratificados — por isso os dois
  // existem lado a lado na rota.
  const agregado = skillScore({
    n: pares.length,
    somaErro2Metodo: pares.reduce((s, p) => s + p.erroT ** 2, 0),
    somaErro2Persistencia: pares.reduce((s, p) => s + p.erroP ** 2, 0),
  });
  // Σerro² = 0,40 nos dois métodos → SS 0: o ganho subindo e a perda
  // descendo se anulam no agregado, exatamente o que a estratificação revela.
  // (abs porque o arredondamento pode devolver −0.)
  assert.ok(Math.abs(agregado.ss) < 1e-9);
});

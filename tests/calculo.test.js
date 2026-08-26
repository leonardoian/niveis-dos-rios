import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classificar, calcularVelocidade, calcularFrescor, calcularVariacao24h, calcularEtaCota, avaliarEstimativa, calcularSubidaSustentada, projetarNivel, somarProjecoes, metricasProjecao } from '../lib/calculo.js';

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

// ---- avaliarEstimativa: tolerância dos DOIS lados ----
// Cenário base: estimativa de 40h pra cota 10m numa estação subindo, com 8h
// de tolerância (20% do horizonte, teto de 12h). Janela de acerto =
// [+32h, +48h] contadas do cálculo.
const T0 = Date.parse('2026-08-01T00:00:00Z');
const ALVO = new Date(T0 + 40 * 3_600_000).toISOString();
const emH = (h) => new Date(T0 + h * 3_600_000).toISOString();
const base = { classe: 'subindo', alvoNivel: 10, alvoEm: ALVO, toleranciaHoras: 8 };

test('avaliarEstimativa: cruzou na hora prevista, acertou com erro pequeno', () => {
  const r = avaliarEstimativa({ ...base, leituras: [
    { nivel: 8.0, medidoEm: emH(20) },
    { nivel: 9.5, medidoEm: emH(38) },
    { nivel: 10.2, medidoEm: emH(41) },
  ]});
  assert.equal(r.resultado, 'acertou');
  assert.equal(r.erroHoras, 1);
});

test('avaliarEstimativa: cruzou cedo demais e recuou antes da janela — errou (bug corrigido)', () => {
  // Antes valia [previsto_em, alvo_em + tol]: isto contava como "acertou"
  // com erro_horas = −39, inflando a faixa "mais de 24h".
  const r = avaliarEstimativa({ ...base, leituras: [
    { nivel: 10.4, medidoEm: emH(1) },   // pico isolado, 39h adiantado
    { nivel: 6.0, medidoEm: emH(10) },
    { nivel: 5.5, medidoEm: emH(40) },   // na hora prevista, longe do alvo
    { nivel: 5.4, medidoEm: emH(47) },
  ]});
  assert.equal(r.resultado, 'errou');
  assert.equal(r.erroHoras, null);
  assert.equal(r.nivelRealNoAlvo, 5.5);
});

test('avaliarEstimativa: cruzou cedo mas CONTINUOU lá na hora prevista — acertou, com o erro de ritmo real', () => {
  const r = avaliarEstimativa({ ...base, leituras: [
    { nivel: 10.4, medidoEm: emH(1) },   // cruzou 39h adiantado...
    { nivel: 11.0, medidoEm: emH(35) },  // ...e seguiu acima dentro da janela
    { nivel: 11.2, medidoEm: emH(41) },
  ]});
  assert.equal(r.resultado, 'acertou');
  // erroHoras vem do cruzamento REAL, não do começo da janela (−8):
  assert.equal(r.erroHoras, -39);
});

test('avaliarEstimativa: nunca chegou ao alvo — errou', () => {
  const r = avaliarEstimativa({ ...base, leituras: [
    { nivel: 7.0, medidoEm: emH(20) },
    { nivel: 8.5, medidoEm: emH(40) },
    { nivel: 9.1, medidoEm: emH(47) },
  ]});
  assert.equal(r.resultado, 'errou');
  assert.equal(r.nivelRealNoAlvo, 8.5);
});

test('avaliarEstimativa: limites da janela são inclusivos nas duas pontas', () => {
  const cedo = avaliarEstimativa({ ...base, leituras: [{ nivel: 10, medidoEm: emH(32) }] });
  assert.equal(cedo.resultado, 'acertou', 'alvo_em − tolerância conta');

  const tarde = avaliarEstimativa({ ...base, leituras: [{ nivel: 10, medidoEm: emH(48) }] });
  assert.equal(tarde.resultado, 'acertou', 'alvo_em + tolerância conta');

  const cedoDemais = avaliarEstimativa({ ...base, leituras: [{ nivel: 10, medidoEm: emH(31.9) }] });
  assert.equal(cedoDemais.resultado, 'errou', 'um pouco antes da janela não conta');
});

test('avaliarEstimativa: classe descendo inverte a comparação', () => {
  const desc = { classe: 'descendo', alvoNivel: 6, alvoEm: ALVO, toleranciaHoras: 8 };
  const acertou = avaliarEstimativa({ ...desc, leituras: [{ nivel: 5.8, medidoEm: emH(39) }] });
  assert.equal(acertou.resultado, 'acertou');

  const errou = avaliarEstimativa({ ...desc, leituras: [{ nivel: 6.3, medidoEm: emH(39) }] });
  assert.equal(errou.resultado, 'errou');
});

test('avaliarEstimativa: ordena internamente e aguenta lista vazia', () => {
  const foraDeOrdem = avaliarEstimativa({ ...base, leituras: [
    { nivel: 10.2, medidoEm: emH(41) },
    { nivel: 8.0, medidoEm: emH(20) },
  ]});
  assert.equal(foraDeOrdem.resultado, 'acertou');
  assert.equal(foraDeOrdem.erroHoras, 1);

  const vazia = avaliarEstimativa({ ...base, leituras: [] });
  assert.deepEqual(vazia, { resultado: 'errou', erroHoras: null, nivelRealNoAlvo: null });
});

// ---- calcularSubidaSustentada: base do alerta de subida rápida ----
const H0 = Date.parse('2026-08-01T00:00:00Z');
const leitura = (h, nivel) => ({ nivel, medidoEm: new Date(H0 + h * 3_600_000).toISOString() });

test('calcularSubidaSustentada: subida constante de 60cm em 3h = 20 cm/h', () => {
  assert.equal(calcularSubidaSustentada([leitura(0, 5.0), leitura(1.5, 5.3), leitura(3, 5.6)], 3), 20);
});

test('calcularSubidaSustentada: descida vira número negativo', () => {
  assert.equal(calcularSubidaSustentada([leitura(0, 5.6), leitura(3, 5.0)], 3), -20);
});

test('calcularSubidaSustentada: usa as pontas da janela, não as duas últimas leituras', () => {
  // Sobe 60cm ao longo das 3h, mas a ÚLTIMA dupla é plana — é exatamente o
  // caso em que calcularVelocidade daria ~0 e não alertaria numa subida real.
  const r = calcularSubidaSustentada([
    leitura(0, 5.0), leitura(1, 5.3), leitura(2, 5.58), leitura(2.75, 5.6), leitura(3, 5.6),
  ], 3);
  assert.equal(r, 20);
});

test('calcularSubidaSustentada: oscilação de instrumento não vira subida', () => {
  // Vai e volta: as pontas quase empatam, mesmo com ruído no meio.
  const r = calcularSubidaSustentada([
    leitura(0, 5.00), leitura(1, 5.12), leitura(2, 4.94), leitura(3, 5.01),
  ], 3);
  assert.ok(Math.abs(r) < 1, `esperava ~0 cm/h, veio ${r}`);
});

test('calcularSubidaSustentada: cobertura curta demais da janela retorna null', () => {
  // 1h de leituras numa janela de 3h: pode ser estação nova ou buraco de
  // coleta — não dá pra afirmar ritmo sustentado.
  assert.equal(calcularSubidaSustentada([leitura(2, 5.0), leitura(3, 5.6)], 3), null);
});

test('calcularSubidaSustentada: exatamente metade da janela é aceito (limite)', () => {
  assert.equal(calcularSubidaSustentada([leitura(1.5, 5.0), leitura(3, 5.3)], 3), 20);
});

test('calcularSubidaSustentada: menos de 2 leituras ou instante repetido retorna null', () => {
  assert.equal(calcularSubidaSustentada([leitura(0, 5)], 3), null);
  assert.equal(calcularSubidaSustentada([], 3), null);
  assert.equal(calcularSubidaSustentada(null, 3), null);
  assert.equal(calcularSubidaSustentada([leitura(3, 5.0), leitura(3, 5.6)], 3), null);
});

test('calcularSubidaSustentada: ordena internamente', () => {
  assert.equal(calcularSubidaSustentada([leitura(3, 5.6), leitura(0, 5.0)], 3), 20);
});

// ---------------------------------------------------------------------
// projetarNivel — nível previsto por horizonte fixo (ver projecoes_nivel
// em schema.sql). O que mais importa nestes testes é o que a função NÃO
// faz: não suaviza, não trava em zero, não trata caso especial. É o que
// mantém a persistência utilizável como linha de base.
// ---------------------------------------------------------------------

test('projetarNivel: persistência devolve o nível atual, em qualquer horizonte', () => {
  for (const horizonteH of [6, 12, 24, 48]) {
    assert.equal(projetarNivel({ nivel: 12.34, velocidadeCmH: 0, horizonteH, metodo: 'persistencia' }), 12.34);
  }
});

test('projetarNivel: persistência ignora a velocidade (é o ponto da linha de base)', () => {
  const base = { nivel: 12.34, horizonteH: 24, metodo: 'persistencia' };
  assert.equal(projetarNivel({ ...base, velocidadeCmH: 50 }), 12.34);
  assert.equal(projetarNivel({ ...base, velocidadeCmH: -50 }), 12.34);
  // Inclusive sem velocidade nenhuma: persistência não precisa dela.
  assert.equal(projetarNivel({ ...base, velocidadeCmH: null }), 12.34);
});

test('projetarNivel: tendência extrapola linear — 10 cm/h por 6h sobe 60 cm', () => {
  assert.equal(projetarNivel({ nivel: 12.00, velocidadeCmH: 10, horizonteH: 6, metodo: 'tendencia' }), 12.6);
});

test('projetarNivel: tendência com velocidade zero cai no mesmo valor da persistência', () => {
  const args = { nivel: 12.34, velocidadeCmH: 0, horizonteH: 24 };
  assert.equal(
    projetarNivel({ ...args, metodo: 'tendencia' }),
    projetarNivel({ ...args, metodo: 'persistencia' })
  );
});

test('projetarNivel: velocidade negativa projeta descida', () => {
  assert.equal(projetarNivel({ nivel: 12.00, velocidadeCmH: -10, horizonteH: 12, metodo: 'tendencia' }), 10.8);
});

test('projetarNivel: descida longa pode projetar nível negativo — sem clamp, de propósito', () => {
  // 20 cm/h por 48h = 9,6 m de queda sobre um rio a 2 m. É absurdo, e tem
  // que aparecer assim: travar em zero esconderia o erro da extrapolação
  // dentro da própria projeção em vez de deixá-lo chegar na métrica.
  assert.equal(projetarNivel({ nivel: 2.00, velocidadeCmH: -20, horizonteH: 48, metodo: 'tendencia' }), -7.6);
});

test('projetarNivel: tendência sem velocidade utilizável retorna null', () => {
  const base = { nivel: 12.00, horizonteH: 24, metodo: 'tendencia' };
  assert.equal(projetarNivel({ ...base, velocidadeCmH: null }), null);
  assert.equal(projetarNivel({ ...base, velocidadeCmH: undefined }), null);
  assert.equal(projetarNivel({ ...base, velocidadeCmH: NaN }), null);
});

test('projetarNivel: sem nível, horizonte não positivo ou método desconhecido retorna null', () => {
  assert.equal(projetarNivel({ nivel: null, velocidadeCmH: 5, horizonteH: 24, metodo: 'persistencia' }), null);
  assert.equal(projetarNivel({ nivel: 12, velocidadeCmH: 5, horizonteH: 0, metodo: 'persistencia' }), null);
  assert.equal(projetarNivel({ nivel: 12, velocidadeCmH: 5, horizonteH: -6, metodo: 'tendencia' }), null);
  assert.equal(projetarNivel({ nivel: 12, velocidadeCmH: 5, horizonteH: 24, metodo: 'media_movel' }), null);
});

test('projetarNivel: curva não é calculada aqui (vem de previsoes.nivel_estimado_m)', () => {
  assert.equal(projetarNivel({ nivel: 12, velocidadeCmH: 5, horizonteH: 24, metodo: 'curva' }), null);
});

// ---------------------------------------------------------------------
// Métricas de erro — somarProjecoes é o espelho em JS do GROUP BY de
// /api/projecoes, metricasProjecao é a derivação que a rota usa em cima
// das somas que o Postgres devolve.
// ---------------------------------------------------------------------

const metricasDe = (pares) => metricasProjecao(somarProjecoes(pares));

test('metricasProjecao: previsão perfeita zera MAE, RMSE e viés, e dá NSE 1', () => {
  const m = metricasDe([
    { nivelPrevisto: 10, nivelReal: 10 },
    { nivelPrevisto: 11, nivelReal: 11 },
    { nivelPrevisto: 12, nivelReal: 12 },
  ]);
  assert.equal(m.n, 3);
  assert.equal(m.maeM, 0);
  assert.equal(m.rmseM, 0);
  assert.equal(m.viesM, 0);
  assert.equal(m.nse, 1);
});

test('metricasProjecao: valores conferidos na mão', () => {
  // erros (real − previsto): +0,5 / −1,0 / 0 / −0,5
  const m = metricasDe([
    { nivelPrevisto: 10.0, nivelReal: 10.5 },
    { nivelPrevisto: 11.0, nivelReal: 10.0 },
    { nivelPrevisto: 12.0, nivelReal: 12.0 },
    { nivelPrevisto: 13.0, nivelReal: 12.5 },
  ]);
  assert.equal(m.n, 4);
  assert.equal(m.maeM, 0.5);                              // (0,5+1+0+0,5)/4
  assert.equal(m.rmseM, Number(Math.sqrt(0.375).toFixed(3))); // √((0,25+1+0+0,25)/4)
  assert.equal(m.viesM, -0.25);                           // (0,5−1+0−0,5)/4
  assert.equal(m.nse, 0.647);                             // 1 − 1,5/4,25
  assert.ok(m.rmseM > m.maeM, 'RMSE deve punir o erro grande mais que o MAE');
});

test('metricasProjecao: viés guarda o sinal — previsão sempre baixa dá viés positivo', () => {
  const m = metricasDe([
    { nivelPrevisto: 10.0, nivelReal: 10.2 },
    { nivelPrevisto: 11.0, nivelReal: 11.2 },
    { nivelPrevisto: 12.0, nivelReal: 12.2 },
  ]);
  assert.equal(m.viesM, 0.2);
  assert.equal(m.maeM, 0.2); // mesma magnitude: erro inteiramente sistemático
});

test('metricasProjecao: viés some quando o erro é simétrico, mas o MAE não', () => {
  const m = metricasDe([
    { nivelPrevisto: 10.0, nivelReal: 10.3 },
    { nivelPrevisto: 11.0, nivelReal: 10.7 },
  ]);
  assert.equal(m.viesM, 0);
  assert.equal(m.maeM, 0.3);
});

test('metricasProjecao: prever sempre a média das observações dá NSE 0', () => {
  // É a definição do NSE: 0 = tão bom quanto ter chutado a média do período.
  const m = metricasDe([
    { nivelPrevisto: 11.5, nivelReal: 10 },
    { nivelPrevisto: 11.5, nivelReal: 11 },
    { nivelPrevisto: 11.5, nivelReal: 12 },
    { nivelPrevisto: 11.5, nivelReal: 13 },
  ]);
  assert.equal(m.nse, 0);
});

test('metricasProjecao: previsão pior que a média das observações dá NSE negativo', () => {
  const m = metricasDe([
    { nivelPrevisto: 20, nivelReal: 10 },
    { nivelPrevisto: 2, nivelReal: 11 },
    { nivelPrevisto: 20, nivelReal: 12 },
    { nivelPrevisto: 2, nivelReal: 13 },
  ]);
  assert.ok(m.nse < 0, `NSE deveria ser negativo, veio ${m.nse}`);
});

test('metricasProjecao: observações sem variação deixam o NSE NULL (indefinido)', () => {
  // Rio parado no mesmo nível: a variância das observações é zero e o NSE
  // não existe. Devolver 0 ou 1 aqui inventaria um veredito.
  const m = metricasDe([
    { nivelPrevisto: 10.1, nivelReal: 10 },
    { nivelPrevisto: 9.9, nivelReal: 10 },
  ]);
  assert.equal(m.nse, null);
  assert.equal(m.maeM, 0.1); // as outras métricas continuam válidas
});

test('somarProjecoes: descarta projeção sem leitura no alvo (erro_m NULL no banco)', () => {
  const somas = somarProjecoes([
    { nivelPrevisto: 10, nivelReal: 10.5 },
    { nivelPrevisto: 11, nivelReal: null },   // não houve leitura em ±30 min
    { nivelPrevisto: 12, nivelReal: undefined },
  ]);
  assert.equal(somas.n, 1);
  assert.equal(metricasProjecao(somas).maeM, 0.5);
});

test('metricasProjecao: grupo vazio devolve n 0 e métricas NULL, sem quebrar', () => {
  const m = metricasDe([]);
  assert.deepEqual(m, { n: 0, maeM: null, rmseM: null, viesM: null, nse: null });
  assert.deepEqual(metricasProjecao(null), { n: 0, maeM: null, rmseM: null, viesM: null, nse: null });
});

test('agregação por método × horizonte: a comparação que /api/projecoes faz', () => {
  // Rio subindo 10 cm/h de verdade, projeções de 24h emitidas em 4 rodadas.
  // Persistência erra os 2,40 m inteiros da subida; a tendência acerta.
  const subida = [
    { nivel: 10.0, real: 12.4 },
    { nivel: 10.5, real: 12.9 },
    { nivel: 11.0, real: 13.4 },
    { nivel: 11.5, real: 13.9 },
  ];
  const porMetodo = (metodo) =>
    metricasDe(subida.map((r) => ({
      nivelPrevisto: projetarNivel({ nivel: r.nivel, velocidadeCmH: 10, horizonteH: 24, metodo }),
      nivelReal: r.real,
    })));

  const persistencia = porMetodo('persistencia');
  const tendencia = porMetodo('tendencia');

  assert.equal(persistencia.n, 4);
  assert.equal(persistencia.rmseM, 2.4);
  assert.equal(persistencia.viesM, 2.4);  // previu baixo demais, sistematicamente
  assert.equal(tendencia.rmseM, 0);
  assert.equal(tendencia.nse, 1);
  assert.ok(tendencia.rmseM < persistencia.rmseM);
});

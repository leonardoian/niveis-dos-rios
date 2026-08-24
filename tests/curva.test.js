import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ajustarCurva, estimarNivel, curvaConfiavel, MINIMO_PARES, MINIMO_R2 } from '../lib/curva.js';

// Gera pares que seguem exatamente h = a·Q^b, pra conferir se o ajuste
// recupera os parâmetros que geraram os dados.
function paresDeLeiPotencia(a, b, vazoes) {
  return vazoes.map((q) => ({ vazaoM3s: q, nivelM: a * Math.pow(q, b) }));
}
const VAZOES = Array.from({ length: 40 }, (_, i) => 100 + i * 25);

test('ajustarCurva: recupera os parâmetros de uma lei de potência limpa', () => {
  const c = ajustarCurva(paresDeLeiPotencia(0.5, 0.4, VAZOES));
  assert.ok(Math.abs(Math.exp(c.alfa) - 0.5) < 1e-6, `a ≈ 0.5, veio ${Math.exp(c.alfa)}`);
  assert.ok(Math.abs(c.beta - 0.4) < 1e-9, `b ≈ 0.4, veio ${c.beta}`);
  assert.equal(c.r2, 1);
  assert.ok(c.erroMedioM < 1e-6);
  assert.equal(c.n, 40);
});

test('ajustarCurva: registra a faixa de vazão observada', () => {
  const c = ajustarCurva(paresDeLeiPotencia(0.5, 0.4, VAZOES));
  assert.equal(c.vazaoMinM3s, 100);
  assert.equal(c.vazaoMaxM3s, 1075);
});

test('ajustarCurva: ruído derruba o R² sem quebrar o ajuste', () => {
  const pares = paresDeLeiPotencia(0.5, 0.4, VAZOES).map((p, i) => ({
    ...p, nivelM: p.nivelM * (1 + (i % 2 === 0 ? 0.25 : -0.25)),
  }));
  const c = ajustarCurva(pares);
  assert.ok(c.r2 < 0.9, `R² deveria cair com ruído, veio ${c.r2}`);
  assert.ok(c.erroMedioM > 0, 'erro em metros deve ser positivo');
});

test('ajustarCurva: descarta vazão ou nível não-positivos em vez de somar epsilon', () => {
  const c = ajustarCurva([
    ...paresDeLeiPotencia(0.5, 0.4, VAZOES),
    { vazaoM3s: 0, nivelM: 2 },
    { vazaoM3s: 500, nivelM: 0 },
    { vazaoM3s: -3, nivelM: 4 },
  ]);
  assert.equal(c.n, 40, 'os 3 inválidos saem da conta');
});

test('ajustarCurva: menos de 3 pares válidos retorna null', () => {
  assert.equal(ajustarCurva([{ vazaoM3s: 100, nivelM: 5 }]), null);
  assert.equal(ajustarCurva([]), null);
  assert.equal(ajustarCurva(null), null);
});

test('ajustarCurva: vazão constante retorna null (sem inclinação definida)', () => {
  assert.equal(ajustarCurva([
    { vazaoM3s: 500, nivelM: 5 }, { vazaoM3s: 500, nivelM: 6 }, { vazaoM3s: 500, nivelM: 7 },
  ]), null);
});

test('ajustarCurva: nível constante dá r2 null em vez de fingir ajuste perfeito', () => {
  const c = ajustarCurva([
    { vazaoM3s: 100, nivelM: 5 }, { vazaoM3s: 200, nivelM: 5 }, { vazaoM3s: 300, nivelM: 5 },
  ]);
  assert.equal(c.r2, null);
  assert.equal(curvaConfiavel(c), false);
});

test('estimarNivel: dentro da faixa, devolve o nível da lei de potência', () => {
  const c = ajustarCurva(paresDeLeiPotencia(0.5, 0.4, VAZOES));
  const esperado = 0.5 * Math.pow(600, 0.4);
  assert.equal(estimarNivel(c, 600), Number(esperado.toFixed(2)));
});

test('estimarNivel: recusa extrapolar fora da faixa ajustada', () => {
  const c = ajustarCurva(paresDeLeiPotencia(0.5, 0.4, VAZOES));
  assert.equal(estimarNivel(c, 50), null, 'abaixo do mínimo observado');
  assert.equal(estimarNivel(c, 5000), null, 'acima do máximo — é numa cheia que erraria feio');
  assert.equal(estimarNivel(c, 100), Number((0.5 * Math.pow(100, 0.4)).toFixed(2)), 'o limite exato vale');
});

test('estimarNivel: curva fraca não publica número', () => {
  const poucos = ajustarCurva(paresDeLeiPotencia(0.5, 0.4, [100, 200, 300]));
  assert.equal(poucos.n, 3);
  assert.equal(curvaConfiavel(poucos), false, `n=3 < ${MINIMO_PARES}`);
  assert.equal(estimarNivel(poucos, 200), null);
});

test('estimarNivel: R² abaixo do mínimo não publica número', () => {
  const fraca = { alfa: 0, beta: 0.4, n: MINIMO_PARES + 10, r2: MINIMO_R2 - 0.01, erroMedioM: 2, vazaoMinM3s: 1, vazaoMaxM3s: 1000 };
  assert.equal(curvaConfiavel(fraca), false);
  assert.equal(estimarNivel(fraca, 500), null);
  assert.equal(curvaConfiavel({ ...fraca, r2: MINIMO_R2 }), true, 'o limite exato vale');
});

test('estimarNivel: entrada inválida ou curva ausente retorna null', () => {
  const c = ajustarCurva(paresDeLeiPotencia(0.5, 0.4, VAZOES));
  assert.equal(estimarNivel(null, 500), null);
  assert.equal(estimarNivel(c, 0), null);
  assert.equal(estimarNivel(c, -1), null);
  assert.equal(estimarNivel(c, NaN), null);
});

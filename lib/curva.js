// Curva empírica vazão → nível, ajustada por estação a partir do nosso
// próprio histórico. Puro: sem I/O, testado em tests/curva.test.js — quem
// busca os pares e grava os coeficientes é ajustarCurvas em lib/coletar.js.
//
// ---------------------------------------------------------------------
// O QUE ISTO É, E O QUE NÃO É
//
// O README sempre disse, e continua verdade: converter vazão em nível "de
// verdade" exige a curva-chave da estação, que não temos. Isto NÃO é uma
// curva-chave.
//
// É uma regressão sobre dados que já estão no banco: para cada dia passado,
// a vazão que o GloFAS/Open-Meteo estimou pra aquele dia (previsoes.vazao_m3s)
// contra o nível que a estação REALMENTE mediu (média diária de leituras).
// O que ela ajusta, portanto, é a composição de duas coisas ao mesmo tempo:
// a relação física vazão-nível daquela régua E o viés do modelo naquele
// ponto da grade. Fisicamente é impuro. Mas o objetivo aqui não é
// interpretação física, é valor preditivo: "quando o GloFAS diz 800 m³/s
// aqui, esta estação historicamente marcou ~12 m".
//
// A vantagem prática é grande: a vazão prevista é hoje o único número do
// painel que não dá pra conferir — não temos medição independente de vazão,
// só outro resultado do mesmo modelo. Convertida em nível, ela vira
// falsificável, porque nível a gente mede. Por isso a curva carrega os
// números de qualidade dela junto (r2, erroMedioM, n) e o painel só mostra
// a estimativa quando eles passam de um mínimo.
//
// ---------------------------------------------------------------------
// FORMA DO MODELO
//
// A relação vazão-nível em hidrologia é tipicamente uma lei de potência
// (h = a·Q^b). Em log-log ela vira reta, então o ajuste é um mínimos
// quadrados comum sobre ln(Q) × ln(h) — solução fechada, sem iteração, sem
// dependência nova. Fica com dois parâmetros só, o que é proposital: com
// poucas dezenas de pontos diários e ruído dos dois lados, um modelo mais
// flexível decoraria o ruído em vez da relação.

// Mínimo pra publicar uma estimativa. Não são universais — são a fronteira
// entre "informação" e "número bonito sem lastro", e ficam aqui em cima
// justamente pra serem fáceis de rever quando houver mais histórico.
export const MINIMO_PARES = 30;   // ~1 mês de dias com as duas pontas
export const MINIMO_R2 = 0.5;

// Variância mínima (em log) pra considerar que a amostra varia de verdade.
// 1e-12 em log ≈ variação relativa de 1 parte em 1e6 — muito abaixo de
// qualquer sinal real, muito acima do lixo de ponto flutuante.
const VARIACAO_MINIMA = 1e-12;

// pares: [{vazaoM3s, nivelM}]. Devolve null quando não dá pra ajustar nada
// (poucos pontos, ou vazão/nível não-positivos que o log não aceita).
export function ajustarCurva(pares) {
  // ln() exige os dois lados positivos. Nível é altura acima do zero da
  // régua, então normalmente é > 0 — mas uma estação pode registrar 0,00
  // em seca, e vazão 0 aparece em modelo. Descartar é mais honesto que
  // somar um epsilon arbitrário, que deslocaria a curva inteira.
  const validos = (pares || []).filter(
    (p) => Number.isFinite(p.vazaoM3s) && Number.isFinite(p.nivelM) && p.vazaoM3s > 0 && p.nivelM > 0
  );
  if (validos.length < 3) return null;

  const xs = validos.map((p) => Math.log(p.vazaoM3s));
  const ys = validos.map((p) => Math.log(p.nivelM));
  const n = validos.length;
  const mediaX = xs.reduce((a, b) => a + b, 0) / n;
  const mediaY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mediaX) * (ys[i] - mediaY);
    sxx += (xs[i] - mediaX) ** 2;
  }
  // Vazão (quase) constante em toda a amostra: reta vertical, sem
  // inclinação definida. Acontece de verdade em estação cuja célula do
  // modelo mal varia — e é exatamente o caso em que não há nada a aprender.
  //
  // Testar `sxx === 0` NÃO basta: com todos os x iguais, (x+x+x)/3 não
  // devolve exatamente x em ponto flutuante, então sxx vira ~1e-32 e
  // beta = sxy/sxx explode pra um número qualquer que parece um ajuste
  // legítimo. A comparação é em variância relativa (sxx/n) contra uma
  // tolerância, não contra zero.
  if (sxx / n < VARIACAO_MINIMA) return null;

  const beta = sxy / sxx;
  const alfa = mediaY - beta * mediaX;

  // R² no espaço log (é onde o ajuste acontece) e erro médio absoluto em
  // METROS (é onde a pessoa lê). Os dois, porque um R² alto pode conviver
  // com erro grande em metros quando a estação tem faixa de nível larga —
  // e é o erro em metros que diz se a estimativa serve pra alguma coisa.
  let ssRes = 0;
  let ssTot = 0;
  let somaErroAbs = 0;
  for (let i = 0; i < n; i++) {
    const previstoLog = alfa + beta * xs[i];
    ssRes += (ys[i] - previstoLog) ** 2;
    ssTot += (ys[i] - mediaY) ** 2;
    somaErroAbs += Math.abs(Math.exp(previstoLog) - validos[i].nivelM);
  }

  return {
    alfa,
    beta,
    n,
    // Níveis todos iguais: R² não é definido, e reportar 1 ("ajuste
    // perfeito") seria mentira conveniente. Mesma tolerância de sxx, pelo
    // mesmo motivo de ponto flutuante.
    r2: ssTot / n < VARIACAO_MINIMA ? null : Number((1 - ssRes / ssTot).toFixed(4)),
    erroMedioM: Number((somaErroAbs / n).toFixed(3)),
    vazaoMinM3s: Math.min(...validos.map((p) => p.vazaoM3s)),
    vazaoMaxM3s: Math.max(...validos.map((p) => p.vazaoM3s)),
  };
}

// Aplica a curva. null quando a curva não existe, não é confiável o
// bastante, ou a vazão está fora da faixa em que a curva foi ajustada —
// extrapolar uma lei de potência pra fora do observado é onde ela erra
// feio, e numa cheia (justamente quando importa) o erro seria pra cima.
export function estimarNivel(curva, vazaoM3s) {
  if (!curva || !Number.isFinite(vazaoM3s) || vazaoM3s <= 0) return null;
  if (!curvaConfiavel(curva)) return null;
  if (vazaoM3s < curva.vazaoMinM3s || vazaoM3s > curva.vazaoMaxM3s) return null;

  const nivel = Math.exp(curva.alfa + curva.beta * Math.log(vazaoM3s));
  return Number.isFinite(nivel) ? Number(nivel.toFixed(2)) : null;
}

export function curvaConfiavel(curva) {
  return Boolean(curva) && curva.n >= MINIMO_PARES && curva.r2 !== null && curva.r2 >= MINIMO_R2;
}

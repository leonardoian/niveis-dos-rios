// Funções puras de cálculo usadas pelo painel — sem I/O (nada de sql/fetch
// aqui), pra poderem ser testadas isoladas em tests/calculo.test.js sem
// precisar de DATABASE_URL nem de banco de verdade.

export function classificar(nivel, cota) {
  if (nivel === null) return 'sem_dado';
  const razao = nivel / cota;
  if (razao >= 1) return 'alagado';
  if (razao >= 0.8) return 'alerta';
  if (razao >= 0.6) return 'atencao';
  return 'normal';
}

// cm/h = (variação em metros × 100) / horas decorridas
export function calcularVelocidade(nivelAtual, nivelAnterior, medidoEm, medidoEmAnterior) {
  if (nivelAtual === null || nivelAnterior === null) return null;
  const horas = (new Date(medidoEm) - new Date(medidoEmAnterior)) / 3_600_000;
  if (horas <= 0) return null;
  return ((nivelAtual - nivelAnterior) * 100) / horas;
}

// Variação de nível em cm entre agora e ~24h atrás (pro KPI "maior subida em
// 24h" no painel). Diferente de calcularVelocidade: não é uma taxa (cm/h)
// entre duas leituras consecutivas, é uma diferença simples entre dois
// pontos fixos no tempo. null quando falta uma das duas leituras — nunca
// aproxima com outra janela pra não fingir um dado de 24h que não temos
// (ex.: estação nova, sem 24h de histórico ainda).
export function calcularVariacao24h(nivelAtual, nivel24hAtras) {
  if (nivelAtual === null || nivel24hAtras === null) return null;
  return Number(((nivelAtual - nivel24hAtras) * 100).toFixed(1));
}

// Mesma extrapolação linear simples usada no card/modal do painel
// (renderizarEstimativaCota em public/js/painel.js) — "no ritmo atual, quanto
// falta pra cota (subindo) ou pra voltar ao normal (descendo)". Reimplementada
// aqui, em vez de importada, porque public/js/painel.js é um script solto sem
// bundler (não dá pra fazer import de lib/); as duas cópias fazem a MESMA
// conta e são cobertas por teste dos dois lados. Esta versão devolve também
// `alvoNivel` (o nível numérico que precisa ser cruzado) — o front não
// precisa disso pra exibir o texto, mas lib/coletar.js precisa pra poder
// arquivar a previsão e conferir depois se o nível real cruzou esse valor.
export function calcularEtaCota(nivel, cota, margem, velocidadeCmH, percentualCota) {
  if (nivel === null || cota === null || margem === null || velocidadeCmH === null) return null;

  if (velocidadeCmH > 0) {
    if (margem <= 0) return null; // já atingiu/passou a cota
    const horas = (margem * 100) / velocidadeCmH;
    if (!Number.isFinite(horas) || horas <= 0) return null;
    return { classe: 'subindo', horas, alvoNivel: cota };
  }

  if (velocidadeCmH < 0) {
    if (percentualCota === null || percentualCota < 60) return null; // já está normal
    const nivelNormal = cota * 0.6;
    const margemAteNormal = nivel - nivelNormal;
    const horas = (margemAteNormal * 100) / Math.abs(velocidadeCmH);
    if (!Number.isFinite(horas) || horas <= 0) return null;
    return { classe: 'descendo', horas, alvoNivel: nivelNormal };
  }

  return null;
}

// Frescor de UMA leitura específica — mais granular que o "ultimaColeta"
// global: uma estação pode estar atrasada mesmo com a coleta geral em dia
// (ex.: o feed parou de atualizar só aquela estação). `agora` é injetável
// pra dar pra testar sem depender do relógio real.
export function calcularFrescor(medidoEm, agora = Date.now()) {
  if (!medidoEm) return { status: 'sem_dado', idadeSegundos: null };

  const idadeSegundos = Math.round((agora - new Date(medidoEm).getTime()) / 1000);
  let status;
  if (idadeSegundos <= 20 * 60) status = 'ao_vivo';
  else if (idadeSegundos <= 60 * 60) status = 'atrasado';
  else status = 'obsoleto';

  return { status, idadeSegundos };
}

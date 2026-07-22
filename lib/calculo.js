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

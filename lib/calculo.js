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

// Velocidade média SUSTENTADA numa janela, em cm/h — base do alerta de
// subida rápida (registrarAlertasSubida em lib/coletar.js).
//
// De propósito NÃO reusa calcularVelocidade: aquela mede entre as duas
// últimas leituras, e o próprio README já documenta que isso "pode ficar
// zerada mesmo com uma tendência clara ao longo do dia (flutuação normal do
// instrumento entre duas leituras consecutivas)". Ruído aceitável pra um
// número exibido no card, inaceitável pra disparar notificação: alertaria
// por oscilação de instrumento e silenciaria numa subida real e constante.
//
// Aqui a conta é entre a leitura mais recente e a mais antiga da janela —
// uma subida precisa se sustentar por horas pra contar.
//
// leituras: [{nivel, medidoEm}] em qualquer ordem. null quando não dá pra
// afirmar nada: menos de 2 leituras, ou span curto demais em relação à
// janela pedida (estação nova, ou buraco de coleta — em vez de dividir uma
// diferença real por um intervalo que não representa a janela).
export function calcularSubidaSustentada(leituras, janelaHoras, coberturaMinima = 0.5) {
  const ordenadas = (leituras || [])
    .slice()
    .sort((a, b) => new Date(a.medidoEm) - new Date(b.medidoEm));
  if (ordenadas.length < 2) return null;

  const primeira = ordenadas[0];
  const ultima = ordenadas[ordenadas.length - 1];
  const horas = (new Date(ultima.medidoEm) - new Date(primeira.medidoEm)) / 3_600_000;
  if (horas <= 0) return null;
  if (horas < janelaHoras * coberturaMinima) return null;

  return Number((((ultima.nivel - primeira.nivel) * 100) / horas).toFixed(1));
}

// Veredito de uma estimativa arquivada, conferida contra as leituras REAIS
// que vieram depois. Pura (sem I/O) pra ser testada isolada — quem busca as
// leituras e grava o resultado é avaliarEstimativasCota em lib/coletar.js.
//
// leituras: [{nivel, medidoEm}] do intervalo [previsto_em, alvo_em + tol],
// em qualquer ordem (ordena internamente).
//
// A tolerância vale dos DOIS lados: a janela de acerto é
// [alvoEm − tolerância, alvoEm + tolerância]. "Acertou" = alguma leitura de
// dentro dessa janela já estava do outro lado do alvo — ou seja, na hora
// prevista (± tolerância) o nível realmente estava lá. Cruzar cedo demais e
// já ter ido embora conta como erro, igual a não ter chegado: nos dois casos
// a estimativa não teria ajudado quem confiasse nela na hora H.
//
// erroHoras mede o cruzamento REAL (o primeiro do intervalo inteiro, não da
// janela de acerto) contra o horário previsto — negativo = chegou adiantado.
// É o que revela o tamanho do erro de ritmo mesmo num "acertou"; medir só
// dentro da janela faria todo acerto adiantado aparecer como exatamente
// −tolerância, escondendo o quanto a extrapolação errou.
export function avaliarEstimativa({ classe, alvoNivel, alvoEm, toleranciaHoras, leituras }) {
  const ordenadas = (leituras || [])
    .slice()
    .sort((a, b) => new Date(a.medidoEm) - new Date(b.medidoEm));

  const alvoMs = new Date(alvoEm).getTime();
  const inicioAcerto = alvoMs - toleranciaHoras * 3_600_000;
  const atingiu = (l) => (classe === 'subindo' ? l.nivel >= alvoNivel : l.nivel <= alvoNivel);

  const naJanela = ordenadas.find((l) => new Date(l.medidoEm).getTime() >= inicioAcerto && atingiu(l));
  const primeiro = ordenadas.find(atingiu);

  // Leitura real mais próxima do horário-alvo, só como contexto pra quem for
  // olhar os dados depois — inclusive quando o resultado é "errou".
  const maisProxima = ordenadas.length === 0 ? null : ordenadas.reduce((a, b) =>
    Math.abs(new Date(a.medidoEm).getTime() - alvoMs) <= Math.abs(new Date(b.medidoEm).getTime() - alvoMs) ? a : b
  );

  return {
    resultado: naJanela ? 'acertou' : 'errou',
    erroHoras: naJanela
      ? Number(((new Date(primeiro.medidoEm).getTime() - alvoMs) / 3_600_000).toFixed(2))
      : null,
    nivelRealNoAlvo: maisProxima === null ? null : maisProxima.nivel,
  };
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

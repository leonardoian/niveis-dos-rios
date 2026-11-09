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

// Decide se a coleta deve arquivar uma estimativa de tempo até a cota (v2
// do estimador — ver estimador_versao em schema.sql) e com quais números.
// Pura pra que as duas regras de NÃO emitir, que são o coração da v2,
// fiquem cobertas por teste sem banco.
//
// leituras: [{nivel, medidoEm}] da janela de `janelaHoras`, em qualquer
// ordem. O nível do cálculo é o da leitura mais recente.
//
// Diferenças em relação à v1 (que fazia isto inline em lib/coletar.js):
//
//   1. Velocidade SUSTENTADA na janela (calcularSubidaSustentada), não a
//      instantânea entre as duas últimas leituras. A v1 pegava o ruído de
//      instrumento de ~15 min e o extrapolava por horas ou dias — um
//      tremor de 1 cm virava "atinge a cota em 9 dias". Apesar do nome,
//      calcularSubidaSustentada devolve a taxa COM SINAL, então serve
//      também pra descida.
//      Sem cobertura suficiente da janela (estação nova, buraco de coleta)
//      ela devolve null, e aqui isso vira "não emite": melhor não estimar
//      que estimar sobre ruído.
//
//   2. Teto de horizonte. Acima de `horizonteMaxH` não emite. É limite de
//      VALIDADE do método, não ajuste de métrica: uma extrapolação linear
//      de 3h de telemetria não sustenta afirmação a dias de distância, e
//      arquivar essas estimativas só enchia a amostra de casos em que o
//      método nem se propõe a funcionar.
//
// Devolve { emitir: false, motivo } quando não emite — o motivo existe pros
// testes poderem afirmar POR QUE não emitiu (cobertura × horizonte ×
// simplesmente não há ETA), em vez de só que não emitiu.
export function planejarEstimativaCota({ leituras, cota, janelaHoras, horizonteMaxH }) {
  if (!Number.isFinite(cota) || cota <= 0) return { emitir: false, motivo: 'sem_cota' };

  const validas = (leituras || []).filter((l) => Number.isFinite(l.nivel));
  if (validas.length === 0) return { emitir: false, motivo: 'sem_leitura' };

  const velocidadeCmH = calcularSubidaSustentada(validas, janelaHoras);
  if (velocidadeCmH === null) return { emitir: false, motivo: 'cobertura_insuficiente' };

  const ultima = validas.reduce((a, b) => (new Date(b.medidoEm) > new Date(a.medidoEm) ? b : a));
  const nivel = ultima.nivel;

  // Mesmos arredondamentos que a v1 e o painel usam — margem em cm de
  // precisão, percentual com uma casa —, pra que a única diferença entre
  // as versões seja a velocidade e as duas travas, não a aritmética.
  const margem = Number((cota - nivel).toFixed(2));
  const percentualCota = Number(((nivel / cota) * 100).toFixed(1));

  const eta = calcularEtaCota(nivel, cota, margem, velocidadeCmH, percentualCota);
  if (!eta) return { emitir: false, motivo: 'sem_eta' };

  if (eta.horas > horizonteMaxH) return { emitir: false, motivo: 'alem_do_horizonte', horas: eta.horas };

  return { emitir: true, nivel, velocidadeCmH, ...eta };
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

// ---------------------------------------------------------------------
// PROJEÇÃO DE NÍVEL POR HORIZONTE FIXO
//
// Objeto diferente do de calcularEtaCota: lá se prevê QUANDO o nível cruza
// um valor, aqui se prevê QUAL nível a estação vai marcar daqui a X horas.
// É o formato que a literatura de previsão fluvial avalia (RMSE/NSE por
// horizonte fixo) — ver a nota de projecoes_nivel em schema.sql.
// ---------------------------------------------------------------------

// Projeta o nível para daqui a `horizonteH` horas. Pura e deliberadamente
// BURRA: sem suavização, sem clamp, sem piso em zero.
//
// Isso não é descuido, é o ponto: 'persistencia' só vale como linha de base
// se for exatamente "o nível fica onde está", sem nenhum ajuste esperto por
// trás. Qualquer melhoria embutida aqui viraria uma vantagem invisível da
// referência sobre os métodos que ela deveria medir — e um resultado que
// não dá pra comparar com o de ninguém, porque ninguém mais roda a nossa
// versão temperada de persistência. Vale o mesmo pra 'tendencia': a
// extrapolação linear crua pode projetar nível negativo numa descida longa,
// e deve mesmo — é assim que o erro dela aparece nas métricas em vez de
// ficar escondido atrás de um Math.max(0, ...).
//
// Devolve null quando não dá pra projetar (entrada inválida, horizonte não
// positivo, método desconhecido). 'curva' não é calculada aqui: ela não é
// extrapolação da nossa telemetria, vem pronta de previsoes.nivel_estimado_m
// (ver registrarProjecoesNivel em lib/coletar.js).
export function projetarNivel({ nivel, velocidadeCmH, horizonteH, metodo }) {
  if (!Number.isFinite(nivel)) return null;
  if (!Number.isFinite(horizonteH) || horizonteH <= 0) return null;

  // Arredonda em centímetros porque é a precisão real da régua e a da
  // coluna (NUMERIC(7,2)) — assim o número testado aqui é idêntico ao
  // gravado, sem diferença de arredondamento aparecendo depois na métrica.
  if (metodo === 'persistencia') return Number(nivel.toFixed(2));

  if (metodo === 'tendencia') {
    // Velocidade zero cai naturalmente no mesmo valor da persistência —
    // não é caso especial, é a conta dando isso.
    if (!Number.isFinite(velocidadeCmH)) return null;
    return Number((nivel + (velocidadeCmH * horizonteH) / 100).toFixed(2));
  }

  return null;
}

// Espelho em JS do GROUP BY de /api/projecoes: reduz uma lista de projeções
// já avaliadas às somas que bastam pra calcular todas as métricas.
//
// Existe separada de metricasProjecao porque em produção quem soma é o
// Postgres — projecoes_nivel ganha ~112 linhas por hora (~2,7 mil por dia),
// e trazer isso pro Node só pra somar não escala. A rota manda as somas
// prontas pra metricasProjecao; esta função é o mesmo cálculo sobre uma
// lista em memória, pros testes (e pra qualquer análise offline do TCC
// rodar a mesma conta sobre um recorte exportado).
//
// pares: [{nivelPrevisto, nivelReal}] — descarta par incompleto (projeção
// sem leitura na janela de ±30 min, que fica com erro_m NULL no banco).
export function somarProjecoes(pares) {
  const validos = (pares || []).filter(
    (p) => Number.isFinite(p.nivelPrevisto) && Number.isFinite(p.nivelReal)
  );

  return validos.reduce(
    (acc, p) => {
      const erro = p.nivelReal - p.nivelPrevisto; // mesmo sinal de erro_m
      return {
        n: acc.n + 1,
        somaErro: acc.somaErro + erro,
        somaAbsErro: acc.somaAbsErro + Math.abs(erro),
        somaErro2: acc.somaErro2 + erro * erro,
        somaReal: acc.somaReal + p.nivelReal,
        somaReal2: acc.somaReal2 + p.nivelReal * p.nivelReal,
      };
    },
    { n: 0, somaErro: 0, somaAbsErro: 0, somaErro2: 0, somaReal: 0, somaReal2: 0 }
  );
}

// Métricas de erro de um grupo (metodo × horizonte), a partir das somas.
//
//   maeM  — erro absoluto médio, em metros.
//   rmseM — raiz do erro quadrático médio: pune erro grande mais que o MAE,
//           que é justamente o que importa numa cheia. É a métrica que a
//           RBRH 30 usa, então é a que torna o resultado comparável.
//   viesM — erro médio COM SINAL (nivel_real − nivel_previsto): positivo =
//           o método previu baixo demais. Separado do MAE de propósito —
//           viés é corrigível, dispersão não.
//   nse   — Nash-Sutcliffe: 1 − SQE/variância das observações. 1 = perfeito,
//           0 = tão bom quanto ter chutado a média das observações do
//           período, negativo = pior que isso. NULL quando as observações
//           não variam (variância zero): aí o NSE é indefinido, e devolver
//           0 ou 1 inventaria um veredito.
//
// Cuidado ao ler o NSE da persistência: em série de nível de rio, onde a
// autocorrelação é altíssima, a persistência costuma dar NSE alto mesmo em
// horizontes longos. Isso é uma crítica conhecida da métrica, não um mérito
// do método — e é exatamente por isso que os quatro números ficam lado a
// lado aqui, em vez de um só.
export function metricasProjecao(somas) {
  const { n = 0, somaErro = 0, somaAbsErro = 0, somaErro2 = 0, somaReal = 0, somaReal2 = 0 } = somas || {};
  if (n === 0) return { n: 0, maeM: null, rmseM: null, viesM: null, nse: null };

  // Σ(real − média)² pela forma computacional — com nível de rio (unidades
  // de metros, n na casa dos milhares) não há risco de cancelamento sério,
  // e é o que permite ao Postgres mandar só somas.
  const variacaoObservada = somaReal2 - (somaReal * somaReal) / n;

  return {
    n,
    maeM: Number((somaAbsErro / n).toFixed(3)),
    rmseM: Number(Math.sqrt(somaErro2 / n).toFixed(3)),
    viesM: Number((somaErro / n).toFixed(3)),
    nse: variacaoObservada > 0 ? Number((1 - somaErro2 / variacaoObservada).toFixed(3)) : null,
  };
}

// Skill score contra a persistência — a métrica principal da comparação
// entre métodos.
//
//   SS = 1 − MSE(metodo) / MSE(persistencia)
//
// Por que ela e não o NSE: em previsão de curto prazo a referência honesta
// não é a média das observações (que é o denominador do NSE), é a
// persistência. Num rio, "o nível daqui a 6h é o de agora" já acerta quase
// tudo — bater a média do período é fácil e não prova nada. Um método só
// está agregando informação se ganhar DA PERSISTÊNCIA, e é isso que o SS
// mede: > 0 ganha, = 0 empata, < 0 é pior que não ter extrapolado nada.
// Onde o SS cruza o zero é a resposta de "até que horizonte a persistência
// basta". O NSE continua sendo calculado à parte porque é o que a
// literatura reporta — é o que torna o resultado comparável.
//
// Recebe as somas de erro² dos DOIS métodos sobre o mesmo conjunto pareado
// de alvos (quem faz o pareamento é o SQL de /api/projecoes — comparar
// médias de amostras diferentes daria um número sem sentido, ainda mais
// com 'curva' existindo só em parte dos dias).
//
// ss NULL quando não há par nenhum, ou quando MSE(persistencia) = 0: aí a
// persistência acertou na mosca todas as vezes e a razão não existe. Devolver
// −Infinity ou 0 nesse caso inventaria um veredito onde não há divisão
// possível.
export function skillScore({ n = 0, somaErro2Metodo = 0, somaErro2Persistencia = 0 } = {}) {
  if (n === 0) return { nPareado: 0, mseMetodo: null, msePersistencia: null, ss: null };

  const mseMetodo = somaErro2Metodo / n;
  const msePersistencia = somaErro2Persistencia / n;

  return {
    nPareado: n,
    mseMetodo: Number(mseMetodo.toFixed(4)),
    msePersistencia: Number(msePersistencia.toFixed(4)),
    ss: msePersistencia > 0 ? Number((1 - mseMetodo / msePersistencia).toFixed(3)) : null,
  };
}

// ---------------------------------------------------------------------
// ESTRATIFICAÇÃO E AGREGAÇÕES DE AVALIAÇÃO
// ---------------------------------------------------------------------

// Sentido da variação no momento da projeção, a partir do sinal de
// projecoes_nivel.velocidade_cm_h. Espelho em JS do CASE de /api/projecoes
// (lá quem classifica é o Postgres), pros testes e pra análise offline
// aplicarem exatamente a mesma regra.
//
// Por que estratificar: a relação cota-vazão é assimétrica entre enchente e
// vazante (histerese — ver USGS SIR 2024-5129), então é esperado que a
// extrapolação erre de formas diferentes com o rio subindo e descendo. Um
// agregado único misturaria os dois regimes e poderia esconder que o método
// ganha num e perde no outro.
//
// Sem limiar de "estável" além do zero exato, de propósito: qualquer faixa
// morta (ex.: |v| < 0,5 cm/h) seria um parâmetro escolhido por nós, e
// escolhê-lo depois de ver os dados contaminaria a comparação. O zero é a
// única fronteira que não precisa de justificativa. NULL vira 'indefinido'
// em vez de sumir, pra que o n das quatro classes some o total.
export function classeVariacao(velocidadeCmH) {
  if (velocidadeCmH === null || velocidadeCmH === undefined) return 'indefinido';
  const v = Number(velocidadeCmH);
  if (!Number.isFinite(v)) return 'indefinido';
  if (v > 0) return 'subindo';
  if (v < 0) return 'descendo';
  return 'estavel';
}

// Faixas de antecedência de /api/acerto. Mantidas como estavam antes da v2
// do estimador (inclusive a "mais de 24h", que na v2 só vai até 48h pelo
// teto de horizonte): mudar as faixas junto com o estimador misturaria duas
// mudanças e impediria comparar v1 e v2 faixa a faixa.
export const FAIXAS_ACERTO = [
  { chave: 'ate6h', rotulo: 'até 6h', min: 0, max: 6 },
  { chave: '6a24h', rotulo: '6–24h', min: 6, max: 24 },
  { chave: 'mais24h', rotulo: 'mais de 24h', min: 24, max: Infinity },
];

// Agrega as estimativas de cota avaliadas POR VERSÃO do estimador e, dentro
// de cada versão, por faixa de antecedência. Pura pra ser testada sem banco
// — /api/acerto só busca as linhas e chama isto.
//
// Não existe total misturando versões, de propósito: v1 (velocidade
// instantânea, horizonte ilimitado, trava por estação) e v2 são populações
// geradas por regras diferentes, e uma taxa de acerto somando as duas não
// mediria nenhum dos dois estimadores.
//
// avaliadas: [{estimadorVersao, horasEstimadas, resultado}]
// pendentesPorVersao: {versao: n} — versão sem nenhuma avaliada ainda
// aparece mesmo assim, pra página mostrar "0 avaliadas, N em aberto".
export function agregarAcertoPorVersao(avaliadas, pendentesPorVersao = {}) {
  const versoes = new Set([
    ...(avaliadas || []).map((a) => Number(a.estimadorVersao)),
    ...Object.keys(pendentesPorVersao).map(Number),
  ]);

  return [...versoes]
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .map((versao) => {
      const daVersao = (avaliadas || []).filter((a) => Number(a.estimadorVersao) === versao);
      const acertos = daVersao.filter((a) => a.resultado === 'acertou').length;
      return {
        versao,
        totalAvaliadas: daVersao.length,
        pendentes: Number(pendentesPorVersao[versao] ?? 0),
        acertos,
        taxa: daVersao.length === 0 ? null : Number((acertos / daVersao.length).toFixed(2)),
        porFaixa: FAIXAS_ACERTO.map((f) => {
          const doGrupo = daVersao.filter((a) => {
            const h = Number(a.horasEstimadas);
            return h >= f.min && h < f.max;
          });
          const acertosFaixa = doGrupo.filter((a) => a.resultado === 'acertou').length;
          return {
            faixa: f.rotulo,
            total: doGrupo.length,
            acertos: acertosFaixa,
            taxa: doGrupo.length === 0 ? null : Number((acertosFaixa / doGrupo.length).toFixed(2)),
          };
        }),
      };
    });
}

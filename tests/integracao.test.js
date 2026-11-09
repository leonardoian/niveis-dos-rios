// Testes de INTEGRAÇÃO contra um Postgres de verdade — cobrem o que só o SQL
// decide e por isso não dá pra testar com função pura: a trava horária de
// estimativas_cota (NOT EXISTS + índice único parcial), o agrupamento por
// versão de /api/acerto e a estratificação do skill score de
// /api/projecoes.
//
// PULADOS por padrão: só rodam com TEST_DATABASE_URL definida, apontando
// pra um banco DESCARTÁVEL com o schema.sql já aplicado. Como o driver da
// Neon fala HTTP (não o protocolo do Postgres), um Postgres local precisa
// do proxy HTTP da Neon na frente; TEST_NEON_FETCH_ENDPOINT diz onde ele
// está. Receita com Docker no README (seção Testes).
//
// Não apaga nada que não tenha criado: tudo vive em estações 'zz-teste-*'
// (removidas em cascata no começo e no fim). E se o banco tiver qualquer
// dado de outra estação nas tabelas tocadas, o teste se recusa a rodar —
// as rotas agregam a tabela inteira, então num banco com dados reais as
// asserções nem fariam sentido, e o registro de estimativas gravaria linhas
// de verdade nele.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { neonConfig } from '@neondatabase/serverless';
import { skillScore } from '../lib/calculo.js';

const URL_TESTE = process.env.TEST_DATABASE_URL;
const pular = !URL_TESTE && 'TEST_DATABASE_URL não definida (ver README, seção Testes)';

let sql;
let registrarEstimativasCota;
let handlerAcerto;
let handlerProjecoes;
let handlerSaude;
let registrarColeta;

const PREFIXO = 'zz-teste-';

// `coletas` não tem slug: as linhas criadas pelos testes são marcadas com
// esta duração impossível, pra poderem ser apagadas (e as alheias,
// detectadas) sem tocar em nada que o teste não criou.
const MARCA_COLETA = -424242;

// res mínimo no formato que as rotas do Vercel usam.
function respostaFalsa() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function limpar() {
  await sql`DELETE FROM estacoes WHERE slug LIKE ${PREFIXO + '%'}`;
  await sql`DELETE FROM coletas WHERE duracao_ms = ${MARCA_COLETA}`;
}

async function criarEstacao(slug, cota) {
  await sql`
    INSERT INTO estacoes (slug, cidade, uf, rio, cota_inundacao, ativa)
    VALUES (${slug}, ${'Teste ' + slug}, 'RS', 'Rio de Teste', ${cota}, TRUE)
  `;
}

// Leituras a cada 15 min de `inicio` até `fim` (inclusive), variando `cmH`
// por hora a partir de `nivelInicial`.
async function inserirLeituras(slug, { inicio, fim, nivelInicial, cmH }) {
  const ini = Date.parse(inicio);
  const niveis = [];
  const instantes = [];
  for (let t = ini; t <= Date.parse(fim); t += 15 * 60_000) {
    niveis.push(Number((nivelInicial + (cmH * (t - ini)) / 3_600_000 / 100).toFixed(2)));
    instantes.push(new Date(t).toISOString());
  }
  await sql`
    INSERT INTO leituras (slug, nivel, medido_em)
    SELECT ${slug}, u.nivel, u.medido_em
    FROM UNNEST(${niveis}::numeric[], ${instantes}::timestamptz[]) AS u(nivel, medido_em)
    ON CONFLICT DO NOTHING
  `;
}

const doSlug = (slug) => sql`
  SELECT classe, previsto_em, estimador_versao, horas_estimadas, velocidade_cm_h, avaliado_em
  FROM estimativas_cota WHERE slug = ${slug} ORDER BY previsto_em
`;

before(async () => {
  if (pular) return;
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === URL_TESTE) {
    throw new Error('TEST_DATABASE_URL é igual a DATABASE_URL — use um banco descartável.');
  }
  if (process.env.TEST_NEON_FETCH_ENDPOINT) {
    const endpoint = process.env.TEST_NEON_FETCH_ENDPOINT;
    neonConfig.fetchEndpoint = () => endpoint;
  }
  // lib/db.js lê DATABASE_URL no import, por isso os imports são dinâmicos
  // e vêm depois disto.
  process.env.DATABASE_URL = URL_TESTE;
  ({ sql } = await import('../lib/db.js'));
  ({ registrarEstimativasCota, registrarColeta } = await import('../lib/coletar.js'));
  ({ default: handlerAcerto } = await import('../api/acerto.js'));
  ({ default: handlerProjecoes } = await import('../api/projecoes.js'));
  ({ default: handlerSaude } = await import('../api/saude.js'));

  const [{ alheias }] = await sql`
    SELECT
      (SELECT COUNT(*) FROM leituras         WHERE slug NOT LIKE ${PREFIXO + '%'})
    + (SELECT COUNT(*) FROM estimativas_cota WHERE slug NOT LIKE ${PREFIXO + '%'})
    + (SELECT COUNT(*) FROM projecoes_nivel  WHERE slug NOT LIKE ${PREFIXO + '%'})
    + (SELECT COUNT(*) FROM coletas WHERE duracao_ms IS DISTINCT FROM ${MARCA_COLETA}) AS alheias
  `;
  if (Number(alheias) > 0) {
    throw new Error('O banco de teste tem leituras/estimativas/projeções/coletas reais — use um banco vazio e descartável.');
  }
  await limpar();
});

after(async () => {
  if (!pular && sql) await limpar();
});

test('estimativas_cota: duas rodadas na mesma hora geram uma linha; horas diferentes, duas', { skip: pular }, async () => {
  const slug = PREFIXO + 'sobe';
  await criarEstacao(slug, 10);
  // 5 cm/h por 3h terminando em 8,00 m → 2 m até a cota = 40h (< 48h).
  await inserirLeituras(slug, { inicio: '2026-01-01T11:05:00Z', fim: '2026-01-01T14:05:00Z', nivelInicial: 7.85, cmH: 5 });

  const r1 = await registrarEstimativasCota({ agora: new Date('2026-01-01T14:05:30Z') });
  assert.deepEqual(r1.filter((c) => c.slug === slug).map((c) => c.classe), ['subindo']);

  // Mesma hora, com leitura nova chegando — e duas vezes, pra cobrir
  // rodadas repetidas (Vercel + GitHub Actions).
  await inserirLeituras(slug, { inicio: '2026-01-01T14:20:00Z', fim: '2026-01-01T14:35:00Z', nivelInicial: 8.0125, cmH: 5 });
  const r2 = await registrarEstimativasCota({ agora: new Date('2026-01-01T14:35:30Z') });
  const r3 = await registrarEstimativasCota({ agora: new Date('2026-01-01T14:59:59Z') });
  assert.equal(r2.filter((c) => c.slug === slug).length, 0);
  assert.equal(r3.filter((c) => c.slug === slug).length, 0);
  assert.equal((await doSlug(slug)).length, 1);

  // Hora seguinte: a primeira continua EM ABERTO e mesmo assim não bloqueia
  // — era exatamente o que a trava por estação da v1 fazia.
  await inserirLeituras(slug, { inicio: '2026-01-01T14:50:00Z', fim: '2026-01-01T15:05:00Z', nivelInicial: 8.0375, cmH: 5 });
  const r4 = await registrarEstimativasCota({ agora: new Date('2026-01-01T15:05:30Z') });
  assert.equal(r4.filter((c) => c.slug === slug).length, 1);

  const linhas = await doSlug(slug);
  assert.equal(linhas.length, 2);
  assert.ok(linhas.every((l) => l.avaliado_em === null), 'as duas em aberto ao mesmo tempo');
  assert.ok(linhas.every((l) => Number(l.estimador_versao) === 2));
  assert.notEqual(
    new Date(linhas[0].previsto_em).getUTCHours(),
    new Date(linhas[1].previsto_em).getUTCHours()
  );
  // Velocidade sustentada (≈ 5 cm/h), não a instantânea.
  assert.ok(linhas.every((l) => Math.abs(Number(l.velocidade_cm_h) - 5) <= 0.2));
});

test('estimativas_cota: índice único barra duplicata da mesma hora mesmo sem o NOT EXISTS', { skip: pular }, async () => {
  const slug = PREFIXO + 'indice';
  await criarEstacao(slug, 10);
  const linha = (previstoEm) => sql`
    INSERT INTO estimativas_cota
      (slug, classe, previsto_em, nivel_no_calculo, velocidade_cm_h, alvo_nivel,
       horas_estimadas, alvo_em, tolerancia_horas, estimador_versao)
    VALUES (${slug}, 'subindo', ${previstoEm}, 8, 5, 10, 40, ${previstoEm}::timestamptz + INTERVAL '40 hours', 8, 2)
    ON CONFLICT DO NOTHING
    RETURNING 1
  `;
  assert.equal((await linha('2026-02-01T10:01:00Z')).length, 1);
  assert.equal((await linha('2026-02-01T10:59:00Z')).length, 0);
  assert.equal((await linha('2026-02-01T11:00:00Z')).length, 1);
});

test('estimativas_cota: cobertura insuficiente e horizonte > 48h não emitem', { skip: pular }, async () => {
  const nova = PREFIXO + 'nova';
  const lenta = PREFIXO + 'lenta';
  const ok = PREFIXO + 'ok';
  await criarEstacao(nova, 10);
  await criarEstacao(lenta, 10);
  await criarEstacao(ok, 10);

  // Estação nova: só 30 min de leituras, subindo rápido — a v1 estimaria.
  await inserirLeituras(nova, { inicio: '2026-03-01T11:30:00Z', fim: '2026-03-01T12:00:00Z', nivelInicial: 8, cmH: 20 });
  // 1 cm/h com 2 m de margem = ~200h.
  await inserirLeituras(lenta, { inicio: '2026-03-01T09:00:00Z', fim: '2026-03-01T12:00:00Z', nivelInicial: 7.97, cmH: 1 });
  // Controle: mesma rodada, estação que deve emitir.
  await inserirLeituras(ok, { inicio: '2026-03-01T09:00:00Z', fim: '2026-03-01T12:00:00Z', nivelInicial: 7.7, cmH: 10 });

  const criadas = await registrarEstimativasCota({ agora: new Date('2026-03-01T12:00:30Z') });
  const slugs = criadas.map((c) => c.slug);
  assert.ok(!slugs.includes(nova));
  assert.ok(!slugs.includes(lenta));
  assert.ok(slugs.includes(ok));
  assert.equal((await doSlug(nova)).length, 0);
  assert.equal((await doSlug(lenta)).length, 0);
});

test('/api/acerto: agrupa por estimador_versao e não mistura v1 com v2', { skip: pular }, async () => {
  const slug = PREFIXO + 'acerto';
  await criarEstacao(slug, 10);

  // v1 SEM informar estimador_versao: prova que o DEFAULT 1 marca como v1
  // o que o código antigo gravaria.
  const v1 = [[3, 'acertou'], [100, 'errou'], [300, 'errou']];
  for (const [i, [horas, resultado]] of v1.entries()) {
    await sql`
      INSERT INTO estimativas_cota
        (slug, classe, previsto_em, nivel_no_calculo, velocidade_cm_h, alvo_nivel,
         horas_estimadas, alvo_em, tolerancia_horas, avaliado_em, resultado)
      VALUES (${slug}, 'subindo', ${`2025-06-0${i + 1}T00:00:00Z`}, 8, 1, 10, ${horas},
              ${`2025-06-0${i + 1}T00:00:00Z`}::timestamptz + ${horas} * INTERVAL '1 hour', 1, NOW(), ${resultado})
    `;
  }
  const v2 = [[2, 'acertou'], [10, 'acertou'], [30, 'errou'], [40, 'acertou']];
  for (const [i, [horas, resultado]] of v2.entries()) {
    await sql`
      INSERT INTO estimativas_cota
        (slug, classe, previsto_em, nivel_no_calculo, velocidade_cm_h, alvo_nivel,
         horas_estimadas, alvo_em, tolerancia_horas, avaliado_em, resultado, estimador_versao)
      VALUES (${slug}, 'subindo', ${`2025-07-0${i + 1}T00:00:00Z`}, 8, 1, 10, ${horas},
              ${`2025-07-0${i + 1}T00:00:00Z`}::timestamptz + ${horas} * INTERVAL '1 hour', 1, NOW(), ${resultado}, 2)
    `;
  }

  const [{ pend2 }] = await sql`
    SELECT COUNT(*)::int AS pend2 FROM estimativas_cota WHERE avaliado_em IS NULL AND estimador_versao = 2
  `;

  const res = respostaFalsa();
  await handlerAcerto({}, res);
  assert.equal(res.statusCode, 200);

  const { porVersao, recentes } = res.body;
  assert.ok(!('porFaixa' in res.body), 'nenhuma taxa misturando versões no topo');
  const [a, b] = porVersao;
  assert.equal(a.versao, 1);
  assert.equal(a.totalAvaliadas, 3);
  assert.equal(a.acertos, 1);
  assert.deepEqual(a.porFaixa.map((f) => f.total), [1, 0, 2]);
  assert.equal(b.versao, 2);
  assert.equal(b.totalAvaliadas, 4);
  assert.equal(b.acertos, 3);
  assert.equal(b.taxa, 0.75);
  assert.equal(b.pendentes, pend2);
  assert.deepEqual(b.porFaixa.map((f) => f.total), [1, 1, 2]);
  assert.ok(recentes.every((r) => r.estimadorVersao === 1 || r.estimadorVersao === 2));
});

test('/api/projecoes: skill score estratificado por sentido bate com o cálculo manual', { skip: pular }, async () => {
  const slug = PREFIXO + 'proj';
  await criarEstacao(slug, 10);

  // Pares (persistencia, tendencia) do mesmo alvo, no horizonte de 6h, cada
  // um numa hora diferente (o índice único é por hora). Erros redondos.
  //   v    erro_tendencia  erro_persistencia
  const amostra = [
    [ 5,   0.10,  0.30],   // subindo
    [ 8,  -0.10,  0.10],   // subindo
    [ 2,   0.20,  0.20],   // subindo
    [-4,   0.30, -0.10],   // descendo
    [-1,  -0.20,  0.20],   // descendo
    [ 0,   0.05,  0.05],   // estavel
  ];

  for (const [i, [v, erroT, erroP]] of amostra.entries()) {
    const geradaEm = new Date(Date.parse('2025-09-01T00:00:00Z') + i * 3_600_000).toISOString();
    const alvoEm = new Date(Date.parse(geradaEm) + 6 * 3_600_000).toISOString();
    const nivelReal = 5;
    for (const [metodo, erro] of [['persistencia', erroP], ['tendencia', erroT]]) {
      await sql`
        INSERT INTO projecoes_nivel
          (slug, metodo, horizonte_h, gerada_em, nivel_no_calculo, velocidade_cm_h,
           nivel_previsto, alvo_em, avaliada_em, nivel_real, erro_m)
        VALUES (${slug}, ${metodo}, 6, ${geradaEm}, 5, ${v},
                ${nivelReal - erro}, ${alvoEm}, NOW(), ${nivelReal}, ${erro})
      `;
    }
  }
  // Uma 'tendencia' sem par na persistência: não pode entrar em SS nenhum.
  await sql`
    INSERT INTO projecoes_nivel
      (slug, metodo, horizonte_h, gerada_em, nivel_no_calculo, velocidade_cm_h,
       nivel_previsto, alvo_em, avaliada_em, nivel_real, erro_m)
    VALUES (${slug}, 'tendencia', 6, '2025-09-02T00:00:00Z', 5, 3,
            4, '2025-09-02T06:00:00Z', NOW(), 5, 1)
  `;

  // Cálculo manual, classe a classe.
  const esperado = {};
  for (const [v, erroT, erroP] of amostra) {
    const c = v > 0 ? 'subindo' : v < 0 ? 'descendo' : 'estavel';
    esperado[c] ??= { n: 0, somaErro2Metodo: 0, somaErro2Persistencia: 0 };
    esperado[c].n += 1;
    esperado[c].somaErro2Metodo += erroT ** 2;
    esperado[c].somaErro2Persistencia += erroP ** 2;
  }

  const res = respostaFalsa();
  await handlerProjecoes({}, res);
  assert.equal(res.statusCode, 200);
  const { skillScores, skillScoresPorSentido, grupos, gruposPorSentido } = res.body;

  const estratos = skillScoresPorSentido.filter((s) => s.metodo === 'tendencia' && s.horizonteH === 6);
  assert.deepEqual(estratos.map((s) => s.sentido), ['subindo', 'descendo', 'estavel']);
  for (const s of estratos) {
    const manual = skillScore(esperado[s.sentido]);
    assert.equal(s.nPareado, esperado[s.sentido].n, `n de ${s.sentido}`);
    assert.equal(s.ss, manual.ss, `SS de ${s.sentido}`);
    assert.equal(s.mseMetodo, manual.mseMetodo);
    assert.equal(s.msePersistencia, manual.msePersistencia);
  }
  // Na mão, sem passar por skillScore: subindo = 1 − (0,06/3)/(0,14/3).
  assert.equal(estratos[0].ss, Number((1 - 0.06 / 0.14).toFixed(3)));
  // descendo = 1 − (0,13/2)/(0,05/2) = −1,6
  assert.equal(estratos[1].ss, -1.6);

  // O agregado não estratificado continua lá, pareado, e o n dos estratos
  // soma o dele (a 'tendencia' órfã fica de fora dos dois).
  const agregado = skillScores.find((s) => s.metodo === 'tendencia' && s.horizonteH === 6);
  assert.equal(agregado.nPareado, amostra.length);
  assert.equal(estratos.reduce((s, x) => s + x.nPareado, 0), agregado.nPareado);

  // Grupos: o estratificado também soma o agregado, e inclui a órfã
  // (grupos não são pareados — é métrica de cada método sozinho).
  const gT = grupos.find((g) => g.metodo === 'tendencia' && g.horizonteH === 6);
  const gTs = gruposPorSentido.filter((g) => g.metodo === 'tendencia' && g.horizonteH === 6);
  assert.equal(gT.n, amostra.length + 1);
  assert.equal(gTs.reduce((s, g) => s + g.n, 0), gT.n);
  assert.equal(gTs.find((g) => g.sentido === 'subindo').n, 4); // 3 + a órfã (v = 3)
});

// ---------------------------------------------------------------------
// coletas.erro_ana e /api/saude
// ---------------------------------------------------------------------

const ERRO_401 = 'autenticação: HTTP 401 — Usuário sem permissão de acesso ao módulo. Verifique!';
const ERRO_503 = 'autenticação: HTTP 503 — Application is not available';

// Uma rodada mínima no formato que coletar() devolve.
const rodada = (extra) => ({ erroFeed: null, recebidas: 0, inseridas: 0, ...extra });

test('coletas.erro_ana: grava o motivo e /api/saude agrupa por motivo', { skip: pular }, async () => {
  await registrarColeta(rodada({ anaOk: false, erroAna: ERRO_401 }), MARCA_COLETA);
  await registrarColeta(rodada({ anaOk: false, erroAna: ERRO_401 }), MARCA_COLETA);
  await registrarColeta(rodada({ anaOk: false, erroAna: ERRO_503 }), MARCA_COLETA);
  await registrarColeta(rodada({ anaOk: true, erroAna: null }), MARCA_COLETA); // a ANA voltou

  const linhas = await sql`
    SELECT ana_ok, erro_ana FROM coletas WHERE duracao_ms = ${MARCA_COLETA} ORDER BY iniciada_em
  `;
  assert.deepEqual(linhas.map((l) => l.erro_ana), [ERRO_401, ERRO_401, ERRO_503, null]);

  const res = respostaFalsa();
  await handlerSaude({}, res);
  assert.equal(res.statusCode, 200);
  const d = res.body;

  // A última rodada deu certo: nada no "agora", mas a última falha fica.
  assert.equal(d.ultimaColeta.anaOk, true);
  assert.equal(d.ultimaColeta.erroAna, null);
  assert.equal(d.ultimaFalhaAna.erro, ERRO_503);

  const ana = d.janelas['24h'].ana;
  assert.equal(ana.ok, 1);
  assert.equal(ana.falhas, 3);
  assert.deepEqual(
    ana.motivos.map((m) => [m.erro, m.vezes]),
    [[ERRO_401, 2], [ERRO_503, 1]]
  );
  await sql`DELETE FROM coletas WHERE duracao_ms = ${MARCA_COLETA}`;
});

test('coletas.erro_ana: deploy ANTES do schema.sql não perde a linha da rodada', { skip: pular }, async (t) => {
  // Reproduz o incidente de 26/08–09/11/2026: código novo no ar, coluna
  // ainda não criada no banco. Antes, isso custava a linha inteira de
  // `coletas` (e o /api/saude ficava cego); agora tem que custar só o
  // campo novo. O banco é descartável (garantido no before), e a coluna
  // volta no finally.
  t.mock.method(console, 'error', () => {});
  await sql`ALTER TABLE coletas DROP COLUMN erro_ana`;
  try {
    await registrarColeta(rodada({ anaOk: false, erroAna: ERRO_401 }), MARCA_COLETA);

    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM coletas WHERE duracao_ms = ${MARCA_COLETA}`;
    assert.equal(n, 1, 'a linha da rodada foi gravada mesmo sem a coluna');

    const res = respostaFalsa();
    await handlerSaude({}, res);
    assert.equal(res.statusCode, 200, '/api/saude não cai por causa da coluna de diagnóstico');
    assert.equal(res.body.ultimaColeta.anaOk, false);
    assert.equal(res.body.ultimaColeta.erroAna, null);
    assert.equal(res.body.ultimaFalhaAna, null);
    assert.equal(res.body.janelas['24h'].ana.motivos, null);
  } finally {
    await sql`ALTER TABLE coletas ADD COLUMN IF NOT EXISTS erro_ana TEXT`;
    await sql`DELETE FROM coletas WHERE duracao_ms = ${MARCA_COLETA}`;
  }
});

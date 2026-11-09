import { sql } from '../lib/db.js';
import { metricasProjecao, skillScore } from '../lib/calculo.js';

// GET /api/projecoes
//
// Erro das projeções de NÍVEL por horizonte fixo (ver projecoes_nivel em
// schema.sql), agrupado por método × horizonte. É a rota que responde a
// pergunta do TCC: até que horizonte a persistência — "o nível fica onde
// está" — ainda produz estimativa útil, e a partir de onde os outros
// métodos passam a valer a pena.
//
// Diferente de /api/acerto, que mede a estimativa de TEMPO até a cota
// ("acertou/errou"), aqui o objeto medido é o NÍVEL em metros, com as
// métricas contínuas que a literatura de previsão fluvial usa (RMSE, NSE) —
// é o que torna o resultado comparável com trabalhos publicados, incluindo
// as previsões emergenciais do Guaíba na RBRH 30 (2025), que registra
// justamente a falta de uma referência de persistência.
//
// Devolve duas coisas que respondem a perguntas diferentes:
//
//   `grupos`      — n, MAE, RMSE, viés e NSE por método × horizonte. O NSE
//                   compara com a MÉDIA das observações: é a métrica que a
//                   literatura reporta, então é o que permite comparar este
//                   sistema com outros trabalhos.
//   `skillScores` — SS = 1 − MSE(metodo)/MSE(persistencia) por horizonte,
//                   para 'tendencia' e 'curva'. Este é o RESULTADO: em
//                   previsão de curto prazo a referência honesta é a
//                   persistência, não a média do período. SS > 0 = o método
//                   ganha da persistência; SS ≤ 0 = extrapolar não
//                   acrescentou nada, e a linha de base burra bastava.
//                   O horizonte em que o SS cruza o zero é a resposta da
//                   pergunta do TCC.
//
// E as mesmas duas coisas estratificadas por sentido da variação no momento
// da emissão (`gruposPorSentido`, `skillScoresPorSentido`: subindo /
// descendo / estavel / indefinido), pra comparar o desempenho com o rio
// subindo e descendo — ver o comentário das consultas abaixo.
//
// Sem parâmetro de janela, de propósito: as outras rotas de avaliação
// recortam por dias porque servem uma página que mostra "como está agora";
// esta serve uma análise, e uma métrica calculada sobre uma janela móvel
// muda de valor a cada dia sem que nada tenha mudado no método. O recorte,
// quando for preciso, se faz sobre a tabela.
const ORDEM_METODOS = { persistencia: 0, tendencia: 1, curva: 2 };
const ORDEM_SENTIDOS = { subindo: 0, descendo: 1, estavel: 2, indefinido: 3 };

export default async function handler(req, res) {
  try {
    // O Postgres agrega e devolve só as somas suficientes — a tabela ganha
    // ~112 linhas por hora (~2,7 mil por dia), então trazer as linhas cruas
    // pro Node pra somar aqui deixaria de funcionar em poucos meses. A
    // derivação das métricas em cima dessas somas é metricasProjecao
    // (lib/calculo.js), pura e testada em tests/calculo.test.js.
    const grupos = await sql`
      SELECT
        metodo,
        horizonte_h,
        COUNT(*)::int          AS n,
        SUM(erro_m)            AS soma_erro,
        SUM(ABS(erro_m))       AS soma_abs_erro,
        SUM(erro_m * erro_m)   AS soma_erro2,
        SUM(nivel_real)        AS soma_real,
        SUM(nivel_real * nivel_real) AS soma_real2
      FROM projecoes_nivel
      WHERE avaliada_em IS NOT NULL
        AND erro_m IS NOT NULL
      GROUP BY metodo, horizonte_h
      ORDER BY metodo, horizonte_h
    `;

    // Pendentes e "avaliada sem leitura no alvo" contadas à parte: as duas
    // são zero saudável, e uma delas crescendo diz coisas diferentes —
    // pendente demais é avaliação travada, sem-leitura demais é buraco de
    // telemetria. Nenhuma das duas entra nas métricas.
    const [{ pendentes, sem_leitura: semLeitura, primeira_gerada_em: primeiraGeradaEm, ultima_avaliada_em: ultimaAvaliadaEm }] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE avaliada_em IS NULL)::int                        AS pendentes,
        COUNT(*) FILTER (WHERE avaliada_em IS NOT NULL AND erro_m IS NULL)::int AS sem_leitura,
        MIN(gerada_em)                                                          AS primeira_gerada_em,
        MAX(avaliada_em)                                                        AS ultima_avaliada_em
      FROM projecoes_nivel
    `;

    // Skill score: comparação PAREADA com a persistência, sobre exatamente
    // os mesmos alvos avaliados nos dois métodos.
    //
    // O pareamento não é preciosismo: 'curva' só existe nos dias em que a
    // estação tem previsão de nível utilizável, que costumam ser os dias de
    // vazão alta. Comparar o MSE dela (medido só nesses dias) contra o MSE
    // da persistência (medido em todos) mediria a diferença entre os dias,
    // não entre os métodos — e com sinal imprevisível, porque dia de cheia
    // é justamente quando a persistência erra mais. Restringir à
    // interseção elimina isso.
    //
    // A chave do par é (slug, horizonte_h, alvo_em), e o JOIN é 1:1 por
    // construção: alvo_em = gerada_em + horizonte_h, então alvos iguais no
    // mesmo horizonte só existem se vierem da mesma emissão.
    const pareados = await sql`
      WITH avaliadas AS (
        SELECT slug, metodo, horizonte_h, alvo_em, erro_m
        FROM projecoes_nivel
        WHERE avaliada_em IS NOT NULL
          AND erro_m IS NOT NULL
      ),
      referencia AS (
        SELECT slug, horizonte_h, alvo_em, erro_m
        FROM avaliadas
        WHERE metodo = 'persistencia'
      )
      SELECT
        a.metodo,
        a.horizonte_h,
        COUNT(*)::int                AS n,
        SUM(a.erro_m * a.erro_m)     AS soma_erro2_metodo,
        SUM(r.erro_m * r.erro_m)     AS soma_erro2_persistencia
      FROM avaliadas a
      JOIN referencia r
        ON r.slug = a.slug
       AND r.horizonte_h = a.horizonte_h
       AND r.alvo_em = a.alvo_em
      WHERE a.metodo <> 'persistencia'
      GROUP BY a.metodo, a.horizonte_h
      ORDER BY a.metodo, a.horizonte_h
    `;

    // ESTRATIFICAÇÃO POR SENTIDO DA VARIAÇÃO — os mesmos dois agregados de
    // cima, abertos por subindo/descendo/estavel/indefinido.
    //
    // Por quê: a relação cota-vazão é assimétrica entre enchente e vazante
    // (histerese — USGS SIR 2024-5129), então é esperado que a extrapolação
    // erre de formas diferentes em cada caso, e um SS único poderia ser a
    // média de um método que ganha subindo e perde descendo.
    //
    // A classe sai do SINAL de velocidade_cm_h, que já é gravada em toda
    // projeção — nenhuma coluna nova, e nenhum limiar escolhido por nós
    // (ver classeVariacao em lib/calculo.js, que é o espelho em JS deste
    // CASE e onde está o porquê de não haver faixa morta). NULL vira
    // 'indefinido' em vez de sumir, pra que as quatro classes somem o
    // agregado não estratificado.
    //
    // Cuidado ao interpretar: velocidade_cm_h aqui é a INSTANTÂNEA (duas
    // últimas leituras), a mesma que alimenta a 'tendencia'. A classe diz
    // "em que sentido a telemetria apontava quando a projeção foi emitida",
    // não "em que regime hidrológico o rio estava" — com ruído de
    // instrumento, parte das projeções de um rio parado cai em
    // subindo/descendo.
    //
    // Os agregados não estratificados acima continuam calculados pelas
    // consultas originais, intocadas: os números que já existiam não podem
    // mudar só porque uma dimensão nova apareceu.
    const gruposPorSentido = await sql`
      SELECT
        metodo,
        horizonte_h,
        CASE
          WHEN velocidade_cm_h > 0 THEN 'subindo'
          WHEN velocidade_cm_h < 0 THEN 'descendo'
          WHEN velocidade_cm_h = 0 THEN 'estavel'
          ELSE 'indefinido'
        END                    AS sentido,
        COUNT(*)::int          AS n,
        SUM(erro_m)            AS soma_erro,
        SUM(ABS(erro_m))       AS soma_abs_erro,
        SUM(erro_m * erro_m)   AS soma_erro2,
        SUM(nivel_real)        AS soma_real,
        SUM(nivel_real * nivel_real) AS soma_real2
      FROM projecoes_nivel
      WHERE avaliada_em IS NOT NULL
        AND erro_m IS NOT NULL
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `;

    // Pareamento DENTRO de cada classe: mesma chave (slug, horizonte_h,
    // alvo_em) de antes, mais a exigência de que os dois lados do par
    // estejam na mesma classe. Por construção já estão — as linhas de uma
    // mesma emissão gravam a mesma velocidade em todos os métodos —, mas a
    // condição explícita garante que um SS de 'subindo' nunca compare o
    // método contra a persistência de um alvo classificado de outro jeito,
    // mesmo que a gravação um dia mude.
    const pareadosPorSentido = await sql`
      WITH avaliadas AS (
        SELECT slug, metodo, horizonte_h, alvo_em, erro_m,
          CASE
            WHEN velocidade_cm_h > 0 THEN 'subindo'
            WHEN velocidade_cm_h < 0 THEN 'descendo'
            WHEN velocidade_cm_h = 0 THEN 'estavel'
            ELSE 'indefinido'
          END AS sentido
        FROM projecoes_nivel
        WHERE avaliada_em IS NOT NULL
          AND erro_m IS NOT NULL
      ),
      referencia AS (
        SELECT slug, horizonte_h, alvo_em, erro_m, sentido
        FROM avaliadas
        WHERE metodo = 'persistencia'
      )
      SELECT
        a.metodo,
        a.horizonte_h,
        a.sentido,
        COUNT(*)::int                AS n,
        SUM(a.erro_m * a.erro_m)     AS soma_erro2_metodo,
        SUM(r.erro_m * r.erro_m)     AS soma_erro2_persistencia
      FROM avaliadas a
      JOIN referencia r
        ON r.slug = a.slug
       AND r.horizonte_h = a.horizonte_h
       AND r.alvo_em = a.alvo_em
       AND r.sentido = a.sentido
      WHERE a.metodo <> 'persistencia'
      GROUP BY a.metodo, a.horizonte_h, a.sentido
      ORDER BY a.metodo, a.horizonte_h, a.sentido
    `;

    // SUM() de NUMERIC volta como string no driver da Neon — converte antes
    // de qualquer conta, senão o "+" vira concatenação.
    const num = (v) => (v === null || v === undefined ? 0 : Number(v));

    const montarGrupo = (g) => ({
      metodo: g.metodo,
      horizonteH: Number(g.horizonte_h),
      ...(g.sentido === undefined ? {} : { sentido: g.sentido }),
      ...metricasProjecao({
        n: g.n,
        somaErro: num(g.soma_erro),
        somaAbsErro: num(g.soma_abs_erro),
        somaErro2: num(g.soma_erro2),
        somaReal: num(g.soma_real),
        somaReal2: num(g.soma_real2),
      }),
    });

    const montarSkill = (p) => ({
      metodo: p.metodo,
      horizonteH: Number(p.horizonte_h),
      ...(p.sentido === undefined ? {} : { sentido: p.sentido }),
      ...skillScore({
        n: p.n,
        somaErro2Metodo: num(p.soma_erro2_metodo),
        somaErro2Persistencia: num(p.soma_erro2_persistencia),
      }),
    });

    // Persistência primeiro em cada horizonte: é a linha de base contra a
    // qual as outras se leem, então é a que deve aparecer antes na tabela.
    // Nas estratificadas, o sentido vem logo depois do horizonte, pra que
    // as linhas de uma mesma célula (horizonte × sentido) fiquem juntas.
    const ordenar = (a, b) =>
      a.horizonteH - b.horizonteH ||
      (ORDEM_SENTIDOS[a.sentido] ?? 0) - (ORDEM_SENTIDOS[b.sentido] ?? 0) ||
      (ORDEM_METODOS[a.metodo] ?? 99) - (ORDEM_METODOS[b.metodo] ?? 99);

    const porGrupo = grupos.map(montarGrupo).sort(ordenar);
    const skillScores = pareados.map(montarSkill).sort(ordenar);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json({
      totalAvaliadas: porGrupo.reduce((soma, g) => soma + g.n, 0),
      pendentes,
      semLeituraNoAlvo: semLeitura,
      primeiraGeradaEm,
      ultimaAvaliadaEm,
      horizontes: [...new Set(porGrupo.map((g) => g.horizonteH))],
      grupos: porGrupo,
      skillScores,
      // Mesmo formato de grupos/skillScores, com `sentido` a mais. O n de
      // cada célula vem em `n` (grupos) e `nPareado` (skill score) — com
      // estratificação, células pequenas aparecem logo, e um SS sobre
      // poucas dezenas de pares não deve ser lido como resultado.
      gruposPorSentido: gruposPorSentido.map(montarGrupo).sort(ordenar),
      skillScoresPorSentido: pareadosPorSentido.map(montarSkill).sort(ordenar),
    });
  } catch (erro) {
    console.error('Falha ao agregar as projeções de nível:', erro);
    // Mensagem genérica no corpo, como nas outras rotas: `erro.message` do
    // driver do Neon pode vazar nome de tabela/coluna e detalhe de conexão.
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

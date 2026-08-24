import { sql } from '../lib/db.js';
import { ESTACOES_ANA } from '../lib/ana.js';

// GET /api/divergencia?dias=30
//
// Compara as duas fontes de NÍVEL: o feed do nivelguaiba.com.br (tabela
// `leituras`, a que o painel usa) e a API oficial da ANA (`leituras_ana`).
//
// Essa comparação é a razão de `leituras_ana` existir — o schema sempre disse
// que a tabela servia "pra comparar as duas fontes ao longo do tempo antes de
// considerar qualquer mudança maior", mas nada lia a coluna `nivel`: ela era
// gravada a cada 15 min e nunca olhada. É aqui que ela vira informação.
//
// O que isso responde, na prática: a ressalva de datum documentada estação
// por estação em lib/ana.js ("escolhemos a rede SGB-CPRM, mas só validamos a
// régua a fundo pra Porto Alegre"). Um offset mediano estável perto de zero
// = as duas réguas concordam. Um offset grande e estável = réguas diferentes
// por uma constante (caso do Gasômetro, ver nota em schema.sql). Um offset
// que DERIVA = alguma coisa mudou no meio do caminho, e aí vale investigar.

// Emparelhamento por bucket de hora, não por leitura mais próxima: as duas
// fontes não medem no mesmo instante nem na mesma cadência, e casar "a mais
// próxima" criaria pares com defasagem variável — num rio subindo rápido,
// 20 min de defasagem viram centímetros de diferença que não são divergência
// de régua, são só desencontro de horário. A média horária de cada fonte
// tira esse ruído.
export default async function handler(req, res) {
  const dias = Math.min(Math.max(parseInt(req.query?.dias, 10) || 30, 1), 365);

  try {
    const linhas = await sql`
      WITH feed AS (
        SELECT slug, date_trunc('hour', medido_em) AS hora, AVG(nivel) AS nivel
        FROM leituras
        WHERE medido_em >= NOW() - (${dias} * INTERVAL '1 day')
        GROUP BY 1, 2
      ),
      ana AS (
        SELECT slug, date_trunc('hour', medido_em) AS hora, AVG(nivel) AS nivel
        FROM leituras_ana
        WHERE medido_em >= NOW() - (${dias} * INTERVAL '1 day')
        GROUP BY 1, 2
      ),
      pares AS (
        SELECT f.slug, f.hora, a.nivel - f.nivel AS diferenca,
               -- Metade mais recente da janela, pra medir deriva sem
               -- precisar de uma segunda passada no banco.
               (f.hora >= NOW() - (${dias} * INTERVAL '1 day') / 2) AS recente
        FROM feed f
        JOIN ana a ON a.slug = f.slug AND a.hora = f.hora
      )
      SELECT
        p.slug,
        e.cidade,
        e.uf,
        e.rio,
        COUNT(*)::int                                                          AS horas_pareadas,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.diferenca)               AS mediana,
        percentile_cont(0.1) WITHIN GROUP (ORDER BY p.diferenca)               AS p10,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY p.diferenca)               AS p90,
        MIN(p.diferenca)                                                       AS minimo,
        MAX(p.diferenca)                                                       AS maximo,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.diferenca)
          FILTER (WHERE NOT p.recente)                                         AS mediana_antiga,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.diferenca)
          FILTER (WHERE p.recente)                                             AS mediana_recente
      FROM pares p
      JOIN estacoes e ON e.slug = p.slug
      GROUP BY p.slug, e.cidade, e.uf, e.rio, e.ordem
      ORDER BY e.ordem
    `;

    // Última leitura de cada fonte, pra flagrar uma fonte que congelou
    // enquanto a outra seguia — o tipo de coisa que a mediana esconde.
    const ultimas = await sql`
      SELECT e.slug,
             (SELECT MAX(medido_em) FROM leituras     l WHERE l.slug = e.slug) AS ultima_feed,
             (SELECT MAX(medido_em) FROM leituras_ana a WHERE a.slug = e.slug) AS ultima_ana
      FROM estacoes e
      WHERE e.ativa = TRUE
    `;
    const ultimaPorSlug = new Map(ultimas.map((u) => [u.slug, u]));

    const num = (v) => (v === null || v === undefined ? null : Number(Number(v).toFixed(3)));

    const estacoes = linhas.map((r) => {
      const mediana = num(r.mediana);
      const antiga = num(r.mediana_antiga);
      const recente = num(r.mediana_recente);
      const u = ultimaPorSlug.get(r.slug);

      return {
        slug: r.slug,
        cidade: r.cidade,
        uf: r.uf,
        rio: r.rio,
        horasPareadas: r.horas_pareadas,
        // Positivo = a ANA lê mais alto que o nivelguaiba.
        medianaM: mediana,
        p10M: num(r.p10),
        p90M: num(r.p90),
        minimoM: num(r.minimo),
        maximoM: num(r.maximo),
        // Largura do miolo (p10–p90): mede o quanto a diferença OSCILA, que
        // é coisa diferente de ela ser grande. Um offset de 1,18 m sempre
        // igual é régua diferente; um que varia 40 cm é as duas fontes
        // discordando de verdade.
        dispersaoM: mediana === null ? null : num(Number(r.p90) - Number(r.p10)),
        derivaM: antiga === null || recente === null ? null : num(recente - antiga),
        ultimaFeed: u?.ultima_feed ?? null,
        ultimaAna: u?.ultima_ana ?? null,
      };
    });

    // As 2 estações sem código ANA não são erro nem lacuna de dado — são
    // uma decisão documentada (ver ESTACOES_ANA em lib/ana.js). Dizer isso
    // explicitamente evita que a página pareça "faltando dado".
    const semAna = Object.keys(ESTACOES_ANA).length === 0 ? [] : (
      await sql`SELECT slug, cidade, uf FROM estacoes WHERE ativa = TRUE AND NOT (slug = ANY(${Object.keys(ESTACOES_ANA)})) ORDER BY ordem`
    ).map((e) => ({ slug: e.slug, cidade: e.cidade, uf: e.uf }));

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json({ janelaDias: dias, estacoes, semAna });
  } catch (erro) {
    console.error('Falha ao comparar as fontes de nível:', erro);
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

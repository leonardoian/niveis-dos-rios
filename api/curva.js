import { sql } from '../lib/db.js';
import { MINIMO_PARES, MINIMO_R2 } from '../lib/curva.js';

// GET /api/curva
//
// Quanto a previsão de NÍVEL (curva empírica sobre a vazão do modelo, ver
// lib/curva.js) acertou de verdade — medida contra o nível que a estação
// realmente registrou depois.
//
// Isto é o que justifica a curva existir. A vazão prevista crua é o único
// número do painel que não dá pra conferir: não temos medição independente
// de vazão, só outro resultado do mesmo modelo, e comparar modelo com modelo
// não é validação (mesmo argumento que a página /acerto já fazia pra não
// avaliar vazão). Convertida em nível, ela vira falsificável — nível a gente
// mede. Então a curva não é só uma conveniência de leitura: é o que torna
// aquela fonte auditável.
//
// A avaliação não precisa de tabela nova: `previsoes` guarda linhas de dias
// passados com o nivel_estimado_m que valia na época, e `leituras` tem o que
// aconteceu. É uma query sobre dado que já existe.
export default async function handler(req, res) {
  const dias = Math.min(Math.max(parseInt(req.query?.dias, 10) || 90, 1), 365);

  try {
    const linhas = await sql`
      WITH medido AS (
        SELECT p.slug, p.dia, p.nivel_estimado_m AS estimado, AVG(l.nivel) AS real_medido
        FROM previsoes p
        JOIN leituras l
          ON l.slug = p.slug
         AND l.medido_em >= p.dia::timestamptz
         AND l.medido_em <  p.dia::timestamptz + INTERVAL '1 day'
        WHERE p.dia < CURRENT_DATE
          AND p.dia >= CURRENT_DATE - (${dias} * INTERVAL '1 day')
          AND p.nivel_estimado_m IS NOT NULL
        GROUP BY p.slug, p.dia, p.nivel_estimado_m
      )
      SELECT
        m.slug, e.cidade, e.uf, e.rio,
        COUNT(*)::int                                                                AS dias_avaliados,
        AVG(ABS(m.estimado - m.real_medido))                                         AS erro_medio_m,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ABS(m.estimado - m.real_medido)) AS erro_mediano_m,
        MAX(ABS(m.estimado - m.real_medido))                                         AS erro_max_m,
        -- Viés com sinal: positivo = a curva estima ALTO demais. Separado do
        -- erro absoluto de propósito — uma curva que erra ±30 cm pra cima e
        -- pra baixo é coisa diferente de uma que erra 30 cm sempre pra cima
        -- (essa segunda dá pra corrigir).
        AVG(m.estimado - m.real_medido)                                              AS vies_m,
        c.n, c.r2, c.erro_medio_m AS erro_ajuste_m, c.ajustada_em
      FROM medido m
      JOIN estacoes e ON e.slug = m.slug
      LEFT JOIN curvas_nivel c ON c.slug = m.slug
      GROUP BY m.slug, e.cidade, e.uf, e.rio, e.ordem, c.n, c.r2, c.erro_medio_m, c.ajustada_em
      ORDER BY e.ordem
    `;

    // Estações com curva ajustada mas ainda sem nenhum dia avaliado — a
    // curva existe, só não teve dia passado com estimativa publicada ainda.
    // Mostrar isso separado evita a leitura errada de "a curva sumiu".
    const semAvaliacao = await sql`
      SELECT c.slug, e.cidade, e.uf, c.n, c.r2, c.erro_medio_m, c.ajustada_em
      FROM curvas_nivel c
      JOIN estacoes e ON e.slug = c.slug
      WHERE e.ativa = TRUE
        AND c.slug NOT IN (
          SELECT DISTINCT p.slug FROM previsoes p
          WHERE p.dia < CURRENT_DATE AND p.nivel_estimado_m IS NOT NULL
        )
      ORDER BY e.ordem
    `;

    const num = (v, casas = 3) => (v === null || v === undefined ? null : Number(Number(v).toFixed(casas)));
    const curva = (r) => (r.n === null ? null : {
      n: r.n,
      r2: num(r.r2, 4),
      erroAjusteM: num(r.erro_ajuste_m),
      ajustadaEm: r.ajustada_em,
      // Espelha curvaConfiavel de lib/curva.js pro front não reimplementar
      // o critério (e não sair do lugar quando os mínimos mudarem).
      confiavel: r.n >= MINIMO_PARES && r.r2 !== null && Number(r.r2) >= MINIMO_R2,
    });

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json({
      janelaDias: dias,
      minimos: { pares: MINIMO_PARES, r2: MINIMO_R2 },
      estacoes: linhas.map((r) => ({
        slug: r.slug,
        cidade: r.cidade,
        uf: r.uf,
        rio: r.rio,
        diasAvaliados: r.dias_avaliados,
        erroMedioM: num(r.erro_medio_m),
        erroMedianoM: num(r.erro_mediano_m),
        erroMaxM: num(r.erro_max_m),
        viesM: num(r.vies_m),
        curva: curva(r),
      })),
      semAvaliacao: semAvaliacao.map((c) => ({
        slug: c.slug,
        cidade: c.cidade,
        uf: c.uf,
        curva: curva({ n: c.n, r2: c.r2, erro_ajuste_m: c.erro_medio_m, ajustada_em: c.ajustada_em }),
      })),
    });
  } catch (erro) {
    console.error('Falha ao avaliar a curva de nível:', erro);
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

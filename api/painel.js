import { sql } from '../lib/db.js';

// Retorna o estado atual de todas as estações, no formato que o painel consome.
// A velocidade (cm/h) é calculada aqui a partir das duas últimas leituras —
// o feed não fornece esse dado.
export default async function handler(req, res) {
  try {
    const linhas = await sql`
      WITH ranqueadas AS (
        SELECT
          l.slug,
          l.nivel,
          l.medido_em,
          ROW_NUMBER() OVER (PARTITION BY l.slug ORDER BY l.medido_em DESC) AS pos
        FROM leituras l
      ),
      atual AS (
        SELECT slug, nivel, medido_em FROM ranqueadas WHERE pos = 1
      ),
      anterior AS (
        SELECT slug, nivel, medido_em FROM ranqueadas WHERE pos = 2
      )
      SELECT
        e.slug,
        e.cidade,
        e.uf,
        e.rio,
        e.estacao,
        e.cota_inundacao,
        a.nivel        AS nivel_atual,
        a.medido_em    AS medido_em,
        p.nivel        AS nivel_anterior,
        p.medido_em    AS medido_em_anterior
      FROM estacoes e
      LEFT JOIN atual a    ON a.slug = e.slug
      LEFT JOIN anterior p ON p.slug = e.slug
      WHERE e.ativa = TRUE
      ORDER BY e.ordem
    `;

    // Série curta por estação, pra desenhar o mini-gráfico de tendência no
    // card — pega as últimas N leituras por contagem (não por janela de
    // tempo), senão uma estação com poucas leituras recentes ou com um
    // buraco no meio ficaria sem mini-gráfico mesmo tendo dado suficiente.
    const serieBruta = await sql`
      SELECT slug, nivel, medido_em
      FROM (
        SELECT
          l.slug,
          l.nivel,
          l.medido_em,
          ROW_NUMBER() OVER (PARTITION BY l.slug ORDER BY l.medido_em DESC) AS pos
        FROM leituras l
        WHERE l.slug IN (SELECT slug FROM estacoes WHERE ativa = TRUE)
      ) recentes
      WHERE pos <= 12
      ORDER BY slug, medido_em ASC
    `;

    const seriePorSlug = new Map();
    for (const p of serieBruta) {
      if (!seriePorSlug.has(p.slug)) seriePorSlug.set(p.slug, []);
      seriePorSlug.get(p.slug).push({ nivel: Number(p.nivel), medidoEm: p.medido_em });
    }

    const estacoes = linhas.map((r) => {
      const nivel = r.nivel_atual === null ? null : Number(r.nivel_atual);
      const cota = Number(r.cota_inundacao);

      // cm/h = (variação em metros × 100) / horas decorridas
      let velocidade = null;
      if (nivel !== null && r.nivel_anterior !== null) {
        const horas =
          (new Date(r.medido_em) - new Date(r.medido_em_anterior)) / 3_600_000;
        if (horas > 0) {
          velocidade = ((nivel - Number(r.nivel_anterior)) * 100) / horas;
        }
      }

      return {
        slug: r.slug,
        cidade: r.cidade,
        uf: r.uf,
        rio: r.rio,
        estacao: r.estacao,
        cota: cota,
        nivel: nivel,
        medidoEm: r.medido_em,
        velocidadeCmH: velocidade === null ? null : Number(velocidade.toFixed(1)),
        percentualCota: nivel === null ? null : Number(((nivel / cota) * 100).toFixed(1)),
        margem: nivel === null ? null : Number((cota - nivel).toFixed(2)),
        status: classificar(nivel, cota),
        serieRecente: seriePorSlug.get(r.slug) || [],
      };
    });

    const comDado = estacoes.filter((e) => e.nivel !== null);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      atualizadoEm: new Date().toISOString(),
      resumo: {
        total: estacoes.length,
        emAlerta: comDado.filter((e) => e.status === 'alerta').length,
        acimaDaCota: comDado.filter((e) => e.status === 'alagado').length,
        subindo: comDado.filter((e) => e.velocidadeCmH > 0).length,
      },
      estacoes,
    });
  } catch (erro) {
    console.error('Falha ao montar painel:', erro);
    return res.status(500).json({ erro: erro.message });
  }
}

function classificar(nivel, cota) {
  if (nivel === null) return 'sem_dado';
  const razao = nivel / cota;
  if (razao >= 1) return 'alagado';
  if (razao >= 0.8) return 'alerta';
  if (razao >= 0.6) return 'atencao';
  return 'normal';
}

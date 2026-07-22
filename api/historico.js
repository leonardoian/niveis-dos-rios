import { sql } from '../lib/db.js';

// GET /api/historico?slug=portoalegre&horas=24
// Série temporal de uma estação, para o gráfico do painel.
export default async function handler(req, res) {
  const { slug, horas = '24' } = req.query;

  if (!slug) {
    return res.status(400).json({ erro: 'Informe o parâmetro slug.' });
  }

  const janela = Math.min(Math.max(parseInt(horas, 10) || 24, 1), 2160); // até 90 dias

  try {
    const estacao = await sql`
      SELECT slug, cidade, rio, estacao, cota_inundacao
      FROM estacoes WHERE slug = ${slug}
    `;

    if (estacao.length === 0) {
      return res.status(404).json({ erro: 'Estação não encontrada.' });
    }

    const pontos = await sql`
      SELECT nivel, medido_em
      FROM leituras
      WHERE slug = ${slug}
        AND medido_em >= NOW() - (${janela} * INTERVAL '1 hour')
      ORDER BY medido_em ASC
    `;

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({
      estacao: {
        slug: estacao[0].slug,
        cidade: estacao[0].cidade,
        rio: estacao[0].rio,
        nome: estacao[0].estacao,
        cota: Number(estacao[0].cota_inundacao),
      },
      janelaHoras: janela,
      pontos: pontos.map((p) => ({
        nivel: Number(p.nivel),
        medidoEm: p.medido_em,
      })),
    });
  } catch (erro) {
    console.error('Falha ao buscar histórico:', erro);
    return res.status(500).json({ erro: erro.message });
  }
}

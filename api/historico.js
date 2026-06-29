// api/historico.js
// GET /api/historico?estacao=CODIGO
// Retorna leituras das últimas 72h de uma estação, em ordem cronológica.
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { estacao } = req.query;
  if (!estacao || !/^\d+$/.test(estacao)) {
    return res.status(400).json({ erro: 'parâmetro estacao inválido ou ausente' });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    const leituras = await sql`
      SELECT medido_em, nivel_m
      FROM leituras
      WHERE estacao = ${estacao}
        AND medido_em >= now() - interval '72 hours'
      ORDER BY medido_em ASC
    `;
    return res.status(200).json(leituras);
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
}

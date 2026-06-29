// api/estacoes.js
// GET /api/estacoes — retorna todas as estações ativas com status atual.
// Leitura pública; sem autenticação.
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const sql = neon(process.env.DATABASE_URL);
  try {
    const estacoes = await sql`
      SELECT
        codigo, nome, rio, municipio,
        latitude, longitude,
        nivel_m, medido_em,
        cota_atencao, cota_alerta, cota_inundacao,
        status
      FROM estacao_status
      ORDER BY nome
    `;
    return res.status(200).json(estacoes);
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
}

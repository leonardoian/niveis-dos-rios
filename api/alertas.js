import { sql } from '../lib/db.js';

// Lista os alertas mais recentes (mudança de status registrada por
// lib/coletar.js) já com o nome da cidade, pro painel mostrar um histórico
// legível sem o usuário precisar abrir o banco.
export default async function handler(req, res) {
  try {
    const linhas = await sql`
      SELECT a.slug, e.cidade, e.uf, e.rio, a.status, a.nivel, a.criado_em
      FROM alertas a
      JOIN estacoes e ON e.slug = a.slug
      ORDER BY a.criado_em DESC
      LIMIT 30
    `;

    const alertas = linhas.map((a) => ({
      slug: a.slug,
      cidade: a.cidade,
      uf: a.uf,
      rio: a.rio,
      status: a.status,
      nivel: Number(a.nivel),
      criadoEm: a.criado_em,
    }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ alertas });
  } catch (erro) {
    console.error('Falha ao buscar alertas:', erro);
    return res.status(500).json({ erro: erro.message });
  }
}

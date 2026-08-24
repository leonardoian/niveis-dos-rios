import { sql } from '../lib/db.js';

// Lista os alertas mais recentes (mudança de status registrada por
// lib/coletar.js) já com o nome da cidade, pro painel mostrar um histórico
// legível sem o usuário precisar abrir o banco.
export default async function handler(req, res) {
  try {
    const linhas = await sql`
      SELECT a.slug, e.cidade, e.uf, e.rio, a.status, a.nivel, a.tipo, a.chuva_mm_acumulada, a.velocidade_cm_h, a.criado_em
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
      tipo: a.tipo,
      nivel: a.nivel === null ? null : Number(a.nivel),
      chuvaMmAcumulada: a.chuva_mm_acumulada === null ? null : Number(a.chuva_mm_acumulada),
      velocidadeCmH: a.velocidade_cm_h === null ? null : Number(a.velocidade_cm_h),
      criadoEm: a.criado_em,
    }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ alertas });
  } catch (erro) {
    console.error('Falha ao buscar alertas:', erro);
    // Mensagem genérica no corpo: `erro.message` do driver do Neon pode
    // trazer nome de tabela/coluna e detalhe de conexão, e nenhum
    // consumidor precisa disso (o front usa só o status HTTP). O erro
    // real fica no console.error acima, nos logs do Vercel.
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

import { sql } from '../lib/db.js';
import { agregarAcertoPorVersao } from '../lib/calculo.js';

// Acerto da nossa estimativa "⏱ atinge a cota" / "↩ volta ao normal" (ver
// calcularEtaCota em lib/calculo.js e o registro/avaliação em
// lib/coletar.js), agrupado por VERSÃO do estimador e, dentro dela, por
// antecedência — só existe pra essa estimativa (e não pra vazão prevista)
// porque é a única que dá pra validar contra uma medição real nossa, não
// contra outro modelo. Ver README.
//
// Por versão, e sem um total que misture as duas: a v1 (ingênua) e a v2
// são geradas por regras diferentes (ver estimador_versao em schema.sql), e
// uma taxa somando as duas não descreveria nenhum dos dois estimadores. As
// faixas e o critério de acerto são os mesmos nas duas — é isso que torna
// a comparação v1 × v2 legítima.
export default async function handler(req, res) {
  try {
    const avaliadas = await sql`
      SELECT ec.slug, e.cidade, e.uf, ec.classe, ec.horas_estimadas, ec.alvo_em,
             ec.resultado, ec.erro_horas, ec.nivel_no_calculo, ec.nivel_real_no_alvo,
             ec.estimador_versao
      FROM estimativas_cota ec
      JOIN estacoes e ON e.slug = ec.slug
      WHERE ec.avaliado_em IS NOT NULL
      ORDER BY ec.avaliado_em DESC
    `;

    const pendentesBrutos = await sql`
      SELECT estimador_versao, COUNT(*)::int AS pendentes
      FROM estimativas_cota
      WHERE avaliado_em IS NULL
      GROUP BY estimador_versao
    `;
    const pendentesPorVersao = Object.fromEntries(
      pendentesBrutos.map((p) => [Number(p.estimador_versao), p.pendentes])
    );

    const porVersao = agregarAcertoPorVersao(
      avaliadas.map((a) => ({
        estimadorVersao: Number(a.estimador_versao),
        horasEstimadas: Number(a.horas_estimadas),
        resultado: a.resultado,
      })),
      pendentesPorVersao
    );

    const recentes = avaliadas.slice(0, 30).map((a) => ({
      slug: a.slug,
      cidade: a.cidade,
      uf: a.uf,
      classe: a.classe,
      estimadorVersao: Number(a.estimador_versao),
      horasEstimadas: Number(a.horas_estimadas),
      alvoEm: a.alvo_em,
      resultado: a.resultado,
      erroHoras: a.erro_horas === null ? null : Number(a.erro_horas),
      nivelNoCalculo: Number(a.nivel_no_calculo),
      nivelRealNoAlvo: a.nivel_real_no_alvo === null ? null : Number(a.nivel_real_no_alvo),
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json({
      // Contagens brutas (todas as versões) só como volume — a taxa de
      // acerto existe apenas dentro de porVersao.
      totalAvaliadas: avaliadas.length,
      pendentes: porVersao.reduce((soma, v) => soma + v.pendentes, 0),
      porVersao,
      recentes,
    });
  } catch (erro) {
    console.error('Falha ao buscar acerto das estimativas:', erro);
    // Mensagem genérica no corpo: `erro.message` do driver do Neon pode
    // trazer nome de tabela/coluna e detalhe de conexão, e nenhum
    // consumidor precisa disso (o front usa só o status HTTP). O erro
    // real fica no console.error acima, nos logs do Vercel.
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

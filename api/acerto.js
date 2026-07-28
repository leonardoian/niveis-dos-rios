import { sql } from '../lib/db.js';

// Acerto da nossa estimativa "⏱ atinge a cota" / "↩ volta ao normal" (ver
// calcularEtaCota em lib/calculo.js e o registro/avaliação em
// lib/coletar.js), agrupado por antecedência — só existe pra essa
// estimativa (e não pra vazão prevista) porque é a única que dá pra validar
// contra uma medição real nossa, não contra outro modelo. Ver README.
const FAIXAS = [
  { chave: 'ate6h', rotulo: 'até 6h', min: 0, max: 6 },
  { chave: '6a24h', rotulo: '6–24h', min: 6, max: 24 },
  { chave: 'mais24h', rotulo: 'mais de 24h', min: 24, max: Infinity },
];

export default async function handler(req, res) {
  try {
    const avaliadas = await sql`
      SELECT ec.slug, e.cidade, e.uf, ec.classe, ec.horas_estimadas, ec.alvo_em,
             ec.resultado, ec.erro_horas, ec.nivel_no_calculo, ec.nivel_real_no_alvo
      FROM estimativas_cota ec
      JOIN estacoes e ON e.slug = ec.slug
      WHERE ec.avaliado_em IS NOT NULL
      ORDER BY ec.avaliado_em DESC
    `;

    const [{ pendentes }] = await sql`
      SELECT COUNT(*)::int AS pendentes FROM estimativas_cota WHERE avaliado_em IS NULL
    `;

    const porFaixa = FAIXAS.map((f) => {
      const doGrupo = avaliadas.filter((a) => {
        const h = Number(a.horas_estimadas);
        return h >= f.min && h < f.max;
      });
      const acertos = doGrupo.filter((a) => a.resultado === 'acertou').length;
      return {
        faixa: f.rotulo,
        total: doGrupo.length,
        acertos,
        taxa: doGrupo.length === 0 ? null : Number((acertos / doGrupo.length).toFixed(2)),
      };
    });

    const recentes = avaliadas.slice(0, 30).map((a) => ({
      slug: a.slug,
      cidade: a.cidade,
      uf: a.uf,
      classe: a.classe,
      horasEstimadas: Number(a.horas_estimadas),
      alvoEm: a.alvo_em,
      resultado: a.resultado,
      erroHoras: a.erro_horas === null ? null : Number(a.erro_horas),
      nivelNoCalculo: Number(a.nivel_no_calculo),
      nivelRealNoAlvo: a.nivel_real_no_alvo === null ? null : Number(a.nivel_real_no_alvo),
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json({
      totalAvaliadas: avaliadas.length,
      pendentes,
      porFaixa,
      recentes,
    });
  } catch (erro) {
    console.error('Falha ao buscar acerto das estimativas:', erro);
    return res.status(500).json({ erro: erro.message });
  }
}

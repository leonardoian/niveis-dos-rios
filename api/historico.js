import { sql } from '../lib/db.js';

// GET /api/historico?slug=portoalegre&horas=24
// Série temporal de uma estação, para o gráfico do painel.

// Acima disso a série vem do agregado horário em vez do dado bruto. 7 dias
// em bruto são ~670 pontos por estação — ainda confortável; 30 dias seriam
// ~2.900 e 90 dias ~8.600, mais do que a tela resolve.
const LIMITE_BRUTO_HORAS = 24 * 7;
export default async function handler(req, res) {
  const { slug, horas = '24' } = req.query;

  if (!slug) {
    return res.status(400).json({ erro: 'Informe o parâmetro slug.' });
  }

  const janela = Math.min(Math.max(parseInt(horas, 10) || 24, 1), 2160); // até 90 dias

  try {
    const estacao = await sql`
      SELECT slug, cidade, rio, estacao, cota_inundacao, nivel_cheia_2024, data_cheia_2024
      FROM estacoes WHERE slug = ${slug}
    `;

    if (estacao.length === 0) {
      return res.status(404).json({ erro: 'Estação não encontrada.' });
    }

    // Janela curta lê o dado bruto (resolução de 15 min, que é o que o
    // gráfico de 24h/3d precisa mostrar). Janela longa lê o agregado
    // horário: 90 dias em bruto são ~8.600 pontos por estação, mais do que
    // qualquer tela resolve e caro de trazer a cada abertura de modal.
    //
    // O agregado devolve o MÁXIMO da hora, não a média: numa escala de
    // semanas é o pico da cheia que importa, e a média horária o suavizaria
    // justamente onde ninguém quer suavização. Como o rollup é preenchido a
    // cada coleta, ele também é o que sustenta a série se a retenção de
    // dado bruto for ligada um dia (ver aplicarRetencao em lib/coletar.js).
    const usarRollup = janela > LIMITE_BRUTO_HORAS;

    const pontos = usarRollup
      ? await sql`
          SELECT nivel_max AS nivel, hora AS medido_em
          FROM leituras_horarias
          WHERE slug = ${slug}
            AND hora >= NOW() - (${janela} * INTERVAL '1 hour')
          ORDER BY hora ASC
        `
      : await sql`
          SELECT nivel, medido_em
          FROM leituras
          WHERE slug = ${slug}
            AND medido_em >= NOW() - (${janela} * INTERVAL '1 hour')
          ORDER BY medido_em ASC
        `;

    // Maior nível já registrado pra essa estação, em toda a série histórica
    // (não só na janela pedida) — usado pra desenhar a linha de recorde no
    // gráfico, dando noção de "isso está perto do pior que já aconteceu?".
    const recorde = await sql`
      SELECT nivel, medido_em
      FROM leituras
      WHERE slug = ${slug}
      ORDER BY nivel DESC
      LIMIT 1
    `;

    // Chuva medida (ANA) na mesma janela — só tem dado pras 12 estações
    // mapeadas em ESTACOES_ANA; pras outras 2, ou fora da janela, vem []
    // (o frontend só precisa checar length, não precisa saber por quê).
    const chuvaAna = await sql`
      SELECT chuva_mm, medido_em
      FROM leituras_ana
      WHERE slug = ${slug}
        AND medido_em >= NOW() - (${janela} * INTERVAL '1 hour')
        AND chuva_mm IS NOT NULL
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
      cheia2024: estacao[0].nivel_cheia_2024 === null ? null : {
        nivel: Number(estacao[0].nivel_cheia_2024),
        data: estacao[0].data_cheia_2024,
      },
      janelaHoras: janela,
      // 'bruto' = leitura de 15 em 15 min; 'horario' = máximo por hora.
      // O front usa isso pra rotular o gráfico em vez de deixar o leitor
      // supor que está vendo todas as leituras.
      resolucao: usarRollup ? 'horario' : 'bruto',
      pontos: pontos.map((p) => ({
        nivel: Number(p.nivel),
        medidoEm: p.medido_em,
      })),
      recorde: recorde.length > 0
        ? { nivel: Number(recorde[0].nivel), medidoEm: recorde[0].medido_em }
        : null,
      chuvaAna: chuvaAna.map((c) => ({
        chuvaMm: Number(c.chuva_mm),
        medidoEm: c.medido_em,
      })),
    });
  } catch (erro) {
    console.error('Falha ao buscar histórico:', erro);
    // Mensagem genérica no corpo: `erro.message` do driver do Neon pode
    // trazer nome de tabela/coluna e detalhe de conexão, e nenhum
    // consumidor precisa disso (o front usa só o status HTTP). O erro
    // real fica no console.error acima, nos logs do Vercel.
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

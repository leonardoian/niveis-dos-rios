import { sql } from '../lib/db.js';

// Histórico de saúde das fontes, a partir da tabela `coletas` (uma linha por
// rodada, gravada por registrarColeta em lib/coletar.js).
//
// Complementa o `frescor` do /api/painel em vez de repeti-lo: frescor diz se
// o dado está velho AGORA; isto diz se aquilo é um soluço ou o terceiro do
// dia — e se a coleta em si chegou a rodar, coisa que o painel não consegue
// distinguir de "rodou e o feed não tinha novidade".
const JANELAS = [
  { chave: '24h', horas: 24 },
  { chave: '7d', horas: 24 * 7 },
];

// A coleta é agendada a cada 15 min por duas fontes intercaladas (ver
// README). Uma lacuna acima disso com folga significa que as DUAS falharam,
// que é o que vale a pena mostrar.
const INTERVALO_ESPERADO_MIN = 15;

export default async function handler(req, res) {
  try {
    const janelas = {};

    for (const j of JANELAS) {
      const [linha] = await sql`
        SELECT
          COUNT(*)::int                                        AS total,
          COUNT(*) FILTER (WHERE feed_ok)::int                 AS feed_ok,
          COUNT(*) FILTER (WHERE ana_ok IS NOT NULL)::int      AS ana_avaliadas,
          COUNT(*) FILTER (WHERE ana_ok)::int                  AS ana_ok,
          COALESCE(SUM(leituras_inseridas), 0)::int            AS leituras_inseridas,
          COALESCE(SUM(leituras_ana_inseridas), 0)::int        AS leituras_ana_inseridas,
          COALESCE(SUM(alertas_criados), 0)::int               AS alertas_criados,
          COALESCE(SUM(projecoes_gravadas), 0)::int            AS projecoes_gravadas,
          COUNT(*) FILTER (WHERE erro_projecoes IS NOT NULL)::int AS projecoes_com_erro,
          ROUND(AVG(duracao_ms))::int                          AS duracao_media_ms,
          MAX(duracao_ms)::int                                 AS duracao_max_ms
        FROM coletas
        WHERE iniciada_em >= NOW() - (${j.horas} * INTERVAL '1 hour')
      `;

      // Maior intervalo entre duas rodadas consecutivas na janela — é o que
      // revela "ficou 3h sem coletar", que nenhuma média mostra. LAG pega a
      // anterior; o COALESCE do primeiro registro vira 0 e é descartado.
      const [{ maior_lacuna_min: maiorLacunaMin }] = await sql`
        SELECT COALESCE(MAX(diferenca), 0)::int AS maior_lacuna_min
        FROM (
          SELECT EXTRACT(EPOCH FROM (iniciada_em - LAG(iniciada_em) OVER (ORDER BY iniciada_em))) / 60 AS diferenca
          FROM coletas
          WHERE iniciada_em >= NOW() - (${j.horas} * INTERVAL '1 hour')
        ) intervalos
      `;

      const taxa = (parte, total) => (total === 0 ? null : Number((parte / total).toFixed(3)));

      janelas[j.chave] = {
        totalColetas: linha.total,
        feed: {
          ok: linha.feed_ok,
          falhas: linha.total - linha.feed_ok,
          taxa: taxa(linha.feed_ok, linha.total),
        },
        // ana_ok NULL (credencial não configurada) não conta como falha —
        // sai da conta inteira em vez de puxar a taxa pra baixo.
        ana: linha.ana_avaliadas === 0 ? null : {
          ok: linha.ana_ok,
          falhas: linha.ana_avaliadas - linha.ana_ok,
          taxa: taxa(linha.ana_ok, linha.ana_avaliadas),
        },
        leiturasInseridas: linha.leituras_inseridas,
        leiturasAnaInseridas: linha.leituras_ana_inseridas,
        alertasCriados: linha.alertas_criados,
        // Projeções de nível (ver projecoes_nivel em schema.sql). São
        // horárias, então 3 de cada 4 rodadas gravam 0 legitimamente — é a
        // soma da janela que diz se está saudável (~112/h, ou seja, ~2,7 mil
        // em 24h com as 14 estações). Zero na janela inteira, com coletas
        // acontecendo, significa que a instrumentação parou: como ela roda
        // em try/catch pra não derrubar a coleta, este contador (e o
        // projecoesComErro ao lado) é o único lugar onde isso aparece.
        projecoesGravadas: linha.projecoes_gravadas,
        projecoesComErro: linha.projecoes_com_erro,
        duracaoMediaMs: linha.duracao_media_ms,
        duracaoMaxMs: linha.duracao_max_ms,
        maiorLacunaMin: maiorLacunaMin,
        // A lacuna só é "anormal" com folga sobre o intervalo agendado: o
        // GitHub Actions atrasa uns minutos rotineiramente (ver README).
        lacunaAnormal: maiorLacunaMin > INTERVALO_ESPERADO_MIN * 3,
      };
    }

    const [ultima] = await sql`
      SELECT iniciada_em, feed_ok, erro_feed, ana_ok, duracao_ms
      FROM coletas ORDER BY iniciada_em DESC LIMIT 1
    `;

    const [ultimaFalha] = await sql`
      SELECT iniciada_em, erro_feed
      FROM coletas WHERE NOT feed_ok ORDER BY iniciada_em DESC LIMIT 1
    `;

    // Mesmo tratamento que a falha de feed já tinha: sem a mensagem em
    // algum lugar visível, um erro engolido pelo try/catch das projeções
    // (tabela faltando, coluna nova sem migração) só apareceria pra quem
    // fosse ler o log do Vercel — ou seja, nunca.
    const [ultimaFalhaProjecoes] = await sql`
      SELECT iniciada_em, erro_projecoes
      FROM coletas WHERE erro_projecoes IS NOT NULL ORDER BY iniciada_em DESC LIMIT 1
    `;

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({
      intervaloEsperadoMin: INTERVALO_ESPERADO_MIN,
      ultimaColeta: !ultima ? null : {
        iniciadaEm: ultima.iniciada_em,
        feedOk: ultima.feed_ok,
        erroFeed: ultima.erro_feed,
        anaOk: ultima.ana_ok,
        duracaoMs: ultima.duracao_ms,
      },
      ultimaFalhaFeed: !ultimaFalha ? null : {
        iniciadaEm: ultimaFalha.iniciada_em,
        erro: ultimaFalha.erro_feed,
      },
      ultimaFalhaProjecoes: !ultimaFalhaProjecoes ? null : {
        iniciadaEm: ultimaFalhaProjecoes.iniciada_em,
        erro: ultimaFalhaProjecoes.erro_projecoes,
      },
      janelas,
    });
  } catch (erro) {
    console.error('Falha ao montar saúde das fontes:', erro);
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

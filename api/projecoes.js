import { sql } from '../lib/db.js';
import { metricasProjecao } from '../lib/calculo.js';

// GET /api/projecoes
//
// Erro das projeções de NÍVEL por horizonte fixo (ver projecoes_nivel em
// schema.sql), agrupado por método × horizonte. É a rota que responde a
// pergunta do TCC: até que horizonte a persistência — "o nível fica onde
// está" — ainda produz estimativa útil, e a partir de onde os outros
// métodos passam a valer a pena.
//
// Diferente de /api/acerto, que mede a estimativa de TEMPO até a cota
// ("acertou/errou"), aqui o objeto medido é o NÍVEL em metros, com as
// métricas contínuas que a literatura de previsão fluvial usa (RMSE, NSE) —
// é o que torna o resultado comparável com trabalhos publicados, incluindo
// as previsões emergenciais do Guaíba na RBRH 30 (2025), que registra
// justamente a falta de uma referência de persistência.
//
// Sem parâmetro de janela, de propósito: as outras rotas de avaliação
// recortam por dias porque servem uma página que mostra "como está agora";
// esta serve uma análise, e uma métrica calculada sobre uma janela móvel
// muda de valor a cada dia sem que nada tenha mudado no método. O recorte,
// quando for preciso, se faz sobre a tabela.
const ORDEM_METODOS = { persistencia: 0, tendencia: 1, curva: 2 };

export default async function handler(req, res) {
  try {
    // O Postgres agrega e devolve só as somas suficientes — a tabela ganha
    // ~112 linhas por rodada (~10 mil por dia), então trazer as linhas cruas
    // pro Node pra somar aqui deixaria de funcionar em poucas semanas. A
    // derivação das métricas em cima dessas somas é metricasProjecao
    // (lib/calculo.js), pura e testada em tests/calculo.test.js.
    const grupos = await sql`
      SELECT
        metodo,
        horizonte_h,
        COUNT(*)::int          AS n,
        SUM(erro_m)            AS soma_erro,
        SUM(ABS(erro_m))       AS soma_abs_erro,
        SUM(erro_m * erro_m)   AS soma_erro2,
        SUM(nivel_real)        AS soma_real,
        SUM(nivel_real * nivel_real) AS soma_real2
      FROM projecoes_nivel
      WHERE avaliada_em IS NOT NULL
        AND erro_m IS NOT NULL
      GROUP BY metodo, horizonte_h
      ORDER BY metodo, horizonte_h
    `;

    // Pendentes e "avaliada sem leitura no alvo" contadas à parte: as duas
    // são zero saudável, e uma delas crescendo diz coisas diferentes —
    // pendente demais é avaliação travada, sem-leitura demais é buraco de
    // telemetria. Nenhuma das duas entra nas métricas.
    const [{ pendentes, sem_leitura: semLeitura, primeira_gerada_em: primeiraGeradaEm, ultima_avaliada_em: ultimaAvaliadaEm }] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE avaliada_em IS NULL)::int                        AS pendentes,
        COUNT(*) FILTER (WHERE avaliada_em IS NOT NULL AND erro_m IS NULL)::int AS sem_leitura,
        MIN(gerada_em)                                                          AS primeira_gerada_em,
        MAX(avaliada_em)                                                        AS ultima_avaliada_em
      FROM projecoes_nivel
    `;

    // SUM() de NUMERIC volta como string no driver da Neon — converte antes
    // de qualquer conta, senão o "+" vira concatenação.
    const num = (v) => (v === null || v === undefined ? 0 : Number(v));

    const porGrupo = grupos
      .map((g) => ({
        metodo: g.metodo,
        horizonteH: Number(g.horizonte_h),
        ...metricasProjecao({
          n: g.n,
          somaErro: num(g.soma_erro),
          somaAbsErro: num(g.soma_abs_erro),
          somaErro2: num(g.soma_erro2),
          somaReal: num(g.soma_real),
          somaReal2: num(g.soma_real2),
        }),
      }))
      // Persistência primeiro em cada horizonte: é a linha de base contra a
      // qual as outras se leem, então é a que deve aparecer antes na tabela.
      .sort((a, b) =>
        a.horizonteH - b.horizonteH ||
        (ORDEM_METODOS[a.metodo] ?? 99) - (ORDEM_METODOS[b.metodo] ?? 99)
      );

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json({
      totalAvaliadas: porGrupo.reduce((soma, g) => soma + g.n, 0),
      pendentes,
      semLeituraNoAlvo: semLeitura,
      primeiraGeradaEm,
      ultimaAvaliadaEm,
      horizontes: [...new Set(porGrupo.map((g) => g.horizonteH))],
      grupos: porGrupo,
    });
  } catch (erro) {
    console.error('Falha ao agregar as projeções de nível:', erro);
    // Mensagem genérica no corpo, como nas outras rotas: `erro.message` do
    // driver do Neon pode vazar nome de tabela/coluna e detalhe de conexão.
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

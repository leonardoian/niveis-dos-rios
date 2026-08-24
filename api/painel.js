import { sql } from '../lib/db.js';
import { classificar, calcularVelocidade, calcularFrescor, calcularVariacao24h } from '../lib/calculo.js';

// Retorna o estado atual de todas as estações, no formato que o painel consome.
// A velocidade (cm/h) é calculada aqui a partir das duas últimas leituras —
// o feed não fornece esse dado.
export default async function handler(req, res) {
  try {
    const linhas = await sql`
      WITH ranqueadas AS (
        SELECT
          l.slug,
          l.nivel,
          l.medido_em,
          ROW_NUMBER() OVER (PARTITION BY l.slug ORDER BY l.medido_em DESC) AS pos
        FROM leituras l
      ),
      atual AS (
        SELECT slug, nivel, medido_em FROM ranqueadas WHERE pos = 1
      ),
      anterior AS (
        SELECT slug, nivel, medido_em FROM ranqueadas WHERE pos = 2
      )
      SELECT
        e.slug,
        e.cidade,
        e.uf,
        e.rio,
        e.estacao,
        e.cota_inundacao,
        e.nivel_cheia_2024,
        e.data_cheia_2024,
        e.nota,
        a.nivel        AS nivel_atual,
        a.medido_em    AS medido_em,
        p.nivel        AS nivel_anterior,
        p.medido_em    AS medido_em_anterior
      FROM estacoes e
      LEFT JOIN atual a    ON a.slug = e.slug
      LEFT JOIN anterior p ON p.slug = e.slug
      WHERE e.ativa = TRUE
      ORDER BY e.ordem
    `;

    // Série curta por estação, pra desenhar o mini-gráfico de tendência no
    // card — pega as últimas N leituras por contagem (não por janela de
    // tempo), senão uma estação com poucas leituras recentes ou com um
    // buraco no meio ficaria sem mini-gráfico mesmo tendo dado suficiente.
    const serieBruta = await sql`
      SELECT slug, nivel, medido_em
      FROM (
        SELECT
          l.slug,
          l.nivel,
          l.medido_em,
          ROW_NUMBER() OVER (PARTITION BY l.slug ORDER BY l.medido_em DESC) AS pos
        FROM leituras l
        WHERE l.slug IN (SELECT slug FROM estacoes WHERE ativa = TRUE)
      ) recentes
      WHERE pos <= 12
      ORDER BY slug, medido_em ASC
    `;

    const seriePorSlug = new Map();
    for (const p of serieBruta) {
      if (!seriePorSlug.has(p.slug)) seriePorSlug.set(p.slug, []);
      seriePorSlug.get(p.slug).push({ nivel: Number(p.nivel), medidoEm: p.medido_em });
    }

    // Leitura mais recente que já tem PELO MENOS 24h — referência pro KPI
    // "maior subida em 24h". Não interpola nem pega a leitura mais próxima
    // de qualquer lado: se a estação não tem nenhuma leitura com 24h+ (ex.:
    // estação nova), fica sem referência e a variação vira null — em vez de
    // fingir uma janela de 24h que não temos.
    const referencia24hBruta = await sql`
      SELECT DISTINCT ON (slug) slug, nivel
      FROM leituras
      WHERE slug IN (SELECT slug FROM estacoes WHERE ativa = TRUE)
        AND medido_em <= NOW() - INTERVAL '24 hours'
      ORDER BY slug, medido_em DESC
    `;
    const referencia24hPorSlug = new Map(
      referencia24hBruta.map((r) => [r.slug, Number(r.nivel)])
    );

    // Previsão de vazão (m³/s, dado à parte do nível — ver lib/previsao.js) e
    // clima dos próximos dias.
    const previsaoBruta = await sql`
      SELECT slug, dia, vazao_m3s, temp_max, temp_min, chuva_mm, condicao_codigo, chance_chuva_pct, nivel_estimado_m
      FROM previsoes
      WHERE slug IN (SELECT slug FROM estacoes WHERE ativa = TRUE)
        AND dia >= CURRENT_DATE
      ORDER BY slug, dia ASC
    `;

    const previsaoPorSlug = new Map();
    for (const p of previsaoBruta) {
      if (!previsaoPorSlug.has(p.slug)) previsaoPorSlug.set(p.slug, []);
      previsaoPorSlug.get(p.slug).push({
        dia: p.dia,
        vazaoM3s: p.vazao_m3s === null ? null : Number(p.vazao_m3s),
        tempMax: p.temp_max === null ? null : Number(p.temp_max),
        tempMin: p.temp_min === null ? null : Number(p.temp_min),
        chuvaMm: p.chuva_mm === null ? null : Number(p.chuva_mm),
        condicaoCodigo: p.condicao_codigo,
        chanceChuvaPct: p.chance_chuva_pct === null ? null : Number(p.chance_chuva_pct),
        nivelEstimadoM: p.nivel_estimado_m === null ? null : Number(p.nivel_estimado_m),
      });
    }

    // Chuva MEDIDA na própria estação (API oficial da ANA, ver lib/ana.js),
    // diferente da previsão do Open-Meteo acima — só existe pras 12 estações
    // com código ANA mapeado (ESTACOES_ANA), e só depois da primeira coleta
    // com ANA_IDENTIFICADOR/ANA_SENHA configuradas.
    // Qualidade da curva vazão→nível de cada estação (ver lib/curva.js). Vai
    // junto do número estimado de propósito: uma previsão de nível sem o
    // erro médio dela ao lado convida a confiar mais do que deveria.
    const curvasBrutas = await sql`
      SELECT slug, n, r2, erro_medio_m, ajustada_em FROM curvas_nivel
    `;
    const curvaPorSlug = new Map(curvasBrutas.map((c) => [c.slug, {
      n: c.n,
      r2: c.r2 === null ? null : Number(c.r2),
      erroMedioM: c.erro_medio_m === null ? null : Number(c.erro_medio_m),
      ajustadaEm: c.ajustada_em,
    }]));

    const chuvaAnaBruta = await sql`
      SELECT DISTINCT ON (slug) slug, chuva_mm
      FROM leituras_ana
      WHERE slug IN (SELECT slug FROM estacoes WHERE ativa = TRUE)
        AND chuva_mm IS NOT NULL
      ORDER BY slug, medido_em DESC
    `;
    const chuvaAnaPorSlug = new Map(
      chuvaAnaBruta.map((r) => [r.slug, Number(r.chuva_mm)])
    );

    // Timestamp da leitura ANA mais recente, pra badge de frescor por fonte
    // (Feature 3 — só informativo, não alimenta status/alerta). Consulta
    // SEPARADA de chuvaAnaBruta acima: aquela filtra chuva_mm IS NOT NULL
    // (pra pegar o último VALOR de chuva), reusá-la aqui mudaria de
    // significado — poderia mostrar um timestamp mais antigo sempre que a
    // leitura realmente mais recente tiver chuva_mm nulo.
    const ultimaAnaBruta = await sql`
      SELECT DISTINCT ON (slug) slug, medido_em
      FROM leituras_ana
      WHERE slug IN (SELECT slug FROM estacoes WHERE ativa = TRUE)
      ORDER BY slug, medido_em DESC
    `;
    const ultimaAnaPorSlug = new Map(
      ultimaAnaBruta.map((r) => [r.slug, r.medido_em])
    );

    const estacoes = linhas.map((r) => {
      const nivel = r.nivel_atual === null ? null : Number(r.nivel_atual);
      const cota = Number(r.cota_inundacao);
      const previsao = previsaoPorSlug.get(r.slug) || [];
      // Primeiro dia da previsão com dado de clima — normalmente hoje.
      const climaHoje = previsao.find((p) => p.tempMax !== null) || null;

      const velocidade = calcularVelocidade(
        nivel,
        r.nivel_anterior === null ? null : Number(r.nivel_anterior),
        r.medido_em,
        r.medido_em_anterior
      );

      return {
        slug: r.slug,
        cidade: r.cidade,
        uf: r.uf,
        rio: r.rio,
        estacao: r.estacao,
        cota: cota,
        nivel: nivel,
        medidoEm: r.medido_em,
        velocidadeCmH: velocidade === null ? null : Number(velocidade.toFixed(1)),
        percentualCota: nivel === null ? null : Number(((nivel / cota) * 100).toFixed(1)),
        margem: nivel === null ? null : Number((cota - nivel).toFixed(2)),
        status: classificar(nivel, cota),
        serieRecente: seriePorSlug.get(r.slug) || [],
        previsao,
        climaHoje,
        frescor: calcularFrescor(r.medido_em),
        variacao24hCm: calcularVariacao24h(nivel, referencia24hPorSlug.get(r.slug) ?? null),
        cheia2024: r.nivel_cheia_2024 === null ? null : {
          nivel: Number(r.nivel_cheia_2024),
          data: r.data_cheia_2024,
        },
        nota: r.nota,
        curvaNivel: curvaPorSlug.get(r.slug) ?? null,
        chuvaMedidaAnaMm: chuvaAnaPorSlug.get(r.slug) ?? null,
        medidoEmAna: ultimaAnaPorSlug.get(r.slug) ?? null,
        frescorAna: ultimaAnaPorSlug.has(r.slug) ? calcularFrescor(ultimaAnaPorSlug.get(r.slug)) : null,
      };
    });

    const comDado = estacoes.filter((e) => e.nivel !== null);

    // Horário da leitura mais recente entre todas as estações — usado no
    // front pra estimar quando a próxima coleta (a cada 15 min) deve chegar.
    let ultimaColeta = null;
    for (const e of comDado) {
      const t = new Date(e.medidoEm).getTime();
      if (ultimaColeta === null || t > ultimaColeta) ultimaColeta = t;
    }

    // Horário da última atualização bem-sucedida de vazão/clima (Open-Meteo),
    // entre todas as estações — usado no rodapé pra mostrar a saúde dessa
    // fonte separada da fonte de nível. Throttle é de 6h (ver lib/coletar.js),
    // então "atrasado" aqui precisa de um limiar bem maior que o de frescor.
    const [{ ultima_previsao: ultimaPrevisaoBruta }] = await sql`
      SELECT MAX(gerado_em) AS ultima_previsao
      FROM previsoes
      WHERE slug IN (SELECT slug FROM estacoes WHERE ativa = TRUE)
    `;
    const ultimaPrevisao = ultimaPrevisaoBruta === null ? null : new Date(ultimaPrevisaoBruta).toISOString();

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      atualizadoEm: new Date().toISOString(),
      ultimaColeta: ultimaColeta === null ? null : new Date(ultimaColeta).toISOString(),
      ultimaPrevisao,
      resumo: {
        total: estacoes.length,
        emAlerta: comDado.filter((e) => e.status === 'alerta').length,
        acimaDaCota: comDado.filter((e) => e.status === 'alagado').length,
        subindo: comDado.filter((e) => e.velocidadeCmH > 0).length,
      },
      estacoes,
    });
  } catch (erro) {
    console.error('Falha ao montar painel:', erro);
    // Mensagem genérica no corpo: `erro.message` do driver do Neon pode
    // trazer nome de tabela/coluna e detalhe de conexão, e nenhum
    // consumidor precisa disso (o front usa só o status HTTP). O erro
    // real fica no console.error acima, nos logs do Vercel.
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

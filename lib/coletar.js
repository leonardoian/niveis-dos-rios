import { sql } from './db.js';
import { buscarFeed } from './feed.js';
import { buscarPrevisao, buscarClima } from './previsao.js';

// Lógica de coleta em si, sem depender de req/res do Vercel — pode ser chamada
// tanto pela rota HTTP (api/coletar.js) quanto por um script local ou outro
// runner (ex.: GitHub Actions), desde que DATABASE_URL esteja definida.
export async function executarColeta() {
  const leituras = await buscarFeed();

  // Independe do feed de nível ter respondido ou não — vazão e clima são
  // fontes separadas, autolimitadas a 1x/dia por estação.
  const previsoesAtualizadas = await atualizarPrevisoes();

  if (leituras.length === 0) {
    return {
      ok: true,
      inseridas: 0,
      aviso: 'O feed não retornou leituras válidas.',
      previsoesAtualizadas,
    };
  }

  // Só grava estações que existem na tabela de configuração.
  const conhecidas = await sql`SELECT slug FROM estacoes WHERE ativa = TRUE`;
  const slugsValidos = new Set(conhecidas.map((e) => e.slug));

  let inseridas = 0;
  const ignoradas = [];

  for (const l of leituras) {
    if (!slugsValidos.has(l.slug)) {
      ignoradas.push(l.slug);
      continue;
    }

    // ON CONFLICT DO NOTHING: se essa medição já foi gravada, não duplica.
    const r = await sql`
      INSERT INTO leituras (slug, nivel, medido_em)
      VALUES (${l.slug}, ${l.nivel}, ${l.medidoEm})
      ON CONFLICT (slug, medido_em) DO NOTHING
      RETURNING id
    `;
    if (r.length > 0) inseridas += 1;
  }

  // Registra alertas para estações que cruzaram 60/80/100% da cota.
  const novosAlertas = await registrarAlertas();

  return {
    ok: true,
    recebidas: leituras.length,
    inseridas,
    ignoradas: [...new Set(ignoradas)],
    alertas: novosAlertas,
    previsoesAtualizadas,
  };
}

// Busca vazão e clima de cada estação no máximo 1x/dia — a Open-Meteo só
// atualiza esses dados diariamente, então repetir a cada 15 min só gastaria
// chamada à toa. gerado_em::date = CURRENT_DATE garante esse limite,
// independente de quantas vezes a coleta rodar no mesmo dia.
//
// As duas chamadas (vazão e clima) são independentes: se uma falhar, a outra
// ainda grava sua parte — por isso Promise.allSettled em vez de Promise.all,
// e o INSERT usa COALESCE pra não apagar um valor bom com um null de uma
// tentativa que falhou.
async function atualizarPrevisoes() {
  const estacoes = await sql`
    SELECT slug, lat, lon FROM estacoes
    WHERE ativa = TRUE AND lat IS NOT NULL AND lon IS NOT NULL
  `;

  const atualizadas = [];

  for (const e of estacoes) {
    const jaTemHoje = await sql`
      SELECT 1 FROM previsoes
      WHERE slug = ${e.slug} AND gerado_em::date = CURRENT_DATE
      LIMIT 1
    `;
    if (jaTemHoje.length > 0) continue;

    const [vazaoResultado, climaResultado] = await Promise.allSettled([
      buscarPrevisao(e.lat, e.lon),
      buscarClima(e.lat, e.lon),
    ]);

    if (vazaoResultado.status === 'rejected') {
      console.error(`Falha na previsão de vazão de ${e.slug}:`, vazaoResultado.reason.message);
    }
    if (climaResultado.status === 'rejected') {
      console.error(`Falha na previsão de clima de ${e.slug}:`, climaResultado.reason.message);
    }

    const vazaoPontos = vazaoResultado.status === 'fulfilled' ? vazaoResultado.value : [];
    const climaPontos = climaResultado.status === 'fulfilled' ? climaResultado.value : [];
    if (vazaoPontos.length === 0 && climaPontos.length === 0) continue;

    const vazaoPorDia = new Map(vazaoPontos.map((p) => [p.dia, p.vazaoM3s]));
    const climaPorDia = new Map(climaPontos.map((p) => [p.dia, p]));
    const dias = new Set([...vazaoPorDia.keys(), ...climaPorDia.keys()]);

    for (const dia of dias) {
      const vazaoM3s = vazaoPorDia.get(dia) ?? null;
      const clima = climaPorDia.get(dia) ?? null;

      await sql`
        INSERT INTO previsoes (slug, dia, vazao_m3s, temp_max, temp_min, chuva_mm, condicao_codigo, gerado_em)
        VALUES (
          ${e.slug}, ${dia}, ${vazaoM3s},
          ${clima?.tempMax ?? null}, ${clima?.tempMin ?? null}, ${clima?.chuvaMm ?? null}, ${clima?.condicaoCodigo ?? null},
          NOW()
        )
        ON CONFLICT (slug, dia) DO UPDATE
          SET vazao_m3s       = COALESCE(EXCLUDED.vazao_m3s, previsoes.vazao_m3s),
              temp_max        = COALESCE(EXCLUDED.temp_max, previsoes.temp_max),
              temp_min        = COALESCE(EXCLUDED.temp_min, previsoes.temp_min),
              chuva_mm        = COALESCE(EXCLUDED.chuva_mm, previsoes.chuva_mm),
              condicao_codigo = COALESCE(EXCLUDED.condicao_codigo, previsoes.condicao_codigo),
              gerado_em       = NOW()
      `;
    }
    atualizadas.push(e.slug);
  }

  return atualizadas;
}

// Grava um alerta quando a estação entra num status de risco,
// mas só se o último alerta registrado for de status diferente
// (evita spam a cada 15 minutos durante uma cheia longa).
async function registrarAlertas() {
  const criados = [];

  const atuais = await sql`
    SELECT DISTINCT ON (e.slug)
           e.slug, e.cidade, e.cota_inundacao, l.nivel
    FROM estacoes e
    JOIN leituras l ON l.slug = e.slug
    WHERE e.ativa = TRUE
    ORDER BY e.slug, l.medido_em DESC
  `;

  for (const est of atuais) {
    const razao = Number(est.nivel) / Number(est.cota_inundacao);
    let status = null;
    if (razao >= 1) status = 'alagado';
    else if (razao >= 0.8) status = 'alerta';
    else if (razao >= 0.6) status = 'atencao';

    if (!status) continue;

    const ultimo = await sql`
      SELECT status FROM alertas
      WHERE slug = ${est.slug}
      ORDER BY criado_em DESC
      LIMIT 1
    `;

    if (ultimo.length > 0 && ultimo[0].status === status) continue;

    await sql`
      INSERT INTO alertas (slug, status, nivel)
      VALUES (${est.slug}, ${status}, ${est.nivel})
    `;
    criados.push({ cidade: est.cidade, status });
  }

  return criados;
}

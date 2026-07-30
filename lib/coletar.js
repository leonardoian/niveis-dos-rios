import { sql } from './db.js';
import { buscarFeed } from './feed.js';
import { buscarPrevisao, buscarClima } from './previsao.js';
import { calcularVelocidade, calcularEtaCota } from './calculo.js';
import { enviarNotificacoesAlerta } from './push.js';
import { buscarNiveisAna } from './ana.js';

// Lógica de coleta em si, sem depender de req/res do Vercel — pode ser chamada
// tanto pela rota HTTP (api/coletar.js) quanto por um script local ou outro
// runner (ex.: GitHub Actions), desde que DATABASE_URL esteja definida.
export async function executarColeta() {
  const leituras = await buscarFeed();

  // Independe do feed de nível ter respondido ou não — vazão e clima são
  // fontes separadas, autolimitadas a 1x a cada 6h (~4x/dia) por estação.
  const previsoesAtualizadas = await atualizarPrevisoes();

  // Cross-check com a API oficial da ANA — fonte totalmente separada do
  // feed do nivelguaiba.com.br, grava numa tabela própria (leituras_ana)
  // que o painel não lê. Opcional (sem ANA_IDENTIFICADOR/ANA_SENHA
  // configuradas, buscarNiveisAna() já retorna [] sem erro).
  const leiturasAnaInseridas = await registrarLeiturasAna();

  if (leituras.length === 0) {
    return {
      ok: true,
      inseridas: 0,
      aviso: 'O feed não retornou leituras válidas.',
      previsoesAtualizadas,
      leiturasAnaInseridas,
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

  // Avisa quem se inscreveu em notificações push — não-bloqueante pro
  // resultado da coleta em si (ver lib/push.js: sem VAPID configurado, ou
  // sem ninguém inscrito, só não faz nada).
  await enviarNotificacoesAlerta(novosAlertas);

  // Arquiva a estimativa "⏱ atinge a cota" / "↩ volta ao normal" (se houver
  // uma nova) e avalia as que já venceram — ver nota em schema.sql sobre por
  // que só essa estimativa (e não a previsão de vazão) dá pra validar com
  // integridade.
  const novasEstimativas = await registrarEstimativasCota();
  const estimativasAvaliadas = await avaliarEstimativasCota();

  return {
    ok: true,
    recebidas: leituras.length,
    inseridas,
    ignoradas: [...new Set(ignoradas)],
    alertas: novosAlertas,
    previsoesAtualizadas,
    leiturasAnaInseridas,
    novasEstimativas,
    estimativasAvaliadas,
  };
}

// Busca a leitura mais recente da ANA pras 12 estações mapeadas (ver
// ESTACOES_ANA em lib/ana.js) e grava em leituras_ana — nunca lança:
// qualquer falha de rede/autenticação já é tratada dentro de
// buscarNiveisAna() (retorna [] em vez de propagar erro), então essa
// função nunca derruba o resto da coleta.
async function registrarLeiturasAna() {
  const leituras = await buscarNiveisAna();
  let inseridas = 0;

  for (const l of leituras) {
    const r = await sql`
      INSERT INTO leituras_ana (slug, nivel, medido_em)
      VALUES (${l.slug}, ${l.nivel}, ${l.medidoEm})
      ON CONFLICT (slug, medido_em) DO NOTHING
      RETURNING id
    `;
    if (r.length > 0) inseridas += 1;
  }

  return inseridas;
}

// Busca vazão e clima de cada estação no máximo 1x a cada 6h (~4x/dia) —
// NÃO é porque a Open-Meteo só atualiza a previsão nessa cadência (o modelo
// dela é atualizado várias vezes ao dia, os números realmente mudam antes
// disso); é só pra não bater a API a cada 15 min de coleta sem necessidade.
// gerado_em >= NOW() - 6h garante esse limite, independente de quantas vezes
// a coleta rodar nesse intervalo.
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
    const jaAtualizouRecente = await sql`
      SELECT 1 FROM previsoes
      WHERE slug = ${e.slug} AND gerado_em >= NOW() - INTERVAL '6 hours'
      LIMIT 1
    `;
    if (jaAtualizouRecente.length > 0) continue;

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

// Grava um alerta quando o status da estação muda — subindo pra um status
// de risco OU voltando ao normal — mas só se o último alerta registrado for
// de status diferente (evita spam a cada 15 minutos durante uma cheia
// longa).
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
    let status = 'normal';
    if (razao >= 1) status = 'alagado';
    else if (razao >= 0.8) status = 'alerta';
    else if (razao >= 0.6) status = 'atencao';

    const ultimo = await sql`
      SELECT status FROM alertas
      WHERE slug = ${est.slug}
      ORDER BY criado_em DESC
      LIMIT 1
    `;
    const statusAnterior = ultimo.length > 0 ? ultimo[0].status : null;

    // Nunca alertou antes e já está normal: nada a registrar (senão toda
    // estação tranquila desde sempre ganharia uma linha "normal" à toa na
    // primeira coleta).
    if (statusAnterior === null && status === 'normal') continue;
    if (statusAnterior === status) continue;

    await sql`
      INSERT INTO alertas (slug, status, nivel)
      VALUES (${est.slug}, ${status}, ${est.nivel})
    `;
    criados.push({ cidade: est.cidade, status });
  }

  return criados;
}

// Arquiva uma nova estimativa de ETA pra cota (ver calcularEtaCota em
// lib/calculo.js) quando a estação está subindo/descendo o bastante pra ter
// uma, E não existe uma pendente ainda pra ela (só uma "em aberto" por vez —
// ver nota em schema.sql). Recalcula a mesma velocidade/margem/percentual
// que o painel mostra, a partir das duas últimas leituras.
async function registrarEstimativasCota() {
  const criadas = [];

  const recentes = await sql`
    SELECT slug, nivel, medido_em
    FROM (
      SELECT
        l.slug, l.nivel, l.medido_em,
        ROW_NUMBER() OVER (PARTITION BY l.slug ORDER BY l.medido_em DESC) AS pos
      FROM leituras l
      WHERE l.slug IN (SELECT slug FROM estacoes WHERE ativa = TRUE)
    ) recentes
    WHERE pos <= 2
    ORDER BY slug, medido_em DESC
  `;

  const leiturasPorSlug = new Map();
  for (const r of recentes) {
    if (!leiturasPorSlug.has(r.slug)) leiturasPorSlug.set(r.slug, []);
    leiturasPorSlug.get(r.slug).push(r);
  }

  const cotasBrutas = await sql`SELECT slug, cota_inundacao FROM estacoes WHERE ativa = TRUE`;
  const cotaPorSlug = new Map(cotasBrutas.map((c) => [c.slug, Number(c.cota_inundacao)]));

  for (const [slug, leituras] of leiturasPorSlug) {
    if (leituras.length < 2) continue; // precisa de 2 leituras pra ter velocidade
    const cota = cotaPorSlug.get(slug);
    if (cota === undefined) continue;

    const [atual, anterior] = leituras; // já vem DESC (mais recente primeiro)
    const nivel = Number(atual.nivel);
    const velocidade = calcularVelocidade(nivel, Number(anterior.nivel), atual.medido_em, anterior.medido_em);
    if (velocidade === null) continue;

    const margem = Number((cota - nivel).toFixed(2));
    const percentualCota = Number(((nivel / cota) * 100).toFixed(1));
    const velocidadeArredondada = Number(velocidade.toFixed(1));

    const eta = calcularEtaCota(nivel, cota, margem, velocidadeArredondada, percentualCota);
    if (!eta) continue;

    const pendente = await sql`
      SELECT 1 FROM estimativas_cota WHERE slug = ${slug} AND avaliado_em IS NULL LIMIT 1
    `;
    if (pendente.length > 0) continue;

    // Tolerância proporcional ao horizonte: uma estimativa de 2h errar por
    // 3h é bem diferente de uma de 60h errar por 3h. Limitada entre 1h e
    // 12h pra não virar nem rigorosa demais nem frouxa demais nos extremos.
    const toleranciaHoras = Math.min(12, Math.max(1, eta.horas * 0.2));
    const previstoEm = new Date();
    const alvoEm = new Date(previstoEm.getTime() + eta.horas * 3_600_000);

    await sql`
      INSERT INTO estimativas_cota
        (slug, classe, previsto_em, nivel_no_calculo, velocidade_cm_h, alvo_nivel, horas_estimadas, alvo_em, tolerancia_horas)
      VALUES
        (${slug}, ${eta.classe}, ${previstoEm.toISOString()}, ${nivel}, ${velocidadeArredondada},
         ${eta.alvoNivel}, ${eta.horas}, ${alvoEm.toISOString()}, ${toleranciaHoras})
    `;
    criadas.push({ slug, classe: eta.classe, horas: eta.horas });
  }

  return criadas;
}

// Avalia estimativas cujo prazo (alvo_em + tolerância) já passou: confere se
// o nível real cruzou o alvo_nivel dentro da janela [previsto_em, alvo_em +
// tolerância]. "Acertou" = cruzou dentro do prazo; "errou" = não cruzou
// nesse intervalo (seja porque ainda não tinha cruzado, seja porque a
// tendência reverteu antes de chegar lá) — as duas situações contam como
// erro, porque na hora H a estimativa não teria ajudado quem confiasse nela.
async function avaliarEstimativasCota() {
  const avaliadas = [];

  const pendentes = await sql`
    SELECT * FROM estimativas_cota
    WHERE avaliado_em IS NULL
      AND alvo_em + (tolerancia_horas * INTERVAL '1 hour') <= NOW()
  `;

  for (const p of pendentes) {
    const janela = await sql`
      SELECT nivel, medido_em FROM leituras
      WHERE slug = ${p.slug}
        AND medido_em >= ${p.previsto_em}
        AND medido_em <= ${p.alvo_em}::timestamptz + (${p.tolerancia_horas} * INTERVAL '1 hour')
      ORDER BY medido_em ASC
    `;

    const alvoNivel = Number(p.alvo_nivel);
    const cruzamento = janela.find((l) =>
      p.classe === 'subindo' ? Number(l.nivel) >= alvoNivel : Number(l.nivel) <= alvoNivel
    );

    // Leitura real mais próxima do horário-alvo, só como contexto pra quem
    // for olhar os dados depois — inclusive quando o resultado é "errou".
    let maisProxima = null;
    if (janela.length > 0) {
      const alvoMs = new Date(p.alvo_em).getTime();
      maisProxima = janela.reduce((a, b) =>
        Math.abs(new Date(a.medido_em).getTime() - alvoMs) <= Math.abs(new Date(b.medido_em).getTime() - alvoMs) ? a : b
      );
    }

    const resultado = cruzamento ? 'acertou' : 'errou';
    const erroHoras = cruzamento
      ? Number(((new Date(cruzamento.medido_em).getTime() - new Date(p.alvo_em).getTime()) / 3_600_000).toFixed(2))
      : null;

    await sql`
      UPDATE estimativas_cota
      SET avaliado_em = NOW(),
          resultado = ${resultado},
          nivel_real_no_alvo = ${maisProxima ? Number(maisProxima.nivel) : null},
          erro_horas = ${erroHoras}
      WHERE id = ${p.id}
    `;
    avaliadas.push({ slug: p.slug, resultado });
  }

  return avaliadas;
}

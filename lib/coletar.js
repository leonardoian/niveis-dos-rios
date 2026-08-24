import { sql } from './db.js';
import { buscarFeed } from './feed.js';
import { buscarPrevisao, buscarClima } from './previsao.js';
import { calcularVelocidade, calcularEtaCota, avaliarEstimativa, calcularSubidaSustentada } from './calculo.js';
import { enviarNotificacoesAlerta } from './push.js';
import { buscarNiveisAna, ESTACOES_ANA, calcularChuvaAcumulada, temAnaConfigurada } from './ana.js';
import { ajustarCurva, estimarNivel } from './curva.js';

// Configuráveis via env (não hardcoded) — 40mm/6h é uma referência comum de
// risco de enchente relâmpago pra RS, mas é um valor a confirmar/ajustar,
// por isso fica fácil de mudar sem deploy de código.
const LIMIAR_CHUVA_6H_MM = Number(process.env.LIMIAR_CHUVA_6H_MM) || 40;
const JANELA_CHUVA_HORAS = Number(process.env.JANELA_CHUVA_HORAS) || 6;

// Alerta de subida rápida. 15 cm/h sustentado por 3h é um rio claramente
// enchendo, não flutuação de instrumento — mas, como os limiares de chuva,
// é referência a calibrar com o comportamento real das estações, por isso
// fica em env em vez de hardcoded.
const LIMIAR_SUBIDA_CM_H = Number(process.env.LIMIAR_SUBIDA_CM_H) || 15;
const JANELA_SUBIDA_HORAS = Number(process.env.JANELA_SUBIDA_HORAS) || 3;

// Retenção de leituras cruas, em dias. DESLIGADA por padrão, e de propósito:
// apagar dado bruto é irreversível, e nenhum default deveria fazer isso por
// conta própria em banco de ninguém. Só age se a variável for definida
// explicitamente — e mesmo assim o rollup horário preserva a série.
const RETENCAO_LEITURAS_DIAS = Number(process.env.RETENCAO_LEITURAS_DIAS) || null;
// Piso de segurança: mesmo pedindo menos, nunca apaga abaixo disso. A
// janela máxima de /api/historico é 90 dias e a curva vazão→nível ajusta
// sobre 1 ano — apagar dentro disso quebraria features silenciosamente.
const RETENCAO_MINIMA_DIAS = 400;

// Lógica de coleta em si, sem depender de req/res do Vercel — pode ser chamada
// tanto pela rota HTTP (api/coletar.js) quanto por um script local ou outro
// runner (ex.: GitHub Actions), desde que DATABASE_URL esteja definida.
export async function executarColeta() {
  const inicio = Date.now();
  const resultado = await coletar();
  await registrarColeta(resultado, Date.now() - inicio);
  return resultado;
}

// Grava uma linha em `coletas` com o resultado da rodada — histórico de
// saúde das fontes (ver GET /api/saude). NUNCA derruba a coleta: se o
// registro falhar, a coleta em si já aconteceu e o dado já está gravado;
// perder a linha de telemetria é bem menos grave que perder a rodada.
async function registrarColeta(r, duracaoMs) {
  try {
    await sql`
      INSERT INTO coletas (
        duracao_ms, feed_ok, erro_feed, ana_ok,
        leituras_recebidas, leituras_inseridas,
        leituras_ana_recebidas, leituras_ana_inseridas,
        previsoes_atualizadas, alertas_criados
      ) VALUES (
        ${duracaoMs}, ${r.erroFeed == null}, ${r.erroFeed ?? null}, ${r.anaOk ?? null},
        ${r.recebidas ?? 0}, ${r.inseridas ?? 0},
        ${r.anaRecebidas ?? 0}, ${r.leiturasAnaInseridas ?? 0},
        ${(r.previsoesAtualizadas ?? []).length},
        ${(r.alertas ?? []).length + (r.alertasChuva ?? []).length + (r.alertasSubida ?? []).length}
      )
    `;
  } catch (erro) {
    console.error('Falha ao registrar a rodada de coleta:', erro.message);
  }
}

async function coletar() {
  // O feed de nível é UMA das fontes, não a porta de entrada de todas: um
  // `await buscarFeed()` cru aqui derrubava a coleta inteira quando ele
  // respondia 403/500 — previsão e ANA, que não dependem dele pra nada,
  // nunca chegavam a rodar. Agora a falha vira um aviso e o resto segue.
  let leituras = [];
  let erroFeed = null;
  try {
    leituras = await buscarFeed();
  } catch (erro) {
    console.error('Falha ao buscar o feed de nível:', erro.message);
    erroFeed = erro.message;
  }

  // Antes de atualizar as previsões, pra a rodada já gravar nivel_estimado_m
  // com a curva do dia em vez da de ontem. Autolimitado a 1x/dia.
  const curvasAjustadas = await ajustarCurvas();

  // Independe do feed de nível ter respondido ou não — vazão e clima são
  // fontes separadas, autolimitadas a 1x a cada 6h (~4x/dia) por estação.
  const previsoesAtualizadas = await atualizarPrevisoes();

  // Cross-check com a API oficial da ANA — fonte totalmente separada do
  // feed do nivelguaiba.com.br, grava numa tabela própria (leituras_ana).
  // Opcional (sem ANA_IDENTIFICADOR/ANA_SENHA configuradas,
  // buscarNiveisAna() já retorna [] sem erro).
  const ana = await registrarLeiturasAna();

  if (leituras.length === 0) {
    // ok: false só quando o feed FALHOU — feed que respondeu sem leitura
    // válida continua sendo uma coleta bem-sucedida, como sempre foi.
    return {
      ok: erroFeed === null,
      inseridas: 0,
      aviso: erroFeed === null
        ? 'O feed não retornou leituras válidas.'
        : `Feed de nível indisponível: ${erroFeed}`,
      erroFeed,
      previsoesAtualizadas,
      curvasAjustadas,
      leiturasAnaInseridas: ana.inseridas,
      anaRecebidas: ana.recebidas,
      anaOk: ana.ok,
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

  // Alerta independente, baseado em chuva acumulada (ANA) — avisa antes do
  // rio responder, não só depois que ele já subiu. Só nas 12 estações com
  // código ANA mapeado.
  const novosAlertasChuva = await registrarAlertasChuva();

  // Terceiro eixo de alerta, independente dos outros dois: o de nível
  // reage a PATAMAR (60/80/100% da cota), este reage a RITMO. Um rio a 40%
  // da cota subindo 20 cm/h sustentados é mais urgente que um parado a 85%
  // — o primeiro chega na cota hoje, o segundo pode ficar onde está por
  // uma semana. Sem isso, o sistema só avisava depois que o patamar já
  // tinha sido cruzado.
  const novosAlertasSubida = await registrarAlertasSubida();

  // Avisa quem se inscreveu em notificações push — não-bloqueante pro
  // resultado da coleta em si (ver lib/push.js: sem VAPID configurado, ou
  // sem ninguém inscrito, só não faz nada).
  await enviarNotificacoesAlerta([...novosAlertas, ...novosAlertasChuva, ...novosAlertasSubida]);

  // Arquiva a estimativa "⏱ atinge a cota" / "↩ volta ao normal" (se houver
  // uma nova) e avalia as que já venceram — ver nota em schema.sql sobre por
  // que só essa estimativa (e não a previsão de vazão) dá pra validar com
  // integridade.
  // Mantém o agregado horário em dia (barato: só as horas recém-tocadas).
  const horasAgregadas = await atualizarRollup();
  const leiturasRemovidas = await aplicarRetencao();

  const novasEstimativas = await registrarEstimativasCota();
  const estimativasAvaliadas = await avaliarEstimativasCota();

  return {
    ok: true,
    recebidas: leituras.length,
    inseridas,
    ignoradas: [...new Set(ignoradas)],
    alertas: novosAlertas,
    alertasChuva: novosAlertasChuva,
    alertasSubida: novosAlertasSubida,
    previsoesAtualizadas,
    curvasAjustadas,
    horasAgregadas,
    leiturasRemovidas,
    leiturasAnaInseridas: ana.inseridas,
    anaRecebidas: ana.recebidas,
    anaOk: ana.ok,
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
  // ok distingue "não configurado / API fora" de "configurado e respondeu":
  // null quando não há credencial (feature opcional, ausência não é falha).
  const ok = temAnaConfigurada() ? leituras.length > 0 : null;
  if (leituras.length === 0) return { recebidas: 0, inseridas: 0, ok };

  // Bulk insert via UNNEST, não um INSERT por leitura: a ANA devolve 48h de
  // telemetria por estação (~2300 linhas somando as 12), e o driver da Neon
  // é HTTP — cada `sql` é uma requisição. Em loop isso seria ~2300
  // round-trips por coleta, a cada 15 min. Assim é um comando só, e o
  // ON CONFLICT continua tornando a coleta idempotente (a partir da segunda
  // rodada quase tudo já está lá e não insere nada).
  //
  // Só as estações válidas: leituras_ana tem FK pra estacoes(slug), e o
  // bulk insert falha inteiro se UMA linha violar — diferente do loop, onde
  // uma linha ruim derrubava só a si mesma.
  const conhecidas = await sql`SELECT slug FROM estacoes`;
  const slugsValidos = new Set(conhecidas.map((e) => e.slug));
  const validas = leituras.filter((l) => slugsValidos.has(l.slug));
  if (validas.length === 0) return { recebidas: leituras.length, inseridas: 0, ok };

  const [{ inseridas }] = await sql`
    WITH novas AS (
      INSERT INTO leituras_ana (slug, nivel, medido_em, chuva_mm)
      SELECT * FROM UNNEST(
        ${validas.map((l) => l.slug)}::text[],
        ${validas.map((l) => l.nivel)}::numeric[],
        ${validas.map((l) => l.medidoEm)}::timestamptz[],
        ${validas.map((l) => l.chuvaMm)}::numeric[]
      )
      ON CONFLICT (slug, medido_em) DO NOTHING
      RETURNING id
    )
    SELECT COUNT(*)::int AS inseridas FROM novas
  `;

  return { recebidas: leituras.length, inseridas, ok };
}

// Reajusta a curva vazão→nível de cada estação, no máximo 1x/dia — os pares
// usados são médias DIÁRIAS, então reajustar mais de uma vez por dia
// refaria a mesma conta com os mesmos dados.
//
// A janela é de 1 ano: histórico suficiente pra cobrir estiagem e cheia (a
// curva precisa das duas pontas pra ter faixa útil), sem arrastar anos de
// dado antigo que pode nem refletir a régua atual — a recalibração de 2024
// em Porto Alegre é o lembrete de que régua muda (ver nota em schema.sql).
//
// Só dias PASSADOS: `previsoes` guarda a última previsão feita pra cada dia
// (o ON CONFLICT DO UPDATE sobrescreve conforme novas previsões chegam),
// então um dia já vencido carrega a estimativa mais recente que o modelo
// deu pra ele — que é justamente o que queremos parear com o que foi
// medido. Incluir o dia de hoje ou os futuros pareria previsão com um dia
// ainda incompleto.
async function ajustarCurvas() {
  const jaAjustouHoje = await sql`
    SELECT 1 FROM curvas_nivel WHERE ajustada_em >= NOW() - INTERVAL '24 hours' LIMIT 1
  `;
  if (jaAjustouHoje.length > 0) return [];

  const pares = await sql`
    SELECT p.slug, p.vazao_m3s, AVG(l.nivel) AS nivel
    FROM previsoes p
    JOIN leituras l
      ON l.slug = p.slug
     AND l.medido_em >= p.dia::timestamptz
     AND l.medido_em <  p.dia::timestamptz + INTERVAL '1 day'
    WHERE p.dia < CURRENT_DATE
      AND p.dia >= CURRENT_DATE - INTERVAL '1 year'
      AND p.vazao_m3s IS NOT NULL
    GROUP BY p.slug, p.dia, p.vazao_m3s
  `;

  const porSlug = new Map();
  for (const p of pares) {
    if (!porSlug.has(p.slug)) porSlug.set(p.slug, []);
    porSlug.get(p.slug).push({ vazaoM3s: Number(p.vazao_m3s), nivelM: Number(p.nivel) });
  }

  const ajustadas = [];
  for (const [slug, amostra] of porSlug) {
    const c = ajustarCurva(amostra);
    if (!c) continue; // amostra degenerada — ver lib/curva.js

    await sql`
      INSERT INTO curvas_nivel (slug, alfa, beta, n, r2, erro_medio_m, vazao_min_m3s, vazao_max_m3s, ajustada_em)
      VALUES (${slug}, ${c.alfa}, ${c.beta}, ${c.n}, ${c.r2}, ${c.erroMedioM}, ${c.vazaoMinM3s}, ${c.vazaoMaxM3s}, NOW())
      ON CONFLICT (slug) DO UPDATE
        SET alfa = EXCLUDED.alfa, beta = EXCLUDED.beta, n = EXCLUDED.n,
            r2 = EXCLUDED.r2, erro_medio_m = EXCLUDED.erro_medio_m,
            vazao_min_m3s = EXCLUDED.vazao_min_m3s, vazao_max_m3s = EXCLUDED.vazao_max_m3s,
            ajustada_em = NOW()
    `;
    ajustadas.push({ slug, n: c.n, r2: c.r2, erroMedioM: c.erroMedioM });
  }

  return ajustadas;
}

// Lê as curvas gravadas no formato que lib/curva.js espera.
async function carregarCurvas() {
  const linhas = await sql`SELECT * FROM curvas_nivel`;
  return new Map(linhas.map((c) => [c.slug, {
    alfa: Number(c.alfa),
    beta: Number(c.beta),
    n: c.n,
    r2: c.r2 === null ? null : Number(c.r2),
    erroMedioM: c.erro_medio_m === null ? null : Number(c.erro_medio_m),
    vazaoMinM3s: Number(c.vazao_min_m3s),
    vazaoMaxM3s: Number(c.vazao_max_m3s),
  }]));
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

  // Uma leitura só das curvas pra todas as estações, fora do loop.
  const curvas = await carregarCurvas();
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

    const curva = curvas.get(e.slug) ?? null;

    for (const dia of dias) {
      const vazaoM3s = vazaoPorDia.get(dia) ?? null;
      const clima = climaPorDia.get(dia) ?? null;
      // null quando a estação não tem curva confiável ou a vazão caiu fora
      // da faixa ajustada — ver estimarNivel em lib/curva.js.
      const nivelEstimado = vazaoM3s === null ? null : estimarNivel(curva, vazaoM3s);

      await sql`
        INSERT INTO previsoes (slug, dia, vazao_m3s, temp_max, temp_min, chuva_mm, condicao_codigo, chance_chuva_pct, nivel_estimado_m, gerado_em)
        VALUES (
          ${e.slug}, ${dia}, ${vazaoM3s},
          ${clima?.tempMax ?? null}, ${clima?.tempMin ?? null}, ${clima?.chuvaMm ?? null}, ${clima?.condicaoCodigo ?? null},
          ${clima?.chanceChuvaPct ?? null}, ${nivelEstimado},
          NOW()
        )
        ON CONFLICT (slug, dia) DO UPDATE
          SET vazao_m3s        = COALESCE(EXCLUDED.vazao_m3s, previsoes.vazao_m3s),
              temp_max         = COALESCE(EXCLUDED.temp_max, previsoes.temp_max),
              temp_min         = COALESCE(EXCLUDED.temp_min, previsoes.temp_min),
              chuva_mm         = COALESCE(EXCLUDED.chuva_mm, previsoes.chuva_mm),
              condicao_codigo  = COALESCE(EXCLUDED.condicao_codigo, previsoes.condicao_codigo),
              chance_chuva_pct = COALESCE(EXCLUDED.chance_chuva_pct, previsoes.chance_chuva_pct),
              -- Sem COALESCE aqui, diferente das outras: se a curva deixou
              -- de ser confiável (ou a vazão saiu da faixa), o certo é
              -- APAGAR a estimativa antiga, não preservá-la. Manter um
              -- número que o modelo atual não sustenta seria pior que não
              -- mostrar nada.
              nivel_estimado_m = EXCLUDED.nivel_estimado_m,
              gerado_em        = NOW()
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
      WHERE slug = ${est.slug} AND tipo = 'nivel'
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
      INSERT INTO alertas (slug, status, nivel, tipo)
      VALUES (${est.slug}, ${status}, ${est.nivel}, 'nivel')
    `;
    criados.push({ slug: est.slug, cidade: est.cidade, status, tipo: 'nivel' });
  }

  return criados;
}

// Alerta INDEPENDENTE do de nível: reage à chuva acumulada medida pela
// própria estação (ANA), pra avisar ANTES do rio responder — não só depois
// que ele já subiu. Só se aplica às 12 estações com código ANA mapeado
// (ver ESTACOES_ANA em lib/ana.js); as demais são puladas, não é erro.
// Mesmo dedup lógico de registrarAlertas() (só grava na transição de
// status), mas escopado por tipo = 'chuva' pra nunca se misturar com o
// dedup de nível na mesma tabela.
async function registrarAlertasChuva() {
  const criados = [];

  const slugsAna = Object.keys(ESTACOES_ANA);
  const estacoesAtivas = await sql`
    SELECT slug, cidade FROM estacoes WHERE ativa = TRUE AND slug = ANY(${slugsAna})
  `;

  for (const est of estacoesAtivas) {
    const leituras = await sql`
      SELECT chuva_mm, medido_em
      FROM leituras_ana
      WHERE slug = ${est.slug}
        AND medido_em >= NOW() - (${JANELA_CHUVA_HORAS} * INTERVAL '1 hour')
    `;

    const acumulado = calcularChuvaAcumulada(
      leituras.map((l) => ({
        chuvaMm: l.chuva_mm === null ? null : Number(l.chuva_mm),
        medidoEm: l.medido_em,
      }))
    );
    if (acumulado === null) continue; // sem dado suficiente nessa janela — N/A, não erro

    const status = acumulado >= LIMIAR_CHUVA_6H_MM ? 'chuva_alerta' : 'chuva_normal';

    const ultimo = await sql`
      SELECT status FROM alertas
      WHERE slug = ${est.slug} AND tipo = 'chuva'
      ORDER BY criado_em DESC
      LIMIT 1
    `;
    const statusAnterior = ultimo.length > 0 ? ultimo[0].status : null;

    if (statusAnterior === null && status === 'chuva_normal') continue;
    if (statusAnterior === status) continue;

    await sql`
      INSERT INTO alertas (slug, status, tipo, chuva_mm_acumulada)
      VALUES (${est.slug}, ${status}, 'chuva', ${acumulado})
    `;
    criados.push({
      slug: est.slug,
      cidade: est.cidade,
      status,
      tipo: 'chuva',
      chuvaMmAcumulada: acumulado,
      janelaHoras: JANELA_CHUVA_HORAS,
    });
  }

  return criados;
}

// Alerta por RITMO, não por patamar: avisa que o rio está enchendo rápido
// mesmo estando longe da cota. Mesmo dedup lógico dos outros dois (só grava
// na transição de status), escopado por tipo = 'subida' pra nunca se
// misturar com o dedup de nível nem com o de chuva na mesma tabela.
//
// Usa calcularSubidaSustentada (janela de horas), não calcularVelocidade
// (duas últimas leituras): a velocidade instantânea é ruidosa o bastante
// pra "ficar zerada mesmo com uma tendência clara ao longo do dia" (como o
// README já documentava) — ruído tolerável num número no card, não numa
// notificação que acorda alguém.
async function registrarAlertasSubida() {
  const criados = [];

  const janela = await sql`
    SELECT l.slug, e.cidade, l.nivel, l.medido_em
    FROM leituras l
    JOIN estacoes e ON e.slug = l.slug
    WHERE e.ativa = TRUE
      AND l.medido_em >= NOW() - (${JANELA_SUBIDA_HORAS} * INTERVAL '1 hour')
    ORDER BY l.slug, l.medido_em ASC
  `;

  const porSlug = new Map();
  for (const l of janela) {
    if (!porSlug.has(l.slug)) porSlug.set(l.slug, { cidade: l.cidade, leituras: [] });
    porSlug.get(l.slug).leituras.push({ nivel: Number(l.nivel), medidoEm: l.medido_em });
  }

  for (const [slug, { cidade, leituras }] of porSlug) {
    const velocidade = calcularSubidaSustentada(leituras, JANELA_SUBIDA_HORAS);
    if (velocidade === null) continue; // cobertura insuficiente na janela — N/A, não erro

    const status = velocidade >= LIMIAR_SUBIDA_CM_H ? 'subida_rapida' : 'subida_normal';

    const ultimo = await sql`
      SELECT status FROM alertas
      WHERE slug = ${slug} AND tipo = 'subida'
      ORDER BY criado_em DESC
      LIMIT 1
    `;
    const statusAnterior = ultimo.length > 0 ? ultimo[0].status : null;

    if (statusAnterior === null && status === 'subida_normal') continue;
    if (statusAnterior === status) continue;

    await sql`
      INSERT INTO alertas (slug, status, tipo, velocidade_cm_h)
      VALUES (${slug}, ${status}, 'subida', ${velocidade})
    `;
    criados.push({
      slug,
      cidade,
      status,
      tipo: 'subida',
      velocidadeCmH: velocidade,
      janelaHoras: JANELA_SUBIDA_HORAS,
    });
  }

  return criados;
}

// Recalcula o agregado horário das horas que a coleta pode ter tocado.
// Janela curta (não a tabela inteira) porque só as últimas horas mudam: a
// coleta grava leituras recentes, e uma leitura antiga só apareceria via
// retroativo da ANA — que vai pra leituras_ana, não pra leituras.
//
// 3 horas de folga cobre atraso de agendador e leitura com medido_em um
// pouco pra trás, sem varrer a série inteira a cada 15 min.
async function atualizarRollup() {
  const [{ horas }] = await sql`
    WITH agregado AS (
      SELECT slug,
             date_trunc('hour', medido_em) AS hora,
             COUNT(*)::int AS n,
             MIN(nivel) AS nivel_min,
             MAX(nivel) AS nivel_max,
             AVG(nivel) AS nivel_med
      FROM leituras
      WHERE medido_em >= date_trunc('hour', NOW() - INTERVAL '3 hours')
      GROUP BY 1, 2
    ),
    gravadas AS (
      INSERT INTO leituras_horarias (slug, hora, n, nivel_min, nivel_max, nivel_med)
      SELECT slug, hora, n, nivel_min, nivel_max, nivel_med FROM agregado
      ON CONFLICT (slug, hora) DO UPDATE
        SET n = EXCLUDED.n,
            nivel_min = EXCLUDED.nivel_min,
            nivel_max = EXCLUDED.nivel_max,
            nivel_med = EXCLUDED.nivel_med
      RETURNING 1
    )
    SELECT COUNT(*)::int AS horas FROM gravadas
  `;
  return horas;
}

// Apaga leitura crua antiga — SÓ quando RETENCAO_LEITURAS_DIAS foi definida
// explicitamente no ambiente. Sem ela, não faz nada.
//
// Duas travas, porque isto é irreversível:
//   1. desligado por padrão (a variável ausente vira null);
//   2. piso de RETENCAO_MINIMA_DIAS mesmo se pedirem menos — a janela máxima
//      de /api/historico é 90 dias e a curva ajusta sobre 1 ano, então uma
//      retenção curta quebraria features sem dizer nada.
// A série longa continua viva em leituras_horarias de qualquer jeito.
async function aplicarRetencao() {
  if (!RETENCAO_LEITURAS_DIAS) return 0;

  const dias = Math.max(RETENCAO_LEITURAS_DIAS, RETENCAO_MINIMA_DIAS);
  if (dias > RETENCAO_LEITURAS_DIAS) {
    console.warn(
      `RETENCAO_LEITURAS_DIAS=${RETENCAO_LEITURAS_DIAS} é curta demais; ` +
      `usando o piso de ${RETENCAO_MINIMA_DIAS} dias pra não quebrar histórico e curva.`
    );
  }

  // Só apaga hora que JÁ está agregada: o rollup é o que sustenta a série
  // longa depois que o bruto some, então apagar antes de agregar perderia
  // o dado de vez.
  const [{ removidas }] = await sql`
    WITH apagadas AS (
      DELETE FROM leituras l
      WHERE l.medido_em < NOW() - (${dias} * INTERVAL '1 day')
        AND EXISTS (
          SELECT 1 FROM leituras_horarias h
          WHERE h.slug = l.slug AND h.hora = date_trunc('hour', l.medido_em)
        )
      RETURNING 1
    )
    SELECT COUNT(*)::int AS removidas FROM apagadas
  `;

  if (removidas > 0) console.log(`Retenção: ${removidas} leituras cruas acima de ${dias} dias removidas (o rollup horário mantém a série).`);
  return removidas;
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
// o nível real estava do outro lado do alvo_nivel dentro da janela de acerto
// [alvo_em − tolerância, alvo_em + tolerância].
//
// A tolerância é dos DOIS lados. Antes valia [previsto_em, alvo_em + tol]:
// qualquer cruzamento depois do cálculo contava, então uma estimativa de 40h
// cujo rio cruzou o alvo 1h depois e recuou de novo era registrada como
// "acertou" com erro_horas ≈ −39 — inflando justamente a faixa "mais de 24h",
// que é onde a página existe pra mostrar a extrapolação falhando. A própria
// public/acerto.html sempre descreveu "±20% do horizonte previsto"; era o
// código que não fazia isso.
//
// "Acertou" = na hora prevista (± tolerância) o nível realmente estava lá.
// "Errou" = não estava — seja porque ainda não tinha chegado, seja porque a
// tendência reverteu antes, seja porque chegou cedo demais e já tinha ido
// embora. As três contam igual, porque na hora H a estimativa não teria
// ajudado quem confiasse nela.
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

    // O limite TARDIO da janela já veio do SQL acima; o adiantado e o
    // veredito em si ficam em avaliarEstimativa (lib/calculo.js), pura e
    // coberta por tests/calculo.test.js.
    const { resultado, erroHoras, nivelRealNoAlvo } = avaliarEstimativa({
      classe: p.classe,
      alvoNivel: Number(p.alvo_nivel),
      alvoEm: p.alvo_em,
      toleranciaHoras: Number(p.tolerancia_horas),
      leituras: janela.map((l) => ({ nivel: Number(l.nivel), medidoEm: l.medido_em })),
    });

    await sql`
      UPDATE estimativas_cota
      SET avaliado_em = NOW(),
          resultado = ${resultado},
          nivel_real_no_alvo = ${nivelRealNoAlvo},
          erro_horas = ${erroHoras}
      WHERE id = ${p.id}
    `;
    avaliadas.push({ slug: p.slug, resultado });
  }

  return avaliadas;
}

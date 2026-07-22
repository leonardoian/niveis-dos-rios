import { sql } from './db.js';
import { buscarFeed } from './feed.js';

// Lógica de coleta em si, sem depender de req/res do Vercel — pode ser chamada
// tanto pela rota HTTP (api/coletar.js) quanto por um script local ou outro
// runner (ex.: GitHub Actions), desde que DATABASE_URL esteja definida.
export async function executarColeta() {
  const leituras = await buscarFeed();

  if (leituras.length === 0) {
    return {
      ok: true,
      inseridas: 0,
      aviso: 'O feed não retornou leituras válidas.',
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
  };
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

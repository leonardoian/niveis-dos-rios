// api/coletar.js
// Autentica na ANA, coleta leituras das estações ativas e faz upsert no Neon.
// Chamada pelo Vercel Cron (ver vercel.json).
// Env vars: DATABASE_URL, ANA_IDENTIFICADOR, ANA_SENHA, CRON_SECRET
import { neon } from '@neondatabase/serverless';

const ANA_BASE = 'https://www.ana.gov.br/hidrowebservice/EstacoesTelemetricas';
let tokenCache = { token: null, obtidoEm: 0 };

async function getToken() {
  const agora = Date.now();
  if (tokenCache.token && agora - tokenCache.obtidoEm < 50 * 60 * 1000) {
    return tokenCache.token;
  }
  const resp = await fetch(`${ANA_BASE}/OAUth/v1`, {
    method: 'GET',
    headers: {
      Identificador: process.env.ANA_IDENTIFICADOR,
      Senha: process.env.ANA_SENHA,
    },
  });
  if (!resp.ok) throw new Error(`Falha auth ANA: HTTP ${resp.status}`);
  const data = await resp.json();
  const token = data?.items?.tokenautenticacao;
  if (!token) throw new Error('Token ausente na resposta da ANA');
  tokenCache = { token, obtidoEm: agora };
  return token;
}

async function buscarLeituras(token, codigoEstacao) {
  const url = `${ANA_BASE}/HidroinfoanaSerieTelemetricaAdotada/v1`
    + `?CodigoDaEstacao=${codigoEstacao}`
    + `&TipoFiltroData=DATA_LEITURA`
    + `&RangeIntervaloDeBusca=HORA_24`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Estação ${codigoEstacao}: HTTP ${resp.status}`);
  const data = await resp.json();
  return data?.items ?? [];
}

function normalizar(item, codigoEstacao) {
  const nivelCm = parseFloat(item.Cota_Adotada);
  return {
    estacao: codigoEstacao,
    medido_em: item.Data_Hora_Medicao,
    nivel_m: Number.isFinite(nivelCm) ? nivelCm / 100 : null,
    vazao: parseFloat(item.Vazao_Adotada) || null,
    chuva_mm: parseFloat(item.Chuva_Adotada) || null,
    qualidade: parseInt(item.Cota_Adotada_Status ?? '0', 10),
  };
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: 'não autorizado' });
  }
  const sql = neon(process.env.DATABASE_URL);
  try {
    const estacoes = await sql`SELECT codigo FROM estacoes WHERE ativa = true`;
    if (estacoes.length === 0) {
      return res.status(200).json({ ok: true, msg: 'nenhuma estação ativa' });
    }
    const token = await getToken();
    const resultado = [];
    for (const { codigo } of estacoes) {
      try {
        const itens = await buscarLeituras(token, codigo);
        let gravadas = 0;
        for (const item of itens) {
          const r = normalizar(item, codigo);
          if (!r.medido_em || r.nivel_m === null) continue;
          await sql`
            INSERT INTO leituras (estacao, medido_em, nivel_m, vazao, chuva_mm, qualidade)
            VALUES (${r.estacao}, ${r.medido_em}, ${r.nivel_m}, ${r.vazao}, ${r.chuva_mm}, ${r.qualidade})
            ON CONFLICT (estacao, medido_em) DO NOTHING
          `;
          gravadas++;
        }
        resultado.push({ estacao: codigo, recebidas: itens.length, processadas: gravadas });
      } catch (e) {
        resultado.push({ estacao: codigo, erro: e.message });
      }
    }
    return res.status(200).json({ ok: true, coletado_em: new Date().toISOString(), resultado });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message });
  }
}

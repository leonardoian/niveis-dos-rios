// Cross-check com a API oficial da ANA (Agência Nacional de Águas),
// hidrowebservice — só busca dado, não toca em banco (quem persiste é
// coletar.js, mesmo papel que lib/previsao.js já tem pra Open-Meteo).
// Feature opcional: sem ANA_IDENTIFICADOR/ANA_SENHA configuradas, tudo
// aqui vira no-op — não quebra a coleta principal.
const BASE_URL = 'https://www.ana.gov.br/hidrowebservice/EstacoesTelemetricas';

// Mapa estação → código ANA, verificado manualmente contra o inventário
// oficial (HidroInventarioEstacoes) numa sessão de investigação — 12 das
// 14 estações do painel. Preferindo sempre a rede operada por SGB-CPRM/ANA
// quando existem duas estações telemétricas paralelas na mesma cidade
// (algumas prefeituras/estado têm uma rede própria mais nova, "DCRS", que
// pode ter datum de régua diferente — mesmo tipo de problema já visto com
// Porto Alegre em schema.sql).
//
// De propósito SEM lajeado/rocasales:
//   - lajeado: a única estação telemétrica achada pra "Arroio do
//     Meio/Lajeado" está no Rio Forqueta, não no Rio Taquari (o que
//     schema.sql registra pra essa estação) — mistério não resolvido,
//     melhor não usar um código errado do que mostrar dado enganoso.
//   - rocasales: não existe estação telemétrica própria no município, só
//     uma estação combinada "Encantado/Roca Sales" sob o município de
//     Encantado — mesma ambiguidade já documentada sobre o dado de
//     cheia de 2024 de Roca Sales.
export const ESTACOES_ANA = {
  portoalegre: '87450020',
  saoleopoldo: '87382000',
  bomretirodosul: '86881000',
  cachoeiradosul: '85642000',
  donafrancisca: '85400000',
  encantado: '86720000',
  feliz: '87165001',
  gravatai: '87399000',
  mucum: '86510000',
  riopardo: '85900000',
  saosebastiaodocai: '87170000',
  taquara: '87376000',
};

// A API aceita no máximo 10 códigos de estação por chamada
// (HidroinfoanaSerieTelemetricaAdotada) — pura, sem rede, testável direto.
export function codigosParaLotes(codigos, tamanho = 10) {
  const lotes = [];
  for (let i = 0; i < codigos.length; i += tamanho) {
    lotes.push(codigos.slice(i, i + tamanho));
  }
  return lotes;
}

// Cota_Adotada vem da API em centímetros (string, ex. "171.00") — converte
// pro nosso padrão em metros (mesma escala de leituras.nivel). Pura: nunca
// lança, valor ausente/inválido vira null em vez de quebrar o lote inteiro.
export function converterCotaParaMetros(cotaCm) {
  if (cotaCm === null || cotaCm === undefined) return null;
  const numero = Number(cotaCm);
  if (!Number.isFinite(numero)) return null;
  return Number((numero / 100).toFixed(2));
}

// Chuva_Adotada vem da API já em milímetros (string, ex. "0.00") — chuva
// acumulada MEDIDA na própria estação, diferente da previsão do Open-Meteo
// (previsoes.chuva_mm). Mesmo formato de conversão de converterCotaParaMetros,
// mas sem dividir por 100. Pura: nunca lança, ausente/inválido vira null.
export function converterChuvaMm(chuvaMm) {
  if (chuvaMm === null || chuvaMm === undefined) return null;
  const numero = Number(chuvaMm);
  if (!Number.isFinite(numero)) return null;
  return Number(numero.toFixed(2));
}

// leituras: [{chuvaMm, medidoEm}], não precisa vir ordenado. Soma só
// deltas POSITIVOS entre leituras consecutivas (ordenadas por medidoEm) —
// qualquer queda vira "possível reset" e é ignorada em vez de subtraída.
// Funciona tanto se Chuva_Adotada for um total corrido quanto se reiniciar
// em algum horário (não confirmado ao vivo — convenção comum de "chuva do
// dia" na hidrologia brasileira, mas não vale a pena reconsultar a API
// real só pra isso; este design é robusto nos dois casos). Pura: nunca
// lança. null = sem dado (lista vazia ou tudo com chuvaMm ausente); 0 é
// uma resposta válida (dado presente, sem chuva acumulada na janela).
export function calcularChuvaAcumulada(leituras) {
  const validas = (leituras || [])
    .filter((l) => l.chuvaMm !== null && l.chuvaMm !== undefined)
    .slice()
    .sort((a, b) => new Date(a.medidoEm) - new Date(b.medidoEm));

  if (validas.length === 0) return null;

  let total = 0;
  for (let i = 1; i < validas.length; i++) {
    const delta = validas[i].chuvaMm - validas[i - 1].chuvaMm;
    if (delta > 0) total += delta;
  }
  return Number(total.toFixed(2));
}

// Data_Hora_Medicao vem como "2026-07-30 15:15:00.0" (sem timezone) — mas
// é horário de Brasília (UTC-3), não UTC. Confirmado comparando contra o
// relógio real durante a investigação: um `new Date()` direto (que o V8
// trata como UTC nesse formato) deixaria a leitura ~3h no "futuro", o que
// bateria com timestamps futuros bizarros mais cedo ou mais tarde. Pura —
// devolve ISO string em UTC, mesmo formato que leituras.medido_em já usa
// (ver extração equivalente em lib/feed.js).
export function converterDataHoraAna(dataHora) {
  if (!dataHora) return null;
  const semFracaoSegundo = dataHora.replace(' ', 'T').replace(/\.\d+$/, '');
  const data = new Date(`${semFracaoSegundo}-03:00`);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString();
}

// GET com headers Identificador/Senha (não é OAuth2 "de verdade", apesar
// do nome do endpoint) — devolve o JWT de curta duração (~1h) usado nas
// chamadas seguintes. Sem cache entre invocações: funções serverless não
// compartilham memória de forma confiável entre execuções, e a coleta roda
// a cada 15 min — reautenticar a cada rodada é uma chamada GET a mais, sem
// a complexidade de persistir/renovar token entre chamadas.
// Pura, pra telemetria conseguir separar "ANA não configurada" (ausência
// esperada, não é falha) de "configurada e não respondeu" — ver ana_ok em
// `coletas` e GET /api/saude. Mesmo espírito de temVapidConfigurado.
export function temAnaConfigurada(env = process.env) {
  return Boolean(env.ANA_IDENTIFICADOR && env.ANA_SENHA);
}

async function autenticar() {
  const identificador = process.env.ANA_IDENTIFICADOR;
  const senha = process.env.ANA_SENHA;
  if (!identificador || !senha) return null;

  const resposta = await fetch(`${BASE_URL}/OAUth/v1`, {
    headers: { Identificador: identificador, Senha: senha },
    signal: AbortSignal.timeout(15000),
  });
  if (!resposta.ok) {
    throw new Error(`Autenticação ANA retornou HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();
  const token = dados?.items?.tokenautenticacao;
  if (!token) throw new Error('Autenticação ANA não retornou token');
  return token;
}

// Os nomes de parâmetro dessa API têm espaço/acento ("Tipo Filtro Data",
// "Código da Estação") — URLSearchParams codificaria a CHAVE errado (ou
// nem todo cliente HTTP aceita chave com espaço cru), por isso a URL é
// montada manualmente com encodeURIComponent também na chave. Confirmado
// funcionando assim numa chamada real durante a investigação desta sessão.
async function buscarLote(codigos, token) {
  const params = [
    ['Codigos_Estacoes', codigos.join(',')],
    ['Tipo Filtro Data', 'DATA_LEITURA'],
    // DIAS_2, não HORA_24: testado ao vivo nesta investigação — os valores
    // em HORA_x simplesmente não retornam registro nenhum nessa API (bug
    // ou comportamento não documentado do lado da ANA), enquanto DIAS_2
    // funciona e já cobre a leitura mais recente com folga.
    ['Range Intervalo de busca', 'DIAS_2'],
  ];
  const query = params
    .map(([chave, valor]) => `${encodeURIComponent(chave)}=${encodeURIComponent(valor)}`)
    .join('&');

  const resposta = await fetch(`${BASE_URL}/HidroinfoanaSerieTelemetricaAdotada/v2?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!resposta.ok) {
    throw new Error(`Série telemétrica ANA retornou HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();
  return Array.isArray(dados.items) ? dados.items : [];
}

// Busca TODAS as leituras das últimas 48h (DIAS_2) de cada uma das 12
// estações mapeadas, já convertidas e mapeadas de volta pro nosso slug.
//
// Guardava só a mais recente de cada estação e jogava as outras ~191 fora —
// dado que a API já tinha entregue, de graça, no mesmo payload. Guardando
// tudo (o INSERT já é idempotente por (slug, medido_em)) ganhamos três
// coisas: série da ANA na resolução real da estação em vez de amostrada
// pela nossa cadência de coleta; retroativo de 48h que tapa buraco quando o
// feed do nivelguaiba fica fora; e chuva acumulada calculada sobre as
// leituras de verdade da janela, não sobre uma amostra delas.
//
// Nunca lança: sem credencial configurada, ou qualquer falha de
// rede/autenticação, retorna [] — quem chama (coletar.js) não precisa de
// try/catch extra.
export async function buscarNiveisAna() {
  let token;
  try {
    token = await autenticar();
  } catch (erro) {
    console.error('Falha na autenticação ANA:', erro.message);
    return [];
  }
  if (!token) return []; // credenciais não configuradas — feature opcional

  const codigoParaSlug = new Map(Object.entries(ESTACOES_ANA).map(([slug, codigo]) => [codigo, slug]));
  const lotes = codigosParaLotes(Object.values(ESTACOES_ANA));

  const resultados = await Promise.allSettled(lotes.map((lote) => buscarLote(lote, token)));

  const leituras = [];
  for (const resultado of resultados) {
    if (resultado.status === 'rejected') {
      console.error('Falha ao buscar lote de estações ANA:', resultado.reason.message);
      continue;
    }

    for (const item of resultado.value) {
      const slug = codigoParaSlug.get(item.codigoestacao);
      const nivel = converterCotaParaMetros(item.Cota_Adotada);
      const medidoEm = converterDataHoraAna(item.Data_Hora_Medicao);
      if (!slug || nivel === null || !medidoEm) continue;
      leituras.push({ slug, nivel, medidoEm, chuvaMm: converterChuvaMm(item.Chuva_Adotada) });
    }
  }

  // A API pode repetir o mesmo (estação, instante) entre lotes ou dentro de
  // um. O ON CONFLICT DO NOTHING do INSERT já resolveria (diferente de DO
  // UPDATE, ele aceita duplicata dentro do próprio comando) — deduplicar
  // aqui é só pra não inflar o payload do bulk insert à toa, já que são
  // ~2300 linhas por rodada.
  return deduplicarLeituras(leituras);
}

// Pura, exportada pra teste: última ocorrência vence, mesma chave do
// UNIQUE da tabela (slug, medido_em).
export function deduplicarLeituras(leituras) {
  const porChave = new Map();
  for (const l of leituras) porChave.set(`${l.slug}|${l.medidoEm}`, l);
  return [...porChave.values()];
}

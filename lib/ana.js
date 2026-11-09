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
  // typeof, não só !dataHora: se a API passar a mandar a data como número
  // (epoch), o .replace abaixo lançaria TypeError — e um item estranho
  // derrubaria a coleta inteira em vez de virar um descarte contado.
  if (typeof dataHora !== 'string' || !dataHora) return null;
  const semFracaoSegundo = dataHora.replace(' ', 'T').replace(/\.\d+$/, '');
  const data = new Date(`${semFracaoSegundo}-03:00`);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString();
}

// Pura, pra telemetria conseguir separar "ANA não configurada" (ausência
// esperada, não é falha) de "configurada e não respondeu" — ver ana_ok em
// `coletas` e GET /api/saude. Mesmo espírito de temVapidConfigurado.
export function temAnaConfigurada(env = process.env) {
  return Boolean(env.ANA_IDENTIFICADOR && env.ANA_SENHA);
}

// Tempos máximos de espera, em segundos — constantes nomeadas porque
// aparecem também na mensagem de erro ("sem resposta em 15s").
const TIMEOUT_AUTENTICACAO_S = 15;
const TIMEOUT_LOTE_S = 20;

// Teto do motivo gravado em coletas.erro_ana. Cabe status + mensagem da ANA
// + detalhe de conversão, sem deixar uma página HTML de erro inteira entrar
// no banco a cada 15 min.
const MAX_MOTIVO = 500;

// ---------------------------------------------------------------------
// DIAGNÓSTICO DE FALHA
//
// Até aqui toda falha da ANA virava a mesma coisa: [] e ana_ok = false.
// Senha recusada, servidor da ANA fora do ar e resposta em formato novo
// ficavam indistinguíveis — e foi assim que a ANA passou de 03/09 a 09/11
// de 2026 sem entregar nada sem que desse pra dizer por quê. As funções
// abaixo transformam cada falha num motivo legível, que a coleta grava em
// coletas.erro_ana e /api/saude expõe.
//
// Regra fixa: nenhum motivo pode conter credencial ou token. As mensagens
// são montadas só com status HTTP, a mensagem que a ANA devolve no corpo e
// NOMES de campo — nunca com headers nem valores recebidos.
// ---------------------------------------------------------------------

// Resume o corpo de uma resposta de erro em uma linha. A ANA responde erro
// de aplicação em JSON ({"message": "Usuário sem permissão de acesso ao
// módulo. Verifique!"}); a infraestrutura na frente dela responde em HTML
// (OpenShift: "Application is not available"; HAProxy: "504 Gateway
// Time-out"). Os dois casos precisam virar texto curto, porque é
// justamente o que separa "a ANA recusou" de "a ANA está fora do ar".
export function resumirCorpoErro(texto) {
  if (!texto) return '';
  try {
    const json = JSON.parse(texto);
    if (json && typeof json.message === 'string' && json.message.trim()) return json.message.trim();
  } catch {
    // Não é JSON — segue pro tratamento de HTML/texto.
  }
  const limpo = String(texto)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limpo.length > 120 ? `${limpo.slice(0, 120)}…` : limpo;
}

// Falha de rede (sem resposta HTTP nenhuma) em texto. Timeout ganha
// mensagem própria porque é o sintoma típico do servidor da ANA travado —
// diferente de recusa de conexão ou de DNS, que apontam pra outro lugar.
export function descreverFalhaRede(erro, segundos) {
  if (erro?.name === 'TimeoutError' || erro?.name === 'AbortError') return `sem resposta em ${segundos}s`;
  const codigo = erro?.cause?.code;
  const mensagem = erro?.message || String(erro);
  return codigo ? `${mensagem} (${codigo})` : mensagem;
}

async function erroHttp(etapa, resposta) {
  let corpo = '';
  try {
    corpo = resumirCorpoErro(await resposta.text());
  } catch {
    // Corpo ilegível não impede reportar o status, que é o principal.
  }
  return new Error(`${etapa}: HTTP ${resposta.status}${corpo ? ` — ${corpo}` : ''}`);
}

function limitarMotivo(texto) {
  return texto.length > MAX_MOTIVO ? `${texto.slice(0, MAX_MOTIVO - 1)}…` : texto;
}

// GET com headers Identificador/Senha (não é OAuth2 "de verdade", apesar
// do nome do endpoint) — devolve o JWT de curta duração (~1h) usado nas
// chamadas seguintes. Sem cache entre invocações: funções serverless não
// compartilham memória de forma confiável entre execuções, e a coleta roda
// a cada 15 min — reautenticar a cada rodada é uma chamada GET a mais, sem
// a complexidade de persistir/renovar token entre chamadas.
//
// Lança Error com o motivo já legível (ver erroHttp/descreverFalhaRede);
// quem chama decide o que fazer com ele.
async function autenticar(env, fetchFn) {
  let resposta;
  try {
    resposta = await fetchFn(`${BASE_URL}/OAUth/v1`, {
      headers: { Identificador: env.ANA_IDENTIFICADOR, Senha: env.ANA_SENHA },
      signal: AbortSignal.timeout(TIMEOUT_AUTENTICACAO_S * 1000),
    });
  } catch (erro) {
    throw new Error(`autenticação: ${descreverFalhaRede(erro, TIMEOUT_AUTENTICACAO_S)}`);
  }
  if (!resposta.ok) throw await erroHttp('autenticação', resposta);

  let dados;
  try {
    dados = await resposta.json();
  } catch {
    throw new Error('autenticação: resposta não é JSON');
  }
  const token = dados?.items?.tokenautenticacao;
  if (!token) {
    // Só os NOMES dos campos, nunca os valores — a resposta é justamente a
    // que carregaria o token.
    const campos = dados?.items && typeof dados.items === 'object' ? Object.keys(dados.items).join(', ') : 'nenhum';
    throw new Error(`autenticação: resposta sem token (campos em items: ${campos || 'nenhum'})`);
  }
  return token;
}

// Os nomes de parâmetro dessa API têm espaço/acento ("Tipo Filtro Data",
// "Código da Estação") — URLSearchParams codificaria a CHAVE errado (ou
// nem todo cliente HTTP aceita chave com espaço cru), por isso a URL é
// montada manualmente com encodeURIComponent também na chave. Confirmado
// funcionando assim numa chamada real durante a investigação desta sessão.
async function buscarLote(codigos, token, fetchFn) {
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

  let resposta;
  try {
    resposta = await fetchFn(`${BASE_URL}/HidroinfoanaSerieTelemetricaAdotada/v2?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_LOTE_S * 1000),
    });
  } catch (erro) {
    throw new Error(`consulta: ${descreverFalhaRede(erro, TIMEOUT_LOTE_S)}`);
  }
  if (!resposta.ok) throw await erroHttp('consulta', resposta);

  let dados;
  try {
    dados = await resposta.json();
  } catch {
    throw new Error('consulta: resposta não é JSON');
  }
  // Antes, "items" ausente virava [] em silêncio — indistinguível de "a
  // estação não mediu nada em 48h", que pra 10 estações ativas nunca
  // acontece. Agora é falha com nome.
  if (!Array.isArray(dados?.items)) {
    throw new Error(`consulta: resposta sem a lista "items" (items = ${dados?.items === null ? 'null' : typeof dados?.items})`);
  }
  return dados.items;
}

// Converte os itens crus da API em leituras nossas e CONTA o que descartou
// e por quê. Pura, exportada pra teste.
//
// Descartar um item ou outro é rotina (sensor sem cota naquele instante).
// Descartar TODOS é o sintoma de a ANA ter mudado o formato da resposta —
// um campo renomeado, um tipo trocado —, e sem a contagem por motivo isso
// seria indistinguível de "a ANA não mandou nada".
//
// O código da estação é comparado como TEXTO de propósito: se a API passar
// a mandar codigoestacao como número, um Map com chave string simplesmente
// não acharia nada, e todas as leituras sumiriam sem erro nenhum.
export function converterItensAna(itens, mapa = ESTACOES_ANA) {
  const codigoParaSlug = new Map(Object.entries(mapa).map(([slug, codigo]) => [String(codigo), slug]));
  const leituras = [];
  const descartes = { estacaoNaoMapeada: 0, cotaInvalida: 0, dataInvalida: 0 };

  for (const item of itens || []) {
    const slug = item?.codigoestacao == null ? undefined : codigoParaSlug.get(String(item.codigoestacao).trim());
    if (!slug) { descartes.estacaoNaoMapeada += 1; continue; }

    const nivel = converterCotaParaMetros(item.Cota_Adotada);
    if (nivel === null) { descartes.cotaInvalida += 1; continue; }

    const medidoEm = converterDataHoraAna(item.Data_Hora_Medicao);
    if (!medidoEm) { descartes.dataInvalida += 1; continue; }

    leituras.push({ slug, nivel, medidoEm, chuvaMm: converterChuvaMm(item.Chuva_Adotada) });
  }

  return { leituras, descartes };
}

function descreverDescartes(descartes) {
  const rotulos = {
    estacaoNaoMapeada: 'estação não mapeada',
    cotaInvalida: 'cota inválida',
    dataInvalida: 'data inválida',
  };
  return Object.entries(descartes)
    .filter(([, n]) => n > 0)
    .map(([chave, n]) => `${rotulos[chave]}: ${n}`)
    .join(', ');
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
// Devolve { leituras, erro }:
//   - erro null + leituras = tudo certo (ou ANA não configurada, que não é
//     falha — aí leituras vem vazia);
//   - erro preenchido = o MOTIVO, em texto, de algo ter dado errado. Pode
//     vir junto com leituras: um lote falhou e o outro não. Quem chama
//     grava em coletas.erro_ana.
//
// Continua sem lançar nunca — quem chama (coletar.js) não precisa de
// try/catch extra. `env` e `fetch` são injetáveis só pros testes.
export async function buscarNiveisAna({ env = process.env, fetch: fetchFn = globalThis.fetch } = {}) {
  if (!temAnaConfigurada(env)) return { leituras: [], erro: null }; // feature opcional

  let token;
  try {
    token = await autenticar(env, fetchFn);
  } catch (erro) {
    const motivo = limitarMotivo(erro.message);
    console.error('Falha na ANA —', motivo);
    return { leituras: [], erro: motivo };
  }

  const lotes = codigosParaLotes(Object.values(ESTACOES_ANA));
  const resultados = await Promise.allSettled(lotes.map((lote) => buscarLote(lote, token, fetchFn)));

  const problemas = [];
  const itens = [];
  resultados.forEach((resultado, i) => {
    if (resultado.status === 'rejected') {
      problemas.push(`lote ${i + 1} de ${lotes.length}: ${resultado.reason?.message ?? resultado.reason}`);
    } else {
      itens.push(...resultado.value);
    }
  });

  let convertidos;
  try {
    convertidos = converterItensAna(itens);
  } catch (erro) {
    // Defesa final pro contrato "nunca lança": um item num formato que
    // nenhuma conversão previu não pode derrubar a coleta inteira.
    convertidos = { leituras: [], descartes: {} };
    problemas.push(`conversão: ${erro.message}`);
  }
  const { leituras, descartes } = convertidos;

  if (itens.length > 0 && leituras.length === 0) {
    // Só NOMES de campo, nunca valores (ver regra no topo da seção).
    const campos = itens[0] && typeof itens[0] === 'object' ? Object.keys(itens[0]).join(', ') : typeof itens[0];
    problemas.push(
      `nenhuma das ${itens.length} leituras recebidas foi aproveitada (${descreverDescartes(descartes) || 'sem motivo contado'}; campos do 1º item: ${campos})`
    );
  } else if (itens.length === 0 && problemas.length === 0) {
    problemas.push('a ANA respondeu, mas sem nenhuma leitura em 48h');
  }

  const erro = problemas.length > 0 ? limitarMotivo(problemas.join(' | ')) : null;
  if (erro) console.error('Falha na ANA —', erro);

  // A API pode repetir o mesmo (estação, instante) entre lotes ou dentro de
  // um. O ON CONFLICT DO NOTHING do INSERT já resolveria (diferente de DO
  // UPDATE, ele aceita duplicata dentro do próprio comando) — deduplicar
  // aqui é só pra não inflar o payload do bulk insert à toa, já que são
  // ~2300 linhas por rodada.
  return { leituras: deduplicarLeituras(leituras), erro };
}

// Pura, exportada pra teste: última ocorrência vence, mesma chave do
// UNIQUE da tabela (slug, medido_em).
export function deduplicarLeituras(leituras) {
  const porChave = new Map();
  for (const l of leituras) porChave.set(`${l.slug}|${l.medidoEm}`, l);
  return [...porChave.values()];
}

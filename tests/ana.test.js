import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESTACOES_ANA, codigosParaLotes, converterCotaParaMetros, converterChuvaMm, converterDataHoraAna,
  calcularChuvaAcumulada, deduplicarLeituras, resumirCorpoErro, descreverFalhaRede, converterItensAna, buscarNiveisAna,
} from '../lib/ana.js';

test('ESTACOES_ANA: tem exatamente 12 estações mapeadas', () => {
  assert.equal(Object.keys(ESTACOES_ANA).length, 12);
});

test('ESTACOES_ANA: não inclui lajeado nem rocasales (ambiguidade não resolvida)', () => {
  assert.equal('lajeado' in ESTACOES_ANA, false);
  assert.equal('rocasales' in ESTACOES_ANA, false);
});

test('ESTACOES_ANA: inclui portoalegre com o código já validado (Usina do Gasômetro)', () => {
  assert.equal(ESTACOES_ANA.portoalegre, '87450020');
});

test('codigosParaLotes: divide em lotes de até 10 (limite da API)', () => {
  const codigos = Object.values(ESTACOES_ANA); // 12 códigos
  const lotes = codigosParaLotes(codigos);
  assert.equal(lotes.length, 2);
  assert.equal(lotes[0].length, 10);
  assert.equal(lotes[1].length, 2);
});

test('codigosParaLotes: menos códigos que o tamanho do lote vira um lote só', () => {
  const lotes = codigosParaLotes(['a', 'b', 'c'], 10);
  assert.deepEqual(lotes, [['a', 'b', 'c']]);
});

test('codigosParaLotes: lista vazia retorna nenhum lote', () => {
  assert.deepEqual(codigosParaLotes([]), []);
});

test('converterCotaParaMetros: centímetros (string, formato da API) vira metros', () => {
  assert.equal(converterCotaParaMetros('171.00'), 1.71);
  assert.equal(converterCotaParaMetros('242.00'), 2.42);
});

test('converterCotaParaMetros: null/undefined/inválido retorna null em vez de quebrar', () => {
  assert.equal(converterCotaParaMetros(null), null);
  assert.equal(converterCotaParaMetros(undefined), null);
  assert.equal(converterCotaParaMetros('não é número'), null);
});

test('converterChuvaMm: número válido (string, formato da API) fica como está, em mm', () => {
  assert.equal(converterChuvaMm('0.00'), 0);
  assert.equal(converterChuvaMm('12.40'), 12.4);
});

test('converterChuvaMm: null/undefined/inválido retorna null em vez de quebrar', () => {
  assert.equal(converterChuvaMm(null), null);
  assert.equal(converterChuvaMm(undefined), null);
  assert.equal(converterChuvaMm('não é número'), null);
});

test('converterDataHoraAna: interpreta como horário de Brasília (UTC-3), não UTC', () => {
  // Confirmado numa chamada real durante a investigação: uma leitura às
  // 15:15 (hora de Brasília) é 18:15 em UTC.
  assert.equal(converterDataHoraAna('2026-07-30 15:15:00.0'), '2026-07-30T18:15:00.000Z');
});

test('converterDataHoraAna: vazio/nulo retorna null', () => {
  assert.equal(converterDataHoraAna(null), null);
  assert.equal(converterDataHoraAna(''), null);
});

test('converterDataHoraAna: string inválida retorna null em vez de "Invalid Date"', () => {
  assert.equal(converterDataHoraAna('isso não é uma data'), null);
});

test('calcularChuvaAcumulada: lista vazia retorna null (sem dado)', () => {
  assert.equal(calcularChuvaAcumulada([]), null);
});

test('calcularChuvaAcumulada: uma única leitura retorna 0 (sem delta pra somar)', () => {
  assert.equal(calcularChuvaAcumulada([{ chuvaMm: 12, medidoEm: '2026-07-30T12:00:00Z' }]), 0);
});

test('calcularChuvaAcumulada: sequência monotônica crescente soma o total', () => {
  const leituras = [
    { chuvaMm: 0, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: 5, medidoEm: '2026-07-30T13:00:00Z' },
    { chuvaMm: 12, medidoEm: '2026-07-30T14:00:00Z' },
  ];
  assert.equal(calcularChuvaAcumulada(leituras), 12);
});

test('calcularChuvaAcumulada: queda no meio (reset) soma só os deltas positivos', () => {
  const leituras = [
    { chuvaMm: 5, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: 12, medidoEm: '2026-07-30T13:00:00Z' }, // +7
    { chuvaMm: 3, medidoEm: '2026-07-30T14:00:00Z' },  // queda — ignorada
    { chuvaMm: 9, medidoEm: '2026-07-30T15:00:00Z' },  // +6
  ];
  assert.equal(calcularChuvaAcumulada(leituras), 13);
});

test('calcularChuvaAcumulada: ignora leituras com chuvaMm null/undefined', () => {
  const leituras = [
    { chuvaMm: 2, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: null, medidoEm: '2026-07-30T12:30:00Z' },
    { chuvaMm: 8, medidoEm: '2026-07-30T13:00:00Z' },
    { chuvaMm: undefined, medidoEm: '2026-07-30T13:30:00Z' },
  ];
  assert.equal(calcularChuvaAcumulada(leituras), 6);
});

test('calcularChuvaAcumulada: todas as leituras null/undefined retorna null', () => {
  const leituras = [
    { chuvaMm: null, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: undefined, medidoEm: '2026-07-30T13:00:00Z' },
  ];
  assert.equal(calcularChuvaAcumulada(leituras), null);
});

test('calcularChuvaAcumulada: ordena internamente antes de somar (entrada fora de ordem)', () => {
  const leituras = [
    { chuvaMm: 9, medidoEm: '2026-07-30T15:00:00Z' },
    { chuvaMm: 0, medidoEm: '2026-07-30T12:00:00Z' },
    { chuvaMm: 5, medidoEm: '2026-07-30T13:00:00Z' },
  ];
  assert.equal(calcularChuvaAcumulada(leituras), 9);
});

// ---- deduplicarLeituras ----
// Guardamos as 48h inteiras que a API devolve, então a mesma (estação,
// instante) pode aparecer repetida entre lotes — e vai tudo num bulk insert.

test('deduplicarLeituras: mesma estação+instante vira uma linha só', () => {
  const r = deduplicarLeituras([
    { slug: 'mucum', nivel: 10.0, medidoEm: '2026-08-01T00:00:00.000Z', chuvaMm: 1 },
    { slug: 'mucum', nivel: 10.0, medidoEm: '2026-08-01T00:00:00.000Z', chuvaMm: 1 },
  ]);
  assert.equal(r.length, 1);
});

test('deduplicarLeituras: mesma estação em instantes diferentes são linhas distintas', () => {
  const r = deduplicarLeituras([
    { slug: 'mucum', nivel: 10.0, medidoEm: '2026-08-01T00:00:00.000Z' },
    { slug: 'mucum', nivel: 10.2, medidoEm: '2026-08-01T00:15:00.000Z' },
  ]);
  assert.equal(r.length, 2);
});

test('deduplicarLeituras: estações diferentes no mesmo instante não colidem', () => {
  const r = deduplicarLeituras([
    { slug: 'mucum', nivel: 10.0, medidoEm: '2026-08-01T00:00:00.000Z' },
    { slug: 'feliz', nivel: 3.0, medidoEm: '2026-08-01T00:00:00.000Z' },
  ]);
  assert.equal(r.length, 2);
});

test('deduplicarLeituras: lista vazia continua vazia', () => {
  assert.deepEqual(deduplicarLeituras([]), []);
});

// ---------------------------------------------------------------------
// DIAGNÓSTICO DE FALHA (coletas.erro_ana)
//
// buscarNiveisAna com fetch falso: cada teste simula um jeito real de a
// ANA falhar e confere que o motivo sai legível — e que credencial e token
// NUNCA aparecem nele, porque o motivo vai pro banco e pra uma rota pública.
// ---------------------------------------------------------------------

const CRED = { ANA_IDENTIFICADOR: 'ID-SECRETO-123', ANA_SENHA: 'SENHA-SECRETA-456' };
const TOKEN = 'TOKEN-SECRETO-789';

// Corpos de erro REAIS, copiados das respostas da ANA e da infraestrutura
// dela durante a investigação de 09/11/2026.
const CORPO_401_ANA = '{"status":"UNAUTHORIZED","code":401,"message":"Usuário sem permissão de acesso ao módulo. Verifique!","items":null}';
const CORPO_503_OPENSHIFT = `<html><head><style type="text/css">body { font-family: "Helvetica Neue"; }</style></head>
<body><div><h1>Application is not available</h1><p>The application is currently not serving requests at this endpoint.</p></div></body></html>`;
const CORPO_504_HAPROXY = "<html><body><h1>504 Gateway Time-out</h1>\nThe server didn't respond in time.\n</body></html>";

const json = (corpo, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
const html = (corpo, status) => new Response(corpo, { status, headers: { 'content-type': 'text/html' } });

const item = (codigo, extra = {}) => ({
  codigoestacao: codigo,
  Cota_Adotada: '171.00',
  Data_Hora_Medicao: '2026-11-09 10:00:00.0',
  Chuva_Adotada: '0.00',
  ...extra,
});

const authOk = () => json({ items: { tokenautenticacao: TOKEN } });
const loteOk = (codigos) => json({ items: codigos.map((c) => item(c)) });

// Roteia pela URL: autenticação pra `auth`, consulta pra `lote` (que
// recebe os códigos do lote). Registra as chamadas pra conferir headers.
function fetchFalso({ auth = authOk, lote = loteOk } = {}) {
  const chamadas = [];
  const fn = async (url, opcoes = {}) => {
    chamadas.push({ url, headers: opcoes.headers });
    if (url.includes('/OAUth/v1')) return auth();
    const codigos = new URL(url).searchParams.get('Codigos_Estacoes').split(',');
    return lote(codigos);
  };
  fn.chamadas = chamadas;
  return fn;
}

function semSegredos(erro) {
  for (const segredo of [CRED.ANA_IDENTIFICADOR, CRED.ANA_SENHA, TOKEN]) {
    assert.ok(!erro.includes(segredo), `o motivo não pode conter "${segredo}": ${erro}`);
  }
}

// As falhas também vão pro console.error (log do Vercel) — silenciado aqui
// só pra não poluir a saída dos testes.
const silenciar = (t) => t.mock.method(console, 'error', () => {});

test('resumirCorpoErro: JSON da ANA vira a "message" dela', () => {
  assert.equal(resumirCorpoErro(CORPO_401_ANA), 'Usuário sem permissão de acesso ao módulo. Verifique!');
});

test('resumirCorpoErro: HTML do OpenShift e do HAProxy viram texto, sem CSS nem tags', () => {
  assert.match(resumirCorpoErro(CORPO_503_OPENSHIFT), /^Application is not available The application/);
  assert.ok(!resumirCorpoErro(CORPO_503_OPENSHIFT).includes('Helvetica'));
  assert.equal(resumirCorpoErro(CORPO_504_HAPROXY), "504 Gateway Time-out The server didn't respond in time.");
});

test('resumirCorpoErro: vazio vira string vazia; texto longo é cortado', () => {
  assert.equal(resumirCorpoErro(''), '');
  assert.equal(resumirCorpoErro(null), '');
  const longo = resumirCorpoErro('x'.repeat(1000));
  assert.equal(longo.length, 121);
  assert.ok(longo.endsWith('…'));
});

test('descreverFalhaRede: timeout tem mensagem própria; erro de rede leva o código', () => {
  assert.equal(descreverFalhaRede(new DOMException('aborted', 'TimeoutError'), 15), 'sem resposta em 15s');
  const rede = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  assert.equal(descreverFalhaRede(rede, 15), 'fetch failed (ECONNRESET)');
});

test('converterItensAna: converte e conta os descartes por motivo', () => {
  const { leituras, descartes } = converterItensAna([
    item('87450020'),
    item('99999999'),                                 // estação fora do mapa
    item('87382000', { Cota_Adotada: null }),          // sensor sem cota
    item('86881000', { Data_Hora_Medicao: 1762689600000 }), // data como número
  ]);
  assert.equal(leituras.length, 1);
  assert.equal(leituras[0].slug, 'portoalegre');
  assert.equal(leituras[0].nivel, 1.71);
  assert.deepEqual(descartes, { estacaoNaoMapeada: 1, cotaInvalida: 1, dataInvalida: 1 });
});

test('converterItensAna: código da estação como NÚMERO ainda é reconhecido', () => {
  const { leituras } = converterItensAna([item(87450020)]);
  assert.equal(leituras.length, 1);
  assert.equal(leituras[0].slug, 'portoalegre');
});

test('buscarNiveisAna: sem credencial não chama a API e não conta como erro', async () => {
  const fetch = fetchFalso();
  const r = await buscarNiveisAna({ env: {}, fetch });
  assert.deepEqual(r, { leituras: [], erro: null });
  assert.equal(fetch.chamadas.length, 0);
});

test('buscarNiveisAna: tudo certo devolve as leituras e erro null', async () => {
  const fetch = fetchFalso();
  const r = await buscarNiveisAna({ env: CRED, fetch });
  assert.equal(r.erro, null);
  assert.equal(r.leituras.length, 12); // uma por estação mapeada
  // 1 autenticação + 2 lotes (10 + 2 estações), com o token no Bearer.
  assert.equal(fetch.chamadas.length, 3);
  assert.equal(fetch.chamadas[1].headers.Authorization, `Bearer ${TOKEN}`);
});

test('buscarNiveisAna: senha recusada (401) traz a mensagem da própria ANA', async (t) => {
  silenciar(t);
  const fetch = fetchFalso({ auth: () => new Response(CORPO_401_ANA, { status: 401 }) });
  const r = await buscarNiveisAna({ env: CRED, fetch });
  assert.deepEqual(r.leituras, []);
  assert.equal(r.erro, 'autenticação: HTTP 401 — Usuário sem permissão de acesso ao módulo. Verifique!');
  assert.equal(fetch.chamadas.length, 1, 'sem token, não tenta consultar');
  semSegredos(r.erro);
});

test('buscarNiveisAna: ANA fora do ar (503 do OpenShift) é distinguível de senha recusada', async (t) => {
  silenciar(t);
  const r = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ auth: () => html(CORPO_503_OPENSHIFT, 503) }) });
  assert.match(r.erro, /^autenticação: HTTP 503 — Application is not available/);
  semSegredos(r.erro);
});

test('buscarNiveisAna: servidor travado (timeout) vira "sem resposta em 15s"', async (t) => {
  silenciar(t);
  const auth = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const r = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ auth }) });
  assert.equal(r.erro, 'autenticação: sem resposta em 15s');
});

test('buscarNiveisAna: um lote cai (504) e o outro não — leituras parciais E motivo', async (t) => {
  silenciar(t);
  const lote = (codigos) => (codigos.length === 2 ? html(CORPO_504_HAPROXY, 504) : loteOk(codigos));
  const r = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ lote }) });
  assert.equal(r.leituras.length, 10);
  assert.equal(r.erro, "lote 2 de 2: consulta: HTTP 504 — 504 Gateway Time-out The server didn't respond in time.");
  semSegredos(r.erro);
});

test('buscarNiveisAna: formato da resposta mudou — diz quantas vieram, por que caíram e os campos', async (t) => {
  silenciar(t);
  // Cota_Adotada renomeado: todo item é descartado por "cota inválida".
  const lote = (codigos) => json({
    items: codigos.map((c) => ({ codigoestacao: c, CotaAdotada: 'VALOR-QUE-NAO-PODE-VAZAR', Data_Hora_Medicao: '2026-11-09 10:00:00.0' })),
  });
  const r = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ lote }) });
  assert.deepEqual(r.leituras, []);
  assert.equal(
    r.erro,
    'nenhuma das 12 leituras recebidas foi aproveitada (cota inválida: 12; campos do 1º item: codigoestacao, CotaAdotada, Data_Hora_Medicao)'
  );
  assert.ok(!r.erro.includes('VALOR-QUE-NAO-PODE-VAZAR'), 'só nomes de campo, nunca valores');
});

test('buscarNiveisAna: resposta vazia ou sem "items" não passa mais em silêncio', async (t) => {
  silenciar(t);
  const vazia = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ lote: () => json({ items: [] }) }) });
  assert.equal(vazia.erro, 'a ANA respondeu, mas sem nenhuma leitura em 48h');

  const semItems = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ lote: () => json({ items: null }) }) });
  assert.equal(
    semItems.erro,
    'lote 1 de 2: consulta: resposta sem a lista "items" (items = null) | lote 2 de 2: consulta: resposta sem a lista "items" (items = null)'
  );
});

test('buscarNiveisAna: autenticação sem token cita só os nomes dos campos', async (t) => {
  silenciar(t);
  const auth = () => json({ items: { outroCampo: 'VALOR-SECRETO' } });
  const r = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ auth }) });
  assert.equal(r.erro, 'autenticação: resposta sem token (campos em items: outroCampo)');
  assert.ok(!r.erro.includes('VALOR-SECRETO'));
});

test('buscarNiveisAna: motivo enorme é limitado a 500 caracteres', async (t) => {
  silenciar(t);
  const auth = () => json({ message: 'm'.repeat(5000) }, 401);
  const r = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ auth }) });
  assert.equal(r.erro.length, 500);
  assert.ok(r.erro.endsWith('…'));
});

test('buscarNiveisAna: consulta travada (timeout) em todos os lotes', async (t) => {
  silenciar(t);
  const lote = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const r = await buscarNiveisAna({ env: CRED, fetch: fetchFalso({ lote }) });
  assert.deepEqual(r.leituras, []);
  assert.equal(r.erro, 'lote 1 de 2: consulta: sem resposta em 20s | lote 2 de 2: consulta: sem resposta em 20s');
});

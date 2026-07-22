const FEED_URL = 'https://nivelguaiba.com.br/feed';

// O feed é um JSON Feed 1.1. Cada item tem:
//   id: "https://nivelguaiba.com.br/taquara#2026-06-15T10:30:00-03:00"
//   title: "Taquara: 2,22m — Normal (Rio dos Sinos)"
//   content_text: "Nível atual em Taquara / Rio dos Sinos: 2.22 metros. Status: normal."
//   date_published: "2026-06-15T10:30:00-03:00"
//   tags: ["rio", "normal", "taquara"]
//
// O slug sai da URL. Porto Alegre é a home ("/"), então tratamos esse caso.
// O nível sai do content_text, que usa ponto decimal (mais confiável que o title,
// que usa vírgula e pode variar de formato).

function extrairSlug(url) {
  const caminho = new URL(url).pathname.replace(/\//g, '');
  return caminho === '' ? 'portoalegre' : caminho;
}

function extrairNivel(texto) {
  const m = texto.match(/([\d]+[.,][\d]+)\s*metros/i);
  if (!m) return null;
  const valor = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(valor) ? valor : null;
}

export async function buscarFeed() {
  const resposta = await fetch(FEED_URL, {
    headers: { 'User-Agent': 'MonitorNiveisInterno/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!resposta.ok) {
    throw new Error(`Feed retornou HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();
  const itens = Array.isArray(dados.items) ? dados.items : [];

  const leituras = [];
  for (const item of itens) {
    try {
      const slug = extrairSlug(item.url);
      const nivel = extrairNivel(item.content_text || '');
      const medidoEm = item.date_published;

      if (!slug || nivel === null || !medidoEm) continue;

      leituras.push({ slug, nivel, medidoEm: new Date(medidoEm).toISOString() });
    } catch {
      // Item malformado: ignora e segue com os demais.
      continue;
    }
  }

  return leituras;
}

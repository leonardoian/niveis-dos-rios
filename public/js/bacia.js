// Lógica exclusiva do mapa da bacia (bacia.html). Depende de js/tema.js
// (tema, precisa carregar antes) e js/comum.js (hora, ROTULOS, CORES,
// CONDICOES/condicaoTexto, também antes).

// Coordenadas da sede de cada cidade (fato de geografia, não vem do banco).
// Fonte: Wikipédia (infobox de cada município).
const COORDS = {
  portoalegre:       [-30.03278, -51.23000],
  saoleopoldo:       [-29.76000, -51.14694],
  lajeado:           [-29.46694, -51.96083],
  bomretirodosul:    [-29.60889, -51.94278],
  cachoeiradosul:    [-30.03890, -52.89390],
  donafrancisca:     [-29.62194, -53.35694],
  encantado:         [-29.23583, -51.87000],
  feliz:             [-29.45083, -51.30583],
  gravatai:          [-29.94389, -50.99194],
  mucum:             [-29.16700, -51.88300],
  riopardo:          [-29.98972, -52.37806],
  saosebastiaodocai: [-29.58694, -51.37583],
  taquara:           [-29.65056, -50.78056],
  rocasales:         [-29.28300, -51.86700],
};

// Hierarquia da bacia (fato de geografia, não vem do banco): qual rio
// deságua em qual, e em que grupo cada estação monitorada se encaixa.
const TIERS = [
  { id: 'tier-alto-taquari', slugs: ['rocasales', 'mucum', 'encantado'] },
  { id: 'tier-taquari',      slugs: ['lajeado', 'bomretirodosul'] },
  { id: 'tier-jacui',        slugs: ['riopardo', 'cachoeiradosul', 'donafrancisca'] },
  { id: 'tier-cai',          slugs: ['feliz', 'saosebastiaodocai'] },
  { id: 'tier-sinos',        slugs: ['taquara', 'saoleopoldo'] },
  { id: 'tier-gravatai',     slugs: ['gravatai'] },
  { id: 'tier-guaiba',       slugs: ['portoalegre'] },
];

function pill(e) {
  const nivel = e.nivel === null ? '—' : e.nivel.toFixed(2) + ' m';
  return `<div class="pill ${e.status}">
    <div class="pill-cidade">${e.cidade}/${e.uf}</div>
    <div class="pill-nivel">${nivel}</div>
    <div class="pill-tag">${ROTULOS[e.status]}</div>
  </div>`;
}

// Centro aproximado do Rio Grande do Sul, zoom que enquadra a região das
// 14 estações (todas ficam na metade norte/central do estado).
const mapa = L.map('mapa').setView([-29.7, -51.8], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 18,
}).addTo(mapa);

const marcadores = new Map();

function popupHtml(e) {
  const nivel = e.nivel === null ? '—' : e.nivel.toFixed(2) + ' m';
  let clima = '';
  if (e.climaHoje) {
    const c = e.climaHoje;
    const chuva = c.chuvaMm === null ? '—' : c.chuvaMm.toFixed(1) + 'mm';
    clima = `<div class="popup-rio">${condicaoTexto(c.condicaoCodigo)} · ${Math.round(c.tempMax)}°/${Math.round(c.tempMin)}°C · ${chuva} hoje</div>`;
  }
  return `<div class="popup-cidade">${e.cidade}/${e.uf}</div>
    <div class="popup-rio">${e.rio}</div>
    <div class="popup-nivel">${nivel} — ${ROTULOS[e.status]}</div>
    ${clima}`;
}

function atualizarMapa(estacoes) {
  for (const e of estacoes) {
    const coord = COORDS[e.slug];
    if (!coord) continue;

    const cor = CORES[e.status];
    let marcador = marcadores.get(e.slug);

    if (!marcador) {
      marcador = L.circleMarker(coord, {
        radius: 9, color: '#fff', weight: 2, fillColor: cor, fillOpacity: 0.9,
      }).addTo(mapa);
      marcadores.set(e.slug, marcador);
    } else {
      marcador.setStyle({ fillColor: cor });
    }

    marcador.bindPopup(popupHtml(e));
  }
}

async function carregar() {
  try {
    const r = await fetch('/api/painel');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const dados = await r.json();
    document.getElementById('aviso').innerHTML = '';

    const porSlug = new Map(dados.estacoes.map((e) => [e.slug, e]));

    atualizarMapa(dados.estacoes);

    for (const tier of TIERS) {
      const alvo = document.getElementById(tier.id);
      if (!alvo) continue;
      alvo.innerHTML = tier.slugs
        .map((slug) => porSlug.get(slug))
        .filter(Boolean)
        .map(pill)
        .join('');
    }

    document.getElementById('sub').textContent =
      dados.estacoes.length + ' estações · atualizado ' + hora(dados.atualizadoEm);
  } catch (e) {
    mostrarAviso('aviso', 'Não foi possível carregar os dados: ' + e.message);
  }
}

carregar();
setInterval(carregar, 5 * 60 * 1000);

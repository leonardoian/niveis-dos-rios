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
  // Chuva MEDIDA na própria estação (ANA) — linha separada da previsão
  // acima, mesma disciplina do card no painel principal.
  let chuvaMedida = '';
  if (e.chuvaMedidaAnaMm !== null && e.chuvaMedidaAnaMm !== undefined) {
    chuvaMedida = `<div class="popup-rio">💧 ${e.chuvaMedidaAnaMm.toFixed(1)}mm medidos na estação (ANA)</div>`;
  }
  return `<div class="popup-cidade">${e.cidade}/${e.uf}</div>
    <div class="popup-rio">${e.rio}</div>
    <div class="popup-nivel">${nivel} — ${ROTULOS[e.status]}</div>
    ${clima}
    ${chuvaMedida}`;
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

// ---- Radar de chuva (RainViewer, opcional — desligado por padrão) ----
// A API é gratuita e sem chave, mas os frames disponíveis mudam a cada
// poucos minutos — por isso busca o mapa de frames de novo a cada refresh,
// em vez de guardar uma URL fixa.
const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
let camadaRadar = null;
let timerRadar = null;

async function ligarRadar() {
  try {
    const r = await fetch(RAINVIEWER_API);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const dados = await r.json();
    const frames = dados.radar && dados.radar.past;
    if (!Array.isArray(frames) || frames.length === 0) throw new Error('Sem frames de radar disponíveis');

    const ultimo = frames[frames.length - 1];
    const url = `${dados.host}${ultimo.path}/256/{z}/{x}/{y}/2/1_1.png`;

    if (camadaRadar) mapa.removeLayer(camadaRadar);
    camadaRadar = L.tileLayer(url, {
      maxNativeZoom: 7,
      maxZoom: 18,
      opacity: 0.55,
      attribution: 'Radar via <a href="https://www.rainviewer.com/">RainViewer</a>',
    }).addTo(mapa);
  } catch (e) {
    mostrarAviso('aviso', 'Não foi possível carregar o radar de chuva: ' + e.message);
    desligarRadar();
  }
}

function desligarRadar() {
  if (camadaRadar) {
    mapa.removeLayer(camadaRadar);
    camadaRadar = null;
  }
  clearInterval(timerRadar);
  timerRadar = null;
  const btn = document.getElementById('radarToggle');
  if (btn) btn.dataset.ativo = '0';
}

document.getElementById('radarToggle').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const ativo = btn.dataset.ativo === '1';
  if (ativo) {
    desligarRadar();
    return;
  }
  btn.dataset.ativo = '1';
  await ligarRadar();
  // RainViewer publica frame novo a cada ~5-10 min — refresca nesse ritmo
  // enquanto a camada estiver ligada, pra não mostrar chuva desatualizada.
  timerRadar = setInterval(ligarRadar, 10 * 60 * 1000);
});

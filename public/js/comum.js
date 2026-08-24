// Utilidades compartilhadas por index.html, bacia.html, acerto.html e
// fontes.html.

function hora(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

const ROTULOS = { normal: 'Normal', atencao: 'Atenção', alerta: 'Alerta', alagado: 'Alagado', sem_dado: 'Sem dado' };
const CORES   = { normal: '#639922', atencao: '#ba7517', alerta: '#ef9f27', alagado: '#e24b4a', sem_dado: '#c9ccd2' };

// WMO weather code (Open-Meteo) -> texto/ícone em pt-BR.
const CONDICOES = {
  0: '☀️ Céu limpo', 1: '🌤 Poucas nuvens', 2: '⛅ Parcialmente nublado', 3: '☁️ Nublado',
  45: '🌫 Neblina', 48: '🌫 Neblina',
  51: '🌦 Garoa', 53: '🌦 Garoa', 55: '🌦 Garoa',
  56: '🌧❄ Garoa congelante', 57: '🌧❄ Garoa congelante',
  61: '🌧 Chuva', 63: '🌧 Chuva', 65: '🌧 Chuva forte',
  66: '🌧❄ Chuva congelante', 67: '🌧❄ Chuva congelante',
  71: '🌨 Neve', 73: '🌨 Neve', 75: '🌨 Neve forte', 77: '🌨 Neve',
  80: '🌦 Pancadas de chuva', 81: '🌦 Pancadas de chuva', 82: '⛈ Pancadas fortes',
  85: '🌨 Pancadas de neve', 86: '🌨 Pancadas de neve',
  95: '⛈ Trovoada', 96: '⛈ Trovoada c/ granizo', 99: '⛈ Trovoada c/ granizo',
};
function condicaoTexto(codigo) {
  return CONDICOES[codigo] || 'Condição desconhecida';
}

// Só o emoji (primeiro "token" de CONDICOES), sem duplicar a tabela WMO —
// usado onde o ícone precisa ficar separado do texto (ex.: card de
// previsão do tempo).
function condicaoEmoji(codigo) {
  const texto = CONDICOES[codigo];
  return texto ? texto.split(' ')[0] : '❓';
}

// Mostra uma mensagem de erro dentro de #<elId> como uma <div class="aviso">
// — usa textContent pra parte variável (nunca innerHTML + concatenação),
// pra um "Não foi possível carregar: " + e.message nunca virar vetor de XSS
// mesmo que um dia e.message passe a incluir texto vindo do servidor.
function mostrarAviso(elId, mensagem) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = '';
  const div = document.createElement('div');
  div.className = 'aviso';
  div.textContent = mensagem;
  el.appendChild(div);
}

// ---- Destaque visual quando um valor muda no refresh automático ----
// Não faz contagem progressiva (12.3 -> 12.7 interpolado): se um print
// (html2canvas ou @media print) capturar o meio da interpolação, mostraria
// um valor errado. O texto final é escrito de uma vez com textContent; só um
// pulso decorativo (ver @keyframes pulso-valor/pulso-card em painel.css)
// chama atenção, sem nunca comprometer a leitura do dado.

// Pra elementos de id fixo (não recriados a cada render), tipo os KPIs.
// "—" é o placeholder inicial (antes do primeiro fetch responder) — não
// conta como "valor anterior" pra não pulsar sem necessidade assim que os
// dados chegam pela primeira vez.
function aplicarComDestaque(el, novoTexto, classe = 'valor-mudou') {
  if (!el) return;
  const semValorAnterior = el.textContent === '' || el.textContent === '—';
  const mudou = !semValorAnterior && el.textContent !== novoTexto;
  el.textContent = novoTexto;
  if (mudou) {
    el.classList.remove(classe);
    void el.offsetWidth; // força reflow, senão remove+add na mesma tick não reinicia a animação
    el.classList.add(classe);
  }
}

// Pra containers recriados via innerHTML (grid de cards, pills da bacia):
// tira um retrato dos valores ANTES de sobrescrever o HTML.
function valoresAntesDeRenderizar(containerSel, itemSel, chaveAttr, valorSel) {
  const mapa = new Map();
  document.querySelectorAll(`${containerSel} ${itemSel}`).forEach((el) => {
    mapa.set(el.dataset[chaveAttr], el.querySelector(valorSel)?.textContent);
  });
  return mapa;
}

// ...e marca quem mudou DEPOIS do innerHTML novo já estar no DOM.
function destacarMudancas(containerSel, itemSel, chaveAttr, valorSel, valoresAntigos, classe = 'card-atualizado') {
  document.querySelectorAll(`${containerSel} ${itemSel}`).forEach((el) => {
    const chave = el.dataset[chaveAttr];
    const novo = el.querySelector(valorSel)?.textContent;
    if (valoresAntigos.has(chave) && valoresAntigos.get(chave) !== novo) {
      el.classList.add(classe);
    }
  });
}

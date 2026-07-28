// Utilidades compartilhadas por index.html, bacia.html e acerto.html.

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

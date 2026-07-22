const FLOOD_API_URL = 'https://flood-api.open-meteo.com/v1/flood';

// Previsão de VAZÃO (river_discharge, m³/s) via GloFAS/Open-Meteo — API
// pública, sem chave. NÃO é previsão de nível em metros: converter vazão em
// nível exigiria a curva-chave específica de cada estação, que não temos.
// Por isso a vazão prevista é um dado à parte, nunca comparada com
// cota_inundacao nem usada no cálculo de status/alerta.
export async function buscarPrevisao(lat, lon) {
  const url = `${FLOOD_API_URL}?latitude=${lat}&longitude=${lon}&daily=river_discharge&forecast_days=7`;

  const resposta = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resposta.ok) {
    throw new Error(`Open-Meteo Flood API retornou HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();
  const dias = dados.daily?.time || [];
  const vazoes = dados.daily?.river_discharge || [];

  return dias
    .map((dia, i) => ({ dia, vazaoM3s: vazoes[i] }))
    .filter((p) => typeof p.vazaoM3s === 'number' && Number.isFinite(p.vazaoM3s));
}

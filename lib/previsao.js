const FLOOD_API_URL = 'https://flood-api.open-meteo.com/v1/flood';
const FORECAST_API_URL = 'https://api.open-meteo.com/v1/forecast';

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

// Previsão de clima (temperatura, chuva, condição) via Open-Meteo — API
// pública, sem chave. condicaoCodigo é o WMO weather code padrão (0 = céu
// limpo, 61-65 = chuva, 95+ = trovoada etc.); o front traduz pra texto/ícone.
export async function buscarClima(lat, lon) {
  const url =
    `${FORECAST_API_URL}?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
    `&forecast_days=7&timezone=America%2FSao_Paulo`;

  const resposta = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resposta.ok) {
    throw new Error(`Open-Meteo Forecast API retornou HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();
  const dias = dados.daily?.time || [];
  const tempMax = dados.daily?.temperature_2m_max || [];
  const tempMin = dados.daily?.temperature_2m_min || [];
  const chuva = dados.daily?.precipitation_sum || [];
  const condicao = dados.daily?.weathercode || [];

  return dias
    .map((dia, i) => ({
      dia,
      tempMax: tempMax[i],
      tempMin: tempMin[i],
      chuvaMm: chuva[i],
      condicaoCodigo: condicao[i],
    }))
    .filter((p) => typeof p.tempMax === 'number' && Number.isFinite(p.tempMax));
}

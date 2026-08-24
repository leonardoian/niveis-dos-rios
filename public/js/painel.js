// Lógica exclusiva do painel principal (index.html). Depende de js/tema.js
// (tema, precisa carregar antes) e js/comum.js (hora, ROTULOS, CORES,
// CONDICOES/condicaoTexto, também antes).

// Reaproveita a mesma paleta de status pro pontinho de frescor da leitura —
// não é o mesmo conceito (frescor é "a leitura está velha?", não "o rio está
// alto?"), mas as cores verde/amarelo/vermelho comunicam a mesma urgência.
const FRESCOR_PARA_COR = { ao_vivo: 'normal', atrasado: 'atencao', obsoleto: 'alagado', sem_dado: 'sem_dado' };
const FRESCOR_TITULO = { ao_vivo: 'Dado ao vivo', atrasado: 'Dado atrasado (20–60 min)', obsoleto: 'Dado obsoleto (mais de 1h)', sem_dado: 'Sem leitura' };

// ---- Modo apresentação (tela cheia pra monitor de sala) ----
function estaApresentando() {
  return document.body.classList.contains('apresentacao');
}

async function alternarApresentacao() {
  const btn = document.getElementById('apresentacaoToggle');

  if (!estaApresentando()) {
    document.body.classList.add('apresentacao');
    btn.textContent = '✕ Sair da apresentação';
    try {
      await document.documentElement.requestFullscreen();
    } catch (e) {
      // Navegador pode bloquear tela cheia (permissão, iframe etc.) — o
      // modo apresentação (esconder controles, aumentar cards) continua
      // valendo mesmo sem a tela cheia real.
    }
  } else {
    document.body.classList.remove('apresentacao');
    btn.textContent = '🖥 Apresentação';
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch (e) { /* nada a fazer */ }
    }
  }
}

// Se o usuário sai da tela cheia pelo ESC (não pelo nosso botão), o
// document.exitFullscreen() nunca é chamado por nós — sincroniza aqui.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && estaApresentando()) {
    document.body.classList.remove('apresentacao');
    document.getElementById('apresentacaoToggle').textContent = '🖥 Apresentação';
  }
});

document.getElementById('apresentacaoToggle').addEventListener('click', alternarApresentacao);

// ---- Gerar PDF (banner de uma página, visual igual aos cards) ----
// Tira uma "foto" do painel (html2canvas) e encolhe pra caber inteira numa
// página só (em vez de imprimir em tamanho real e cortar em várias páginas)
// — mantém as cores/bordas/sparklines reais dos cards, só menor.
async function gerarPdf() {
  const btn = document.getElementById('gerarPdf');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Gerando PDF…';
  document.body.classList.add('gerando-pdf');

  try {
    // .pagina engloba o hero (fica fora de .wrap pra poder ser full-bleed)
    // + .wrap — sem isso o banner exportado perderia a capa com foto.
    const alvo = document.querySelector('.pagina');
    const corFundo = getComputedStyle(document.body).backgroundColor || '#ffffff';
    const canvas = await html2canvas(alvo, { scale: 2, backgroundColor: corFundo, useCORS: true });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const margem = 8;
    const larguraDisponivel = pdf.internal.pageSize.getWidth() - margem * 2;
    const alturaDisponivel = pdf.internal.pageSize.getHeight() - margem * 2;

    // Encolhe mantendo a proporção, pelo lado que for mais restritivo
    // (largura ou altura), pra caber tudo numa página só.
    const escala = Math.min(larguraDisponivel / canvas.width, alturaDisponivel / canvas.height);
    const imgWidth = canvas.width * escala;
    const imgHeight = canvas.height * escala;
    const x = margem + (larguraDisponivel - imgWidth) / 2;
    const y = margem + (alturaDisponivel - imgHeight) / 2;

    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, imgWidth, imgHeight);

    const hoje = new Date().toISOString().slice(0, 10);
    pdf.save(`niveis-dos-rios-${hoje}.pdf`);
  } catch (e) {
    mostrarAviso('aviso', 'Não foi possível gerar o PDF: ' + e.message);
  } finally {
    document.body.classList.remove('gerando-pdf');
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

document.getElementById('gerarPdf').addEventListener('click', gerarPdf);

let dados = null;
let timerColeta = null;
let proximaColetaEm = null;

// A coleta roda a cada 15 min (ver .github/workflows/coletar.yml); a
// contagem é só uma estimativa a partir da leitura mais recente — o GitHub
// Actions pode atrasar alguns minutos, então perto de zero vira um aviso
// de atraso em vez de um número negativo.
const INTERVALO_COLETA_MS = 15 * 60 * 1000;

function iniciarContagemColeta(ultimaColetaIso) {
  clearInterval(timerColeta);
  const el = document.getElementById('proxColeta');
  if (!ultimaColetaIso) {
    if (el) el.hidden = true;
    proximaColetaEm = null;
    return;
  }
  if (el) el.hidden = false;
  proximaColetaEm = new Date(ultimaColetaIso).getTime() + INTERVALO_COLETA_MS;
  atualizarContagem();
  timerColeta = setInterval(atualizarContagem, 1000);
}

// O anel drena de cheio (acabou de coletar) pra vazio (hora da próxima
// coleta) — igual a uma contagem regressiva visual. Numa tela de monitor
// sem ninguém interagindo, é o que distingue "rio estável, só esperando
// a próxima leitura" de "isso travou".
function atualizarAnelProgresso(fracaoDecorrida, atrasado) {
  const anel = document.getElementById('anelProgresso');
  if (!anel) return;
  const offset = Math.max(0, Math.min(100, fracaoDecorrida * 100));
  anel.setAttribute('stroke-dashoffset', atrasado ? 0 : String(offset));
  anel.setAttribute('stroke', atrasado ? CORES.atencao : 'var(--acento)');
}

function atualizarContagem() {
  const el = document.getElementById('proxColetaTexto');
  if (!el || proximaColetaEm === null) return;

  const restante = proximaColetaEm - Date.now();
  if (restante <= 0) {
    const atrasoMin = Math.floor(-restante / 60000);
    el.textContent = atrasoMin < 1
      ? '⏱ atualizando a qualquer momento'
      : `⏱ atrasado ${atrasoMin} min`;
    atualizarAnelProgresso(1, true);
    return;
  }

  const min = String(Math.floor(restante / 60000)).padStart(2, '0');
  const seg = String(Math.floor((restante % 60000) / 1000)).padStart(2, '0');
  el.textContent = `⏱ próxima coleta em ${min}:${seg}`;
  atualizarAnelProgresso(1 - restante / INTERVALO_COLETA_MS, false);
}

async function carregar() {
  const btn = document.getElementById('atualizar');
  btn.disabled = true;
  btn.textContent = 'Atualizando…';
  try {
    const r = await fetch('/api/painel');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    dados = await r.json();
    document.getElementById('aviso').innerHTML = '';
    render();
    iniciarContagemColeta(dados.ultimaColeta);
    renderizarStatusFontes();
  } catch (e) {
    mostrarAviso('aviso', 'Não foi possível carregar os dados: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Atualizar';
  }
}



// Colunas DATE do Postgres podem vir como "2024-05-02" (data simples) ou
// como timestamp completo "2024-05-02T00:00:00.000Z" (depende do driver do
// Neon) — normaliza pros 10 primeiros caracteres antes de montar a data,
// senão concatenar direto vira "Invalid Date" (mesmo bug já visto em
// renderizarTendenciaVazao).
function formatarDataSimples(data) {
  if (!data) return '—';
  const dataSimples = String(data).slice(0, 10);
  return new Date(dataSimples + 'T12:00:00').toLocaleDateString('pt-BR');
}

function formatarIdade(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const horas = Math.round(min / 60);
  if (horas < 48) return `${horas}h`;
  return `${Math.round(horas / 24)} dias`;
}

// Status de uma FONTE (não de uma estação) — mesma ideia do frescor por
// leitura, mas com limiares próprios: a previsão só atualiza a cada 6h por
// design (ver lib/coletar.js), então usar o limiar de 1h do frescor
// acusaria "obsoleto" o tempo todo, mesmo funcionando normal.
function calcularStatusFonte(iso, limiarOkMs, limiarAtrasadoMs) {
  if (!iso) return 'sem_dado';
  const idadeMs = Date.now() - new Date(iso).getTime();
  if (idadeMs <= limiarOkMs) return 'ao_vivo';
  if (idadeMs <= limiarAtrasadoMs) return 'atrasado';
  return 'obsoleto';
}

// ---- Status de saúde das fontes (rodapé) ----
// Diferente do frescor por estação (que é "essa leitura está velha?"), isso
// é "a fonte como um todo está respondendo?" — pra flagrar rápido se o feed
// ou a Open-Meteo pararem de vez, sem precisar abrir cada card.
function renderizarStatusFontes() {
  const el = document.getElementById('statusFontes');
  if (!el) return;
  if (!dados) { el.innerHTML = ''; return; }

  const fontes = [
    { rotulo: 'Nível dos rios', detalhe: 'nivelguaiba.com.br', iso: dados.ultimaColeta, limiarOk: 20 * 60000, limiarAtrasado: 60 * 60000 },
    { rotulo: 'Vazão e clima previstos', detalhe: 'Open-Meteo', iso: dados.ultimaPrevisao, limiarOk: 8 * 3600000, limiarAtrasado: 24 * 3600000 },
  ];

  el.innerHTML = fontes.map((f) => {
    const status = calcularStatusFonte(f.iso, f.limiarOk, f.limiarAtrasado);
    const cor = CORES[FRESCOR_PARA_COR[status]];
    const texto = status === 'sem_dado' ? 'sem dado ainda' : `atualizado há ${formatarIdade(Date.now() - new Date(f.iso).getTime())}`;
    return `<span class="status-fonte" title="${f.detalhe}"><span class="frescor" style="background:${cor}"></span>${f.rotulo}: ${texto}</span>`;
  }).join('');
}

// Extrapolação linear simples da tendência MEDIDA agora (cm/h) — usada
// tanto no card quanto no modal de histórico, por isso fica compartilhada.
// Dois casos: subindo (quanto falta pra atingir a cota) e descendo (quanto
// falta pra voltar ao "normal", usando o mesmo limiar de 60% da cota que já
// define o status "normal" no resto do app). Só usa as duas últimas
// leituras, então é sensível a ruído — por isso o texto sempre deixa claro
// que é estimativa, não previsão.
function calcularEtaCota(e) {
  if (e.velocidadeCmH === null || e.margem === null || e.nivel === null || !e.cota) return null;

  if (e.velocidadeCmH > 0) {
    if (e.margem <= 0) return null; // já atingiu/passou a cota
    const horas = (e.margem * 100) / e.velocidadeCmH;
    if (!Number.isFinite(horas) || horas <= 0) return null;
    return { classe: 'subindo', horas, velocidadeCmH: e.velocidadeCmH };
  }

  if (e.velocidadeCmH < 0) {
    if (e.percentualCota === null || e.percentualCota < 60) return null; // já está normal
    const nivelNormal = e.cota * 0.6;
    const margemAteNormal = e.nivel - nivelNormal;
    const horas = (margemAteNormal * 100) / Math.abs(e.velocidadeCmH);
    if (!Number.isFinite(horas) || horas <= 0) return null;
    return { classe: 'descendo', horas, velocidadeCmH: e.velocidadeCmH };
  }

  return null;
}

function card(e, indice = 0, comAnimacao = false) {
  const pct = e.percentualCota === null ? 0 : Math.min(100, e.percentualCota);
  const cor = CORES[e.status];
  const nivel = e.nivel === null ? '—' : e.nivel.toFixed(2);

  let vel = '<p class="vel">Tendência indisponível</p>';
  if (e.velocidadeCmH !== null) {
    const cls = e.velocidadeCmH > 0 ? 'sobe' : e.velocidadeCmH < 0 ? 'desce' : '';
    const seta = e.velocidadeCmH > 0 ? '▲' : e.velocidadeCmH < 0 ? '▼' : '■';
    vel = `<p class="vel ${cls}">${seta} ${Math.abs(e.velocidadeCmH).toFixed(1)} cm/h</p>`;
  }

  let etaHtml = '';
  const eta = calcularEtaCota(e);
  if (eta) {
    const texto = eta.classe === 'subindo'
      ? `⏱ atinge a cota em ~${formatarHorasEstimativa(eta.horas)}`
      : `↩ volta ao normal em ~${formatarHorasEstimativa(eta.horas)}`;
    etaHtml = `<p class="eta ${eta.classe}" title="Estimativa simples da tendência medida agora (últimas leituras), não é previsão.">${texto}</p>`;
  }

  const margem = e.margem === null ? '—'
    : e.margem >= 0 ? e.margem.toFixed(2) + ' m abaixo'
    : Math.abs(e.margem).toFixed(2) + ' m acima';

  // Comparativo com o pico da enchente de maio/2024 — só existe pras
  // estações onde achamos um registro confiável (ver nota em schema.sql);
  // fica null (some do card) nas demais em vez de arriscar mostrar um
  // número errado.
  let cheia2024Html = '';
  if (e.cheia2024 && e.nivel !== null && e.cheia2024.nivel > 0) {
    const diff = e.cheia2024.nivel - e.nivel;
    const pct = ((e.nivel / e.cheia2024.nivel) * 100).toFixed(0);
    const diffTexto = diff >= 0 ? diff.toFixed(2) + ' m abaixo' : Math.abs(diff).toFixed(2) + ' m acima';
    const dataFmt = formatarDataSimples(e.cheia2024.data);
    cheia2024Html = `<div class="cheia2024" title="Pico da cheia de maio/2024 nesta estação: ${e.cheia2024.nivel.toFixed(2)} m em ${dataFmt}. Fonte: nivelguaiba.com.br.">🌊 ${pct}% do nível da cheia de 2024 (${diffTexto})</div>`;
  }

  const temSerie = Array.isArray(e.serieRecente) && e.serieRecente.length >= 2;
  let spark;
  if (temSerie) {
    const niveis = e.serieRecente.map((p) => p.nivel);
    const min = Math.min(...niveis);
    const max = Math.max(...niveis);
    spark = `<div class="spark-wrap"><canvas id="spark-${e.slug}"></canvas></div>
      <div class="spark-legenda">mín ${min.toFixed(2)} · máx ${max.toFixed(2)} m (últimas leituras)</div>`;
  } else {
    spark = `<div class="spark-wrap vazio">Sem histórico suficiente</div>`;
  }

  // vazao_m3s pode ser null em algum dia (a chamada de vazão daquele dia
  // falhou mas a de clima não) — filtra antes de qualquer conta, senão
  // Math.min/max trata null como 0 e o gráfico mente.
  const pontosVazao = Array.isArray(e.previsao) ? e.previsao.filter((p) => p.vazaoM3s !== null) : [];
  const temPrevisao = pontosVazao.length >= 2;
  let previsao;
  if (temPrevisao) {
    const vazoes = pontosVazao.map((p) => p.vazaoM3s);
    const min = Math.min(...vazoes);
    const max = Math.max(...vazoes);
    previsao = `<p class="prev-titulo">Vazão prevista (7 dias)</p>
      <div class="spark-wrap"><canvas id="prev-${e.slug}"></canvas></div>
      <div class="spark-legenda">${min.toFixed(1)}–${max.toFixed(1)} m³/s (modelo, não é nível)</div>`;
  } else {
    previsao = `<p class="prev-titulo">Vazão prevista (7 dias)</p>
      <div class="spark-wrap vazio">Sem previsão disponível</div>`;
  }

  let clima = '';
  if (e.climaHoje) {
    const c = e.climaHoje;
    const chuva = c.chuvaMm === null ? '—' : c.chuvaMm.toFixed(1) + 'mm';
    clima = `<div class="clima">${condicaoTexto(c.condicaoCodigo)} · ${Math.round(c.tempMax)}°/${Math.round(c.tempMin)}°C · ${chuva} chuva hoje</div>`;
  }

  // Chuva MEDIDA na própria estação (API oficial da ANA) — de propósito uma
  // linha separada da previsão do Open-Meteo acima, nunca misturadas na
  // mesma frase (uma é modelo, a outra é medição real).
  let chuvaMedida = '';
  if (e.chuvaMedidaAnaMm !== null && e.chuvaMedidaAnaMm !== undefined) {
    chuvaMedida = `<div class="chuva-medida" title="Chuva acumulada medida na própria estação, via API oficial da ANA — diferente da previsão do Open-Meteo acima.">💧 ${e.chuvaMedidaAnaMm.toFixed(1)}mm medidos na estação (ANA)</div>`;
  }

  const corFrescor = CORES[FRESCOR_PARA_COR[e.frescor?.status] || 'sem_dado'];
  const tituloFrescor = FRESCOR_TITULO[e.frescor?.status] || '';

  // Badge de confiabilidade/frescor da fonte ANA (cross-check), separado do
  // frescor principal (nivelguaiba) acima — mesma linguagem visual
  // (bolinha verde/amarela/vermelha), só informativo: não substitui nem
  // alimenta o cálculo desta estação. Ausente (não vazio) pras 2 estações
  // sem código ANA mapeado ou sem coleta ANA ainda.
  let metaAna = '';
  if (e.frescorAna) {
    const corAna = CORES[FRESCOR_PARA_COR[e.frescorAna.status] || 'sem_dado'];
    const tituloAna = FRESCOR_TITULO[e.frescorAna.status] || '';
    const idadeTexto = formatarIdade(e.frescorAna.idadeSegundos * 1000);
    metaAna = ` · <span class="frescor" style="background:${corAna}" title="${tituloAna}"></span>ANA: há ${idadeTexto}`;
  }

  // Entrada escalonada só no primeiro carregamento da página (ver render())
  // — não no refresh automático nem ao limpar o filtro de busca, senão os
  // cards ficariam "piscando" toda hora em vez de só na primeira vez.
  const classeEntrada = comAnimacao ? ' entrada' : '';
  const estiloEntrada = comAnimacao ? ` style="--atraso:${Math.min(indice * 25, 300)}ms"` : '';

  return `<div class="card ${e.status}${classeEntrada}" data-slug="${e.slug}"${estiloEntrada}>
    <div class="topo">
      <div>
        <div class="cidade">${e.cidade}/${e.uf}</div>
        <div class="rio">${e.rio}</div>
      </div>
      <div class="topo-acoes">
        <span class="tag ${e.status}">${ROTULOS[e.status]}</span>
        <button type="button" class="btn-compartilhar" data-compartilhar="${e.slug}" title="Compartilhar">📤</button>
      </div>
    </div>
    ${clima}
    ${chuvaMedida}
    <p class="nivel">${nivel}<small> m</small></p>
    ${vel}
    ${etaHtml}
    ${spark}
    <div class="barra" title="${pct.toFixed(0)}% da cota"><i style="width:${pct}%;background-color:${cor}"></i></div>
    <div class="rodape">
      <span>Cota ${e.cota.toFixed(2)} m${e.nota ? ` <span class="nota-info" title="${e.nota.replace(/"/g, '&quot;')}">ⓘ</span>` : ''}</span>
      <span>${margem}</span>
    </div>
    ${cheia2024Html}
    ${previsao}
    <div class="meta"><span class="frescor" style="background:${corFrescor}" title="${tituloFrescor}"></span>${e.estacao || 'Estação não informada'} · ${hora(e.medidoEm)}${metaAna}</div>
  </div>`;
}

let filtroAtual = '';
// Entrada escalonada dos cards só na primeira carga da página — uma flag de
// módulo em vez de checar "grid está vazio?", senão o efeito reapareceria
// toda vez que o filtro de busca zera a lista e volta a ter resultados.
let primeiraCargaFeita = false;

function render() {
  if (!dados) return;
  const ordem = document.getElementById('ordem').value;
  const lista = [...dados.estacoes];

  if (ordem === 'cidade') lista.sort((a, b) => a.cidade.localeCompare(b.cidade));
  else if (ordem === 'rio') lista.sort((a, b) => a.rio.localeCompare(b.rio) || a.cidade.localeCompare(b.cidade));
  else lista.sort((a, b) => (b.percentualCota ?? -1) - (a.percentualCota ?? -1));

  // KPIs sempre refletem TODAS as estações, mesmo com filtro de busca ativo
  // — o filtro é só pra achar um card na tela, não pra recortar o resumo.
  // aplicarComDestaque() só acende o pulso visual quando o valor realmente
  // muda de um refresh (5 em 5 min) pro outro.
  aplicarComDestaque(document.getElementById('k-alerta'), String(dados.resumo.emAlerta));
  aplicarComDestaque(document.getElementById('k-alagado'), String(dados.resumo.acimaDaCota));
  aplicarComDestaque(document.getElementById('k-subindo'), String(dados.resumo.subindo));

  const poa = dados.estacoes.find(e => e.slug === 'portoalegre');
  aplicarComDestaque(
    document.getElementById('k-poa'),
    poa && poa.nivel !== null ? poa.nivel.toFixed(2) + ' m' : '—'
  );

  const comSubida24h = dados.estacoes.filter((e) => e.variacao24hCm !== null && e.variacao24hCm > 0);
  const maiorSubida = comSubida24h.reduce((maior, e) => (!maior || e.variacao24hCm > maior.variacao24hCm ? e : maior), null);
  aplicarComDestaque(
    document.getElementById('k-subida24h'),
    maiorSubida ? `${maiorSubida.cidade} +${(maiorSubida.variacao24hCm / 100).toFixed(2)} m` : '—'
  );

  document.getElementById('sub').textContent =
    dados.estacoes.length + ' estações · atualizado ' + hora(dados.atualizadoEm);

  const termo = filtroAtual.trim().toLowerCase();
  const listaFiltrada = termo
    ? lista.filter((e) => `${e.cidade} ${e.rio} ${e.uf}`.toLowerCase().includes(termo))
    : lista;

  const comAnimacao = !primeiraCargaFeita;
  const antes = valoresAntesDeRenderizar('#grid', '.card', 'slug', '.nivel');
  document.getElementById('grid').innerHTML = listaFiltrada
    .map((e, i) => card(e, i, comAnimacao))
    .join('');
  if (!comAnimacao) destacarMudancas('#grid', '.card', 'slug', '.nivel', antes);
  primeiraCargaFeita = true;
  document.getElementById('filtroVazio').hidden = listaFiltrada.length > 0;

  desenharSparklines(listaFiltrada);
  desenharPrevisoes(listaFiltrada);
}

document.getElementById('filtroEstacao').addEventListener('input', (ev) => {
  filtroAtual = ev.target.value;
  render();
});

// ---- Mini-gráficos de tendência nos cards ----
let sparklines = new Map();

function desenharSparklines(lista) {
  sparklines.forEach((c) => c.destroy());
  sparklines.clear();

  for (const e of lista) {
    if (!Array.isArray(e.serieRecente) || e.serieRecente.length < 2) continue;
    const canvas = document.getElementById('spark-' + e.slug);
    if (!canvas) continue;

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: e.serieRecente.map(() => ''),
        datasets: [{
          data: e.serieRecente.map((p) => p.nivel),
          borderColor: CORES[e.status],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: { x: { display: false }, y: { display: false } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });
    sparklines.set(e.slug, chart);
  }
}

// ---- Mini-gráficos de previsão de vazão (tracejado, pra não confundir
// com o sparkline sólido de nível medido acima) ----
let previsaoCharts = new Map();

function desenharPrevisoes(lista) {
  previsaoCharts.forEach((c) => c.destroy());
  previsaoCharts.clear();

  for (const e of lista) {
    const pontosVazao = Array.isArray(e.previsao) ? e.previsao.filter((p) => p.vazaoM3s !== null) : [];
    if (pontosVazao.length < 2) continue;
    const canvas = document.getElementById('prev-' + e.slug);
    if (!canvas) continue;

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: pontosVazao.map(() => ''),
        datasets: [{
          data: pontosVazao.map((p) => p.vazaoM3s),
          borderColor: '#8b909c',
          borderDash: [4, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: { x: { display: false }, y: { display: false } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });
    previsaoCharts.set(e.slug, chart);
  }
}

// ---- Histórico de alertas ----
async function carregarAlertas() {
  const el = document.getElementById('listaAlertas');
  try {
    const r = await fetch('/api/alertas');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const resposta = await r.json();

    if (resposta.alertas.length === 0) {
      el.innerHTML = '<div class="alerta-vazio">Nenhum alerta registrado ainda.</div>';
      return;
    }

    el.innerHTML = resposta.alertas.map((a) => {
      if (a.tipo === 'subida') {
        const rapida = a.status === 'subida_rapida';
        const rotulo = rapida ? 'subida rápida' : 'ritmo normalizou';
        const cor = rapida ? CORES.alerta : CORES.normal;
        const cmh = a.velocidadeCmH === null ? '—' : a.velocidadeCmH.toFixed(0);
        return `
      <div class="alerta-item">
        <span>${a.cidade}/${a.uf} —
          <b style="color:${cor}">📈 ${rotulo}</b>
          (${cmh} cm/h, ${a.rio})</span>
        <span class="alerta-hora">${hora(a.criadoEm)}</span>
      </div>
    `;
      }

      if (a.tipo === 'chuva') {
        const alta = a.status === 'chuva_alerta';
        const rotulo = alta ? 'chuva acumulada alta' : 'chuva acumulada normalizou';
        const cor = alta ? CORES.alerta : CORES.normal;
        const mm = a.chuvaMmAcumulada === null ? '—' : a.chuvaMmAcumulada.toFixed(0);
        return `
      <div class="alerta-item">
        <span>${a.cidade}/${a.uf} —
          <b style="color:${cor}">🌧️ ${rotulo}</b>
          (${mm}mm, ${a.rio})</span>
        <span class="alerta-hora">${hora(a.criadoEm)}</span>
      </div>
    `;
      }
      return `
      <div class="alerta-item">
        <span>${a.cidade}/${a.uf} entrou em
          <b style="color:${CORES[a.status]}">${ROTULOS[a.status]}</b>
          (${a.nivel.toFixed(2)} m, ${a.rio})</span>
        <span class="alerta-hora">${hora(a.criadoEm)}</span>
      </div>
    `;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="alerta-vazio">Não foi possível carregar os alertas.</div>';
  }
}

document.getElementById('ordem').addEventListener('change', render);
document.getElementById('atualizar').addEventListener('click', carregar);
carregar();
carregarAlertas();
setInterval(carregar, 5 * 60 * 1000);
setInterval(carregarAlertas, 5 * 60 * 1000);

// ---- Gráfico de histórico (modal) ----
let chartInstancia = null;
let slugAtual = null;
let janelaAtual = 24;
let pontosAtuais = [];

function abrirHistorico(slug) {
  const estacao = dados && dados.estacoes.find((e) => e.slug === slug);
  if (!estacao) return;

  slugAtual = slug;
  document.getElementById('modalCidade').textContent = estacao.cidade + '/' + estacao.uf;
  document.getElementById('modalRio').textContent = estacao.rio;
  const notaEl = document.getElementById('modalNota');
  notaEl.hidden = !estacao.nota;
  notaEl.textContent = estacao.nota ? 'ⓘ ' + estacao.nota : '';
  document.getElementById('modalOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  alternarAba('nivel');
  selecionarJanela(24);
  renderizarTendenciaVazao(slug);
  renderizarPrevisaoClima(slug);
  renderizarEstimativaCota(slug);
}

// "Quanto falta pra cota, no ritmo atual" — extrapolação linear simples da
// tendência MEDIDA agora (cm/h), não do modelo de vazão de dias. Só faz
// sentido pra horizonte curto (rio não sobe num ritmo constante por dias),
// por isso o texto deixa claro que é estimativa, não previsão.
function formatarHorasEstimativa(horas) {
  if (horas < 48) return Math.round(horas) + 'h';
  return (horas / 24).toFixed(1) + ' dias';
}

function renderizarEstimativaCota(slug) {
  const el = document.getElementById('estimativaCota');
  el.className = 'estimativa-cota';
  el.textContent = '';

  const estacao = dados && dados.estacoes.find((e) => e.slug === slug);
  if (!estacao) return;

  const eta = calcularEtaCota(estacao);
  if (!eta) return;

  el.classList.add(eta.classe);
  const acao = eta.classe === 'subindo' ? 'atinge a cota' : 'volta ao normal';
  el.textContent =
    `⏱ No ritmo atual (${Math.abs(eta.velocidadeCmH).toFixed(1)} cm/h), ${acao} em ~${formatarHorasEstimativa(eta.horas)} ` +
    `— estimativa simples da tendência agora, não é previsão.`;
}

// Tendência de VAZÃO prevista, dia a dia — não é nível em metros (mesma
// limitação de sempre: converter exigiria a curva-chave de cada estação,
// que não temos). A seta compara cada dia com o dia anterior da própria
// previsão; o primeiro dia não tem "anterior" dentro da previsão, então
// fica neutro em vez de fingir uma tendência.
function renderizarTendenciaVazao(slug) {
  const el = document.getElementById('prevTendencia');
  const estacao = dados && dados.estacoes.find((e) => e.slug === slug);
  const pontos = estacao && Array.isArray(estacao.previsao)
    ? estacao.previsao.filter((p) => p.vazaoM3s !== null)
    : [];

  if (pontos.length === 0) {
    el.innerHTML = '<p class="prev-tendencia-vazio">Sem previsão de vazão disponível pra essa estação.</p>';
    return;
  }

  const dias = pontos.map((p, i) => {
    let seta = '•', classe = 'primeiro';
    if (i > 0) {
      const anterior = pontos[i - 1].vazaoM3s;
      const variacao = anterior === 0 ? 0 : (p.vazaoM3s - anterior) / anterior;
      if (variacao > 0.05) { seta = '▲'; classe = 'subindo'; }
      else if (variacao < -0.05) { seta = '▼'; classe = 'descendo'; }
      else { seta = '→'; classe = 'estavel'; }
    }

    // p.dia pode vir como "2026-07-23" (data simples) ou como timestamp
    // completo "2026-07-23T00:00:00.000Z" (depende de como o driver do
    // Neon serializa a coluna DATE) — normaliza pros 10 primeiros
    // caracteres antes de montar a data, senão concatenar direto vira
    // "...ZT12:00:00", que o Date() não entende (virava "Invalid Date").
    const diaSimples = String(p.dia).slice(0, 10);
    const dataFmt = new Date(diaSimples + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });
    const chuva = p.chuvaMm === null || p.chuvaMm === undefined ? '—' : p.chuvaMm.toFixed(1) + 'mm';

    // Nível estimado pela curva empírica da estação (ver lib/curva.js).
    // Só aparece quando existe: a maioria das estações não vai ter curva
    // confiável no começo, e é assim que tem que ser.
    const estimado = p.nivelEstimadoM === null || p.nivelEstimadoM === undefined
      ? ''
      : `<span class="prev-dia-nivel">≈ ${p.nivelEstimadoM.toFixed(2)} m</span>`;

    return `<div class="prev-dia">
      <span class="prev-dia-data">${dataFmt}</span>
      <span class="prev-dia-seta ${classe}">${seta}</span>
      <span class="prev-dia-valor">${p.vazaoM3s.toFixed(1)} m³/s</span>
      ${estimado}
      <span class="prev-dia-chuva">💧 ${chuva}</span>
    </div>`;
  }).join('');

  // O rodapé da curva só aparece quando algum dia tem estimativa — e sempre
  // com n, R² e erro médio junto. Mostrar "≈ 12,40 m" sem dizer que a curva
  // erra ±0,45 m em média convidaria a confiar mais do que o número aguenta.
  const c = estacao.curvaNivel;
  const temEstimativa = pontos.some((p) => p.nivelEstimadoM !== null && p.nivelEstimadoM !== undefined);
  const rodapeCurva = !temEstimativa || !c ? '' : `
    <p class="prev-curva-nota">
      <b>≈ m é experimental.</b> Nível estimado a partir da vazão do modelo por uma
      curva ajustada com o histórico desta estação — <b>não</b> é curva-chave oficial.
      Ajuste: ${c.n} dias pareados, R² ${c.r2 === null ? '—' : c.r2.toFixed(2)},
      erro médio ${c.erroMedioM === null ? '—' : '±' + c.erroMedioM.toFixed(2) + ' m'}.
      Dias sem "≈ m" são aqueles em que a vazão prevista caiu fora da faixa em que a
      curva foi ajustada — extrapolar ali erraria feio.
    </p>`;

  el.innerHTML = `
    <p class="prev-tendencia-titulo">Tendência de vazão prevista — modelo (Open-Meteo/GloFAS), não é nível em metros</p>
    <div class="prev-dias">${dias}</div>
    ${rodapeCurva}
  `;
}

// Card de previsão do tempo (7 dias) — ícone, temp máx/mín, chuva prevista
// e chance de chuva, tudo via Open-Meteo (mesma fonte de renderizarTendenciaVazao
// acima, é o mesmo array estacao.previsao, só que aqui o foco é clima em vez
// de vazão).
function renderizarPrevisaoClima(slug) {
  const el = document.getElementById('prevClima');
  const estacao = dados && dados.estacoes.find((e) => e.slug === slug);
  const pontos = estacao && Array.isArray(estacao.previsao)
    ? estacao.previsao.filter((p) => p.tempMax !== null)
    : [];

  if (pontos.length === 0) {
    el.innerHTML = '<p class="prev-tendencia-vazio">Sem previsão do tempo disponível pra essa estação.</p>';
    return;
  }

  const dias = pontos.map((p) => {
    const diaSimples = String(p.dia).slice(0, 10);
    const dataFmt = new Date(diaSimples + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });
    const chuva = p.chuvaMm === null || p.chuvaMm === undefined ? '—' : p.chuvaMm.toFixed(1) + 'mm';
    const chance = p.chanceChuvaPct === null || p.chanceChuvaPct === undefined
      ? ''
      : `<span class="prev-clima-dia-chance">${p.chanceChuvaPct}%</span>`;

    return `<div class="prev-clima-dia">
      <span class="prev-clima-dia-data">${dataFmt}</span>
      <span class="prev-clima-dia-icone" title="${condicaoTexto(p.condicaoCodigo)}">${condicaoEmoji(p.condicaoCodigo)}</span>
      <span class="prev-clima-dia-temp">${Math.round(p.tempMax)}° / ${Math.round(p.tempMin)}°</span>
      <span class="prev-clima-dia-chuva">💧 ${chuva}</span>
      ${chance}
    </div>`;
  }).join('');

  el.innerHTML = `
    <p class="prev-tendencia-titulo">Previsão do tempo (7 dias) — Open-Meteo</p>
    <div class="prev-clima-dias">${dias}</div>
  `;
}

function alternarAba(nome) {
  const nivel = nome === 'nivel';
  document.getElementById('abaNivelBtn').classList.toggle('ativo', nivel);
  document.getElementById('abaNivelBtn').setAttribute('aria-selected', String(nivel));
  document.getElementById('abaPrevisaoBtn').classList.toggle('ativo', !nivel);
  document.getElementById('abaPrevisaoBtn').setAttribute('aria-selected', String(!nivel));
  document.getElementById('abaNivel').hidden = !nivel;
  document.getElementById('abaPrevisao').hidden = nivel;
}
document.getElementById('abaNivelBtn').addEventListener('click', () => alternarAba('nivel'));
document.getElementById('abaPrevisaoBtn').addEventListener('click', () => alternarAba('previsao'));

function fecharHistorico() {
  document.getElementById('modalOverlay').hidden = true;
  document.body.style.overflow = '';
  if (chartInstancia) {
    chartInstancia.destroy();
    chartInstancia = null;
  }
  slugAtual = null;
  pontosAtuais = [];
  document.getElementById('exportarCsv').disabled = true;
  document.getElementById('prevTendencia').innerHTML = '';
  document.getElementById('estimativaCota').textContent = '';
  document.getElementById('estimativaCota').className = 'estimativa-cota';
  document.getElementById('modalNota').hidden = true;
  document.getElementById('modalNota').textContent = '';
  document.getElementById('modalChuvaLegenda').hidden = true;
  document.getElementById('modalResolucao').hidden = true;
  document.getElementById('prevClima').innerHTML = '';
  alternarAba('nivel');
}

function selecionarJanela(horas) {
  janelaAtual = horas;
  document.querySelectorAll('.janela-btn').forEach((b) => {
    b.classList.toggle('ativo', Number(b.dataset.horas) === horas);
  });
  carregarHistorico();
}

async function carregarHistorico() {
  if (!slugAtual) return;
  const canvas = document.getElementById('graficoHistorico');
  const vazio = document.getElementById('modalVazio');
  canvas.hidden = false;
  vazio.hidden = true;

  try {
    const r = await fetch(`/api/historico?slug=${encodeURIComponent(slugAtual)}&horas=${janelaAtual}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const resposta = await r.json();
    desenharGrafico(resposta);
  } catch (e) {
    if (chartInstancia) {
      chartInstancia.destroy();
      chartInstancia = null;
    }
    pontosAtuais = [];
    document.getElementById('exportarCsv').disabled = true;
    canvas.hidden = true;
    vazio.hidden = false;
    vazio.textContent = 'Não foi possível carregar o histórico: ' + e.message;
  }
}

// pontos e chuvaAna já vêm ordenados ascendente por medidoEm (garantido
// pelas duas queries em api/historico.js) — permite um único passe
// two-pointer O(n+m) em vez de buscar o mais próximo pra cada leitura de
// chuva (O(n·m)), relevante na janela de 30 dias. "Encaixa" cada leitura
// de chuva no label de nível mais próximo; sem corte de tolerância (é uma
// barra de contexto, não uma correlação precisa) — se isso incomodar numa
// janela com buraco grande de dados, adicionar um limite de distância
// máxima aqui. Em colisão (mais de uma leitura de chuva pro mesmo label),
// a mais recente vence, já que chuva_mm é plotado bruto (valor "atual"
// daquele instante é o mais representativo).
function alinharChuvaAosLabels(pontos, chuvaAna) {
  const porLabel = new Array(pontos.length).fill(null);
  if (!chuvaAna || chuvaAna.length === 0 || pontos.length === 0) return porLabel;

  let i = 0;
  for (const c of chuvaAna) {
    const alvo = new Date(c.medidoEm).getTime();
    while (
      i < pontos.length - 1 &&
      Math.abs(new Date(pontos[i + 1].medidoEm).getTime() - alvo) <=
        Math.abs(new Date(pontos[i].medidoEm).getTime() - alvo)
    ) {
      i++;
    }
    porLabel[i] = c.chuvaMm;
  }
  return porLabel;
}

function desenharGrafico(resposta) {
  const canvas = document.getElementById('graficoHistorico');
  const vazio = document.getElementById('modalVazio');
  const pontos = resposta.pontos;

  pontosAtuais = pontos;
  document.getElementById('exportarCsv').disabled = pontos.length === 0;

  if (chartInstancia) {
    chartInstancia.destroy();
    chartInstancia = null;
  }

  // Uma linha com 0 ou 1 ponto não forma série — mostra mensagem em vez de gráfico vazio.
  if (pontos.length < 2) {
    canvas.hidden = true;
    vazio.hidden = false;
    vazio.textContent = pontos.length === 0
      ? 'Nenhuma leitura registrada nessa janela.'
      : 'Apenas uma leitura registrada nessa janela — sem dados suficientes para o gráfico.';
    document.getElementById('modalChuvaLegenda').hidden = true;
    return;
  }

  canvas.hidden = false;
  vazio.hidden = true;

  const estacaoPainel = dados.estacoes.find((e) => e.slug === slugAtual);
  const cor = CORES[estacaoPainel ? estacaoPainel.status : 'sem_dado'];
  const cota = resposta.estacao.cota;

  const datasets = [
    {
      label: resposta.estacao.cidade,
      data: pontos.map((p) => p.nivel),
      borderColor: cor,
      backgroundColor: cor,
      pointRadius: 2,
      pointHoverRadius: 4,
      borderWidth: 2,
      tension: 0.25,
      fill: false,
    },
    {
      label: 'Cota de inundação (' + cota.toFixed(2) + ' m)',
      data: pontos.map(() => cota),
      borderColor: '#8b909c',
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    },
  ];

  // Maior nível já registrado (toda a história, não só a janela atual) —
  // dá noção de "isso está perto do pior que já aconteceu?". Vem da nossa
  // própria tabela leituras, que só existe desde que a coleta começou —
  // por isso é um dado diferente (e normalmente bem menor) do que a linha
  // da cheia de 2024 abaixo, que vem de antes da coleta existir.
  if (resposta.recorde) {
    datasets.push({
      label: 'Recorde histórico (' + resposta.recorde.nivel.toFixed(2) + ' m)',
      data: pontos.map(() => resposta.recorde.nivel),
      borderColor: '#7a3fa0',
      borderDash: [2, 3],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    });
  }

  // Pico da cheia de maio/2024 — só existe pras estações com registro
  // confiável (ver nota em schema.sql); nas demais fica null e a linha
  // simplesmente não aparece.
  if (resposta.cheia2024) {
    datasets.push({
      label: 'Cheia de maio/2024 (' + resposta.cheia2024.nivel.toFixed(2) + ' m)',
      data: pontos.map(() => resposta.cheia2024.nivel),
      borderColor: '#1f9e8f',
      borderDash: [8, 3],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    });
  }

  // Chuva medida (ANA) — só nas 12 estações mapeadas e só quando há dado
  // na janela; nas outras, resposta.chuvaAna vem [] e o gráfico fica
  // idêntico ao de hoje (sem eixo direito).
  const temChuva = Array.isArray(resposta.chuvaAna) && resposta.chuvaAna.length > 0;
  const legendaChuva = document.getElementById('modalChuvaLegenda');
  legendaChuva.hidden = !temChuva;
  if (temChuva) {
    datasets.push({
      type: 'bar',
      label: 'Chuva medida (ANA)',
      data: alinharChuvaAosLabels(pontos, resposta.chuvaAna),
      yAxisID: 'yChuva',
      backgroundColor: 'rgba(47,123,196,0.35)',
      borderWidth: 0,
      order: 2,
    });
  }

  chartInstancia = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: pontos.map((p) => hora(p.medidoEm)),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: { autoSkip: true, maxRotation: 0, color: '#5f6470' },
          grid: { display: false },
        },
        y: {
          ticks: { color: '#5f6470', callback: (v) => Number(v).toFixed(2) },
          title: { display: true, text: 'Metros' },
        },
        ...(temChuva ? {
          yChuva: {
            position: 'right',
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            ticks: { color: '#5f6470', callback: (v) => Number(v).toFixed(0) },
            title: { display: true, text: 'Chuva (mm)' },
          },
        } : {}),
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => new Date(pontos[items[0].dataIndex].medidoEm).toLocaleString('pt-BR'),
            label: (ctx) => ctx.dataset.yAxisID === 'yChuva'
              ? ctx.dataset.label + ': ' + (ctx.parsed.y === null ? '—' : ctx.parsed.y.toFixed(1) + ' mm')
              : ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + ' m',
          },
        },
      },
    },
  });
}

document.getElementById('grid').addEventListener('click', (ev) => {
  const btnCompartilhar = ev.target.closest('[data-compartilhar]');
  if (btnCompartilhar) {
    ev.stopPropagation();
    compartilharEstacao(btnCompartilhar.dataset.compartilhar, btnCompartilhar);
    return;
  }
  const card = ev.target.closest('.card');
  if (card && card.dataset.slug) abrirHistorico(card.dataset.slug);
});
document.getElementById('modalFechar').addEventListener('click', fecharHistorico);
document.getElementById('modalOverlay').addEventListener('click', (ev) => {
  if (ev.target.id === 'modalOverlay') fecharHistorico();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !document.getElementById('modalOverlay').hidden) fecharHistorico();
});
document.querySelectorAll('.janela-btn').forEach((b) => {
  b.addEventListener('click', () => selecionarJanela(Number(b.dataset.horas)));
});

// ---- Compartilhar (Web Share API, com fallback pra copiar) ----
// Sem servidor mandando nada — só monta um texto e entrega pro próprio
// navegador/SO decidir o canal (WhatsApp, SMS, e-mail...), ou copia pra
// área de transferência em navegadores sem suporte (comum em desktop).
function gerarResumoCompartilhamento(e) {
  const nivel = e.nivel === null ? '—' : e.nivel.toFixed(2) + ' m';

  let vel = '';
  if (e.velocidadeCmH !== null) {
    const seta = e.velocidadeCmH > 0 ? '▲' : e.velocidadeCmH < 0 ? '▼' : '■';
    vel = ` (${seta} ${Math.abs(e.velocidadeCmH).toFixed(1)} cm/h)`;
  }

  const margem = e.margem === null ? ''
    : e.margem >= 0 ? `${e.margem.toFixed(2)} m abaixo da cota (${e.cota.toFixed(2)} m)`
    : `${Math.abs(e.margem).toFixed(2)} m ACIMA da cota (${e.cota.toFixed(2)} m)`;

  const status = ROTULOS[e.status] || '';
  const link = window.location.origin + window.location.pathname;

  return `🌊 ${e.cidade}/${e.uf} — ${e.rio}\n` +
    `Nível: ${nivel}${vel}\n` +
    `${margem}${margem ? ' — ' : ''}${status}\n` +
    `Atualizado: ${hora(e.medidoEm)}\n` +
    `${link}\n` +
    `Fonte: nivelguaiba.com.br — não é sistema oficial de alerta.`;
}

function mostrarFeedbackBotao(botao, textoTemporario) {
  if (!botao) return;
  const original = botao.textContent;
  botao.disabled = true;
  botao.textContent = textoTemporario;
  setTimeout(() => {
    botao.textContent = original;
    botao.disabled = false;
  }, 1800);
}

async function compartilharEstacao(slug, botao) {
  const e = dados && dados.estacoes.find((x) => x.slug === slug);
  if (!e) return;

  const texto = gerarResumoCompartilhamento(e);

  if (navigator.share) {
    try {
      await navigator.share({ title: `Nível do rio — ${e.cidade}/${e.uf}`, text: texto });
    } catch (erro) {
      // AbortError = usuário cancelou o menu nativo, não é uma falha real.
      if (erro && erro.name !== 'AbortError') console.error('Falha ao compartilhar:', erro);
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(texto);
    mostrarFeedbackBotao(botao, botao && botao.textContent.length <= 2 ? '✓' : '✓ Copiado!');
  } catch (erro) {
    window.prompt('Não foi possível copiar automaticamente — copie o texto abaixo:', texto);
  }
}

document.getElementById('modalCompartilhar').addEventListener('click', (ev) => {
  if (slugAtual) compartilharEstacao(slugAtual, ev.currentTarget);
});

function exportarCsv() {
  if (!pontosAtuais || pontosAtuais.length === 0) return;

  const estacao = dados && dados.estacoes.find((e) => e.slug === slugAtual);
  const nomeArquivo = `historico-${slugAtual}-${janelaAtual}h.csv`;

  const linhas = ['medido_em,nivel_m'];
  for (const p of pontosAtuais) {
    linhas.push(`${p.medidoEm},${p.nivel}`);
  }
  const csv = linhas.join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById('exportarCsv').addEventListener('click', exportarCsv);

// ---- Comparar múltiplas estações no mesmo gráfico ----
// Timestamps de estações diferentes não batem entre si (cada uma mede em
// horários levemente distintos), então o eixo X usa escala 'linear' com
// epoch em ms em vez de categorias/labels — assim cada linha respeita seu
// próprio horário real, sem precisar de um adapter de datas extra pro
// Chart.js. O modo "% da cota" existe porque comparar metros brutos entre
// rios diferentes engana: 6m no Jacuí não é a mesma situação que 6m no
// Guaíba — cada estação tem sua própria cota de inundação.
const PALETA_COMPARAR = [
  '#e24b4a', '#2f7bc4', '#639922', '#ba7517', '#7a3fa0', '#1f9e8f', '#c25b9e',
  '#5a6b8c', '#c48a2f', '#3b8f5f', '#a35d3b', '#4a5fd6', '#8b8f2f', '#c2564b',
];
let selecaoComparar = new Set(JSON.parse(localStorage.getItem('compararSelecao') || '[]'));
let janelaComparar = 24;
let modoComparar = 'nivel';
let chartComparar = null;
let respostasComparar = new Map(); // slug -> resposta de /api/historico

function abrirComparar() {
  if (!dados) return;
  document.getElementById('modalCompararOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  renderizarListaComparar();
  document.querySelectorAll('.comparar-janela-btn').forEach((b) => {
    b.classList.toggle('ativo', Number(b.dataset.horas) === janelaComparar);
  });
  carregarComparar();
}

function fecharComparar() {
  document.getElementById('modalCompararOverlay').hidden = true;
  document.body.style.overflow = '';
  if (chartComparar) {
    chartComparar.destroy();
    chartComparar = null;
  }
}

function renderizarListaComparar() {
  const el = document.getElementById('compararLista');
  el.innerHTML = dados.estacoes.map((e) => `
    <label class="comparar-item">
      <input type="checkbox" value="${e.slug}" ${selecaoComparar.has(e.slug) ? 'checked' : ''}>
      ${e.cidade}/${e.uf}
    </label>
  `).join('');
  el.querySelectorAll('input[type=checkbox]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selecaoComparar.add(input.value);
      else selecaoComparar.delete(input.value);
      localStorage.setItem('compararSelecao', JSON.stringify([...selecaoComparar]));
      carregarComparar();
    });
  });
}

function selecionarJanelaComparar(horas) {
  janelaComparar = horas;
  document.querySelectorAll('.comparar-janela-btn').forEach((b) => {
    b.classList.toggle('ativo', Number(b.dataset.horas) === horas);
  });
  carregarComparar();
}

// Contador de geração: se o usuário marcar/desmarcar checkboxes rápido,
// uma chamada antiga pode responder depois de uma mais nova — só aplica
// o resultado se ninguém chamou carregarComparar() de novo nesse meio-tempo.
let comparaChamadaId = 0;

async function carregarComparar() {
  const idChamada = ++comparaChamadaId;
  const canvas = document.getElementById('graficoComparar');
  const vazio = document.getElementById('compararVazio');
  const slugs = [...selecaoComparar];

  if (slugs.length === 0) {
    respostasComparar.clear();
    if (chartComparar) { chartComparar.destroy(); chartComparar = null; }
    canvas.hidden = true;
    vazio.hidden = false;
    vazio.textContent = 'Selecione ao menos uma estação acima.';
    document.getElementById('compararExportarCsv').disabled = true;
    return;
  }

  try {
    const respostas = await Promise.all(slugs.map((slug) =>
      fetch(`/api/historico?slug=${encodeURIComponent(slug)}&horas=${janelaComparar}`)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    ));
    if (idChamada !== comparaChamadaId) return;
    respostasComparar.clear();
    respostas.forEach((resp) => respostasComparar.set(resp.estacao.slug, resp));
    desenharGraficoComparar();
  } catch (e) {
    if (idChamada !== comparaChamadaId) return;
    if (chartComparar) { chartComparar.destroy(); chartComparar = null; }
    canvas.hidden = true;
    vazio.hidden = false;
    vazio.textContent = 'Não foi possível carregar o histórico: ' + e.message;
    document.getElementById('compararExportarCsv').disabled = true;
  }
}

function desenharGraficoComparar() {
  const canvas = document.getElementById('graficoComparar');
  const vazio = document.getElementById('compararVazio');

  if (chartComparar) {
    chartComparar.destroy();
    chartComparar = null;
  }

  const entradas = [...respostasComparar.values()].filter((r) => r.pontos.length >= 2);
  if (entradas.length === 0) {
    canvas.hidden = true;
    vazio.hidden = false;
    vazio.textContent = 'Nenhuma das estações selecionadas tem leituras suficientes nessa janela.';
    document.getElementById('compararExportarCsv').disabled = true;
    return;
  }

  canvas.hidden = false;
  vazio.hidden = true;
  document.getElementById('compararExportarCsv').disabled = false;

  const datasets = entradas.map((resp, i) => {
    const cor = PALETA_COMPARAR[i % PALETA_COMPARAR.length];
    const painelInfo = dados.estacoes.find((e) => e.slug === resp.estacao.slug);
    const label = painelInfo ? `${resp.estacao.cidade}/${painelInfo.uf}` : resp.estacao.cidade;
    return {
      label,
      data: resp.pontos.map((p) => ({
        x: new Date(p.medidoEm).getTime(),
        y: modoComparar === 'percentual' ? (p.nivel / resp.estacao.cota) * 100 : p.nivel,
      })),
      borderColor: cor,
      backgroundColor: cor,
      pointRadius: 0,
      borderWidth: 1.75,
      tension: 0.2,
      fill: false,
    };
  });

  chartComparar = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            color: '#5f6470',
            callback: (v) => hora(new Date(v).toISOString()),
            maxRotation: 0,
            autoSkip: true,
          },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: '#5f6470',
            callback: (v) => modoComparar === 'percentual' ? Number(v).toFixed(0) + '%' : Number(v).toFixed(2),
          },
          title: { display: true, text: modoComparar === 'percentual' ? '% da cota de inundação' : 'Metros' },
        },
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleString('pt-BR'),
            label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + (modoComparar === 'percentual' ? '%' : ' m'),
          },
        },
      },
    },
  });
}

function exportarCsvComparar() {
  if (respostasComparar.size === 0) return;

  const linhas = ['estacao,uf,rio,medido_em,nivel_m,percentual_cota'];
  for (const resp of respostasComparar.values()) {
    const painelInfo = dados.estacoes.find((e) => e.slug === resp.estacao.slug);
    const uf = painelInfo ? painelInfo.uf : '';
    for (const p of resp.pontos) {
      const pct = ((p.nivel / resp.estacao.cota) * 100).toFixed(1);
      linhas.push(`${resp.estacao.cidade},${uf},${resp.estacao.rio},${p.medidoEm},${p.nivel},${pct}`);
    }
  }
  const csv = linhas.join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `comparar-estacoes-${janelaComparar}h.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById('compararToggle').addEventListener('click', abrirComparar);
document.getElementById('modalCompararFechar').addEventListener('click', fecharComparar);
document.getElementById('modalCompararOverlay').addEventListener('click', (ev) => {
  if (ev.target.id === 'modalCompararOverlay') fecharComparar();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !document.getElementById('modalCompararOverlay').hidden) fecharComparar();
});
document.querySelectorAll('.comparar-janela-btn').forEach((b) => {
  b.addEventListener('click', () => selecionarJanelaComparar(Number(b.dataset.horas)));
});
document.getElementById('compararModo').addEventListener('change', (ev) => {
  modoComparar = ev.target.value;
  desenharGraficoComparar();
});
document.getElementById('compararExportarCsv').addEventListener('click', exportarCsvComparar);

// ---- Modal de ajuda (só conteúdo estático, sem fetch) ----
function abrirAjuda() {
  document.getElementById('modalAjudaOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
}
function fecharAjuda() {
  document.getElementById('modalAjudaOverlay').hidden = true;
  document.body.style.overflow = '';
}
document.getElementById('ajudaToggle').addEventListener('click', abrirAjuda);
document.getElementById('modalAjudaFechar').addEventListener('click', fecharAjuda);
document.getElementById('modalAjudaOverlay').addEventListener('click', (ev) => {
  if (ev.target.id === 'modalAjudaOverlay') fecharAjuda();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !document.getElementById('modalAjudaOverlay').hidden) fecharAjuda();
});

// ---- Menu lateral de ações (celular) ----
// A barra de ações (ordenar, atualizar, mapa, PDF, comparar, ajuda...) não
// cabe numa linha só em telas pequenas — no desktop continua uma barra
// normal (ver painel.css), no celular vira uma gaveta lateral aberta pelo
// ☰. Fecha ao clicar fora, no ✕, em Esc, ou em qualquer botão de ação lá
// dentro (a própria ação — abrir modal, navegar, etc. — já dá o feedback).
const menuToggle = document.getElementById('menuToggle');
const menuFechar = document.getElementById('menuFechar');
const acoesEl = document.getElementById('acoes');
const menuOverlay = document.getElementById('menuOverlay');

function menuAberto() {
  return acoesEl.classList.contains('aberto');
}

function abrirMenu() {
  menuOverlay.hidden = false;
  requestAnimationFrame(() => {
    acoesEl.classList.add('aberto');
    menuOverlay.classList.add('aberto');
  });
  menuToggle.setAttribute('aria-expanded', 'true');
}

function fecharMenu() {
  acoesEl.classList.remove('aberto');
  menuOverlay.classList.remove('aberto');
  menuToggle.setAttribute('aria-expanded', 'false');
  setTimeout(() => { if (!menuAberto()) menuOverlay.hidden = true; }, 250);
}

menuToggle.addEventListener('click', () => (menuAberto() ? fecharMenu() : abrirMenu()));
menuFechar.addEventListener('click', fecharMenu);
menuOverlay.addEventListener('click', fecharMenu);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && menuAberto()) fecharMenu();
});
acoesEl.addEventListener('click', (ev) => {
  if (ev.target.closest('button') && ev.target.id !== 'menuFechar') fecharMenu();
});

// ---- Intro (logo + nome, ~1.4s) ----
// Clicar/tocar em qualquer lugar pula direto pro painel, pra quem já
// conhece o app e não quer esperar a animação toda vez que abre.
document.getElementById('intro').addEventListener('click', () => {
  document.getElementById('intro').style.display = 'none';
});

// Lógica exclusiva da página de confiança nas fontes (fontes.html).
// Depende de js/tema.js e js/comum.js (hora, mostrarAviso), carregados antes.

// Limiares do veredito de divergência, em metros. Não são físicos nem
// oficiais — são réguas de leitura pra transformar dois números num rótulo
// que dá pra ler de relance. Deixados aqui em cima justamente pra ficar
// óbvio que são escolha nossa, ajustável, e não algo vindo do dado.
const DIF_IRRELEVANTE_M = 0.05;  // 5 cm: dentro do ruído das duas telemetrias
const OSCILACAO_ACEITAVEL_M = 0.15;
const DERIVA_RELEVANTE_M = 0.10;
const HORAS_MINIMAS = 24;        // menos que isso não sustenta conclusão nenhuma

function vereditoDivergencia(e) {
  if (e.horasPareadas < HORAS_MINIMAS) {
    return { classe: 'poucos', texto: 'dado insuficiente', explica:
      `só ${e.horasPareadas}h pareadas — precisa de pelo menos ${HORAS_MINIMAS}h` };
  }
  if (e.derivaM !== null && Math.abs(e.derivaM) >= DERIVA_RELEVANTE_M) {
    return { classe: 'derivando', texto: 'derivando', explica:
      'a diferença mudou ao longo da janela — alguma coisa mexeu numa das réguas' };
  }
  if (e.dispersaoM !== null && e.dispersaoM > OSCILACAO_ACEITAVEL_M) {
    return { classe: 'oscila', texto: 'oscila', explica:
      'a diferença varia muito — não é offset de régua, é discordância real' };
  }
  if (Math.abs(e.medianaM) <= DIF_IRRELEVANTE_M) {
    return { classe: 'concordam', texto: 'concordam', explica:
      'as duas fontes leem praticamente o mesmo nível' };
  }
  return { classe: 'constante', texto: 'offset estável', explica:
    'diferença grande mas constante — é datum/régua diferente, não erro' };
}

function metros(v, casas = 2) {
  if (v === null || v === undefined) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(casas) + ' m';
}

function pct(taxa) {
  return taxa === null ? '—' : Math.round(taxa * 100) + '%';
}

function duracao(min) {
  if (min === null || min === undefined) return '—';
  if (min < 90) return Math.round(min) + ' min';
  return (min / 60).toFixed(1) + ' h';
}

function renderizarSaude(d) {
  const el = document.getElementById('saude');
  const j = d.janelas['24h'];
  const s = d.janelas['7d'];

  if (j.totalColetas === 0 && s.totalColetas === 0) {
    el.innerHTML = '<p class="vazio">Nenhuma rodada registrada ainda — a tabela <code>coletas</code> começa a encher na próxima coleta.</p>';
    return;
  }

  const cartoes = [
    {
      rotulo: 'Feed de nível · 24h',
      valor: pct(j.feed.taxa),
      detalhe: `${j.feed.ok} de ${j.totalColetas} rodadas · ${j.feed.falhas} falha${j.feed.falhas === 1 ? '' : 's'}`,
      estado: j.feed.taxa !== null && j.feed.taxa < 0.9 ? 'ruim' : '',
    },
    {
      rotulo: 'Feed de nível · 7d',
      valor: pct(s.feed.taxa),
      detalhe: `${s.feed.ok} de ${s.totalColetas} rodadas`,
      estado: s.feed.taxa !== null && s.feed.taxa < 0.9 ? 'atencao' : '',
    },
    {
      rotulo: 'Maior lacuna · 24h',
      valor: duracao(j.maiorLacunaMin),
      detalhe: j.lacunaAnormal
        ? `bem acima dos ${d.intervaloEsperadoMin} min agendados`
        : `esperado: ~${d.intervaloEsperadoMin} min`,
      estado: j.lacunaAnormal ? 'atencao' : '',
    },
  ];

  // A ANA é opcional: sem credencial configurada não existe taxa, e mostrar
  // "0%" ali seria mentira — some o cartão em vez de fingir uma falha.
  if (j.ana) {
    cartoes.push({
      rotulo: 'API da ANA · 24h',
      valor: pct(j.ana.taxa),
      detalhe: `${j.ana.ok} de ${j.ana.ok + j.ana.falhas} rodadas · ${j.leiturasAnaInseridas.toLocaleString('pt-BR')} leituras novas`,
      estado: j.ana.taxa !== null && j.ana.taxa < 0.9 ? 'ruim' : '',
    });
  }

  el.innerHTML = cartoes.map((c) => `
    <div class="cartao ${c.estado}">
      <span>${c.rotulo}</span>
      <strong>${c.valor}</strong>
      <small>${c.detalhe}</small>
    </div>
  `).join('');

  const nota = document.getElementById('saudeNota');
  const partes = [];
  if (d.ultimaColeta) {
    partes.push(`Última rodada: ${hora(d.ultimaColeta.iniciadaEm)}` +
      (d.ultimaColeta.duracaoMs ? ` (${(d.ultimaColeta.duracaoMs / 1000).toFixed(1)}s)` : ''));
  }
  if (d.ultimaFalhaFeed) {
    partes.push(`Última falha do feed: ${hora(d.ultimaFalhaFeed.iniciadaEm)} — ${d.ultimaFalhaFeed.erro || 'sem detalhe'}`);
  } else {
    partes.push('Nenhuma falha do feed registrada.');
  }
  nota.textContent = partes.join(' · ');
  nota.hidden = false;
}

function renderizarDivergencia(d) {
  document.getElementById('janelaDias').textContent = d.janelaDias;

  const corpo = document.getElementById('corpoDivergencia');
  if (d.estacoes.length === 0) {
    corpo.innerHTML = '<tr><td colspan="6" class="vazio">Ainda não há horas em que as duas fontes tenham leitura pra comparar. Isso aparece depois que a coleta com credencial da ANA rodar por algumas horas.</td></tr>';
  } else {
    corpo.innerHTML = d.estacoes.map((e) => {
      const v = vereditoDivergencia(e);
      return `<tr>
        <td>${e.cidade}/${e.uf}<br><small style="color:var(--txt3)">${e.rio}</small></td>
        <td class="num">${metros(e.medianaM)}</td>
        <td class="num">${e.dispersaoM === null ? '—' : e.dispersaoM.toFixed(2) + ' m'}</td>
        <td class="num">${metros(e.derivaM)}</td>
        <td class="num">${e.horasPareadas.toLocaleString('pt-BR')}</td>
        <td><span class="veredito ${v.classe}" title="${v.explica}">${v.texto}</span></td>
      </tr>`;
    }).join('');
  }

  const semAna = document.getElementById('semAna');
  if (d.semAna.length > 0) {
    semAna.textContent =
      'Sem comparação por decisão, não por falha: ' +
      d.semAna.map((e) => `${e.cidade}/${e.uf}`).join(' e ') +
      ' não têm código ANA mapeado — o inventário oficial não deu resposta inequívoca pra elas, e usar um código errado seria pior que não mostrar nada.';
    semAna.hidden = false;
  }
}

async function carregar() {
  const sub = document.getElementById('sub');
  try {
    // As duas em paralelo: são independentes, e a página só fica útil com
    // as duas — não faz sentido serializar a espera.
    const [saude, divergencia] = await Promise.all([
      fetch('/api/saude').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch('/api/divergencia').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
    ]);

    renderizarSaude(saude);
    renderizarDivergencia(divergencia);

    const comparadas = divergencia.estacoes.length;
    sub.textContent = `${comparadas} estaç${comparadas === 1 ? 'ão comparada' : 'ões comparadas'} com a ANA · saúde da coleta em 24h e 7 dias`;
  } catch (e) {
    sub.textContent = 'Não foi possível carregar: ' + e.message;
  }
}

carregar();

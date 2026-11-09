// Lógica exclusiva da página de acerto da estimativa (acerto.html).
// Depende de js/tema.js (tema, precisa carregar antes) e js/comum.js
// (hora, também antes).

function formatarHoras(horas) {
  if (horas < 48) return Math.round(horas) + 'h';
  return (horas / 24).toFixed(1) + ' dias';
}

async function carregar() {
  try {
    const r = await fetch('/api/acerto');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const dados = await r.json();
    renderizar(dados);
  } catch (e) {
    document.getElementById('sub').textContent = 'Não foi possível carregar: ' + e.message;
  }
}

function taxaTexto(taxa) {
  return taxa === null ? '—' : Math.round(taxa * 100) + '%';
}

function renderizar(dados) {
  // Totais POR VERSÃO no subtítulo: v1 e v2 são populações geradas por
  // regras diferentes, e um total único esconderia de qual delas vêm as
  // avaliações.
  const resumo = dados.porVersao
    .map((v) => `v${v.versao}: ${v.totalAvaliadas} avaliadas · ${v.pendentes} em aberto`)
    .join('  |  ');
  document.getElementById('sub').textContent = resumo || 'Nenhuma estimativa registrada ainda';

  const elFaixas = document.getElementById('faixas');
  if (dados.totalAvaliadas === 0) {
    elFaixas.innerHTML = '<p class="vazio">Ainda não há estimativas avaliadas — isso leva tempo, porque cada uma só é avaliada depois que o prazo dela vence.</p>';
  } else {
    elFaixas.innerHTML = dados.porVersao.map((v) => `
      <section class="versao">
        <h3>v${v.versao} · ${v.totalAvaliadas === 0
          ? 'sem avaliações ainda'
          : `${taxaTexto(v.taxa)} no total (${v.acertos} de ${v.totalAvaliadas})`}</h3>
        <div class="faixas">
          ${v.porFaixa.map((f) => `
            <div class="faixa-card">
              <span>${f.faixa}</span>
              <strong>${taxaTexto(f.taxa)}</strong>
              <small>${f.total === 0 ? 'sem avaliações' : `${f.acertos} de ${f.total} corretas`}</small>
            </div>
          `).join('')}
        </div>
      </section>
    `).join('');
  }

  const corpo = document.getElementById('corpoRecentes');
  if (dados.recentes.length === 0) {
    corpo.innerHTML = '<tr><td colspan="7" class="vazio">Nenhuma avaliação ainda.</td></tr>';
    return;
  }
  corpo.innerHTML = dados.recentes.map((r) => {
    const tipo = r.classe === 'subindo' ? '⏱ atinge a cota' : '↩ volta ao normal';
    const erro = r.erroHoras === null ? '—' : (r.erroHoras >= 0 ? '+' : '') + r.erroHoras.toFixed(1) + 'h';
    return `<tr>
      <td>${r.cidade}/${r.uf}</td>
      <td>v${r.estimadorVersao}</td>
      <td>${tipo}</td>
      <td>${formatarHoras(r.horasEstimadas)}</td>
      <td>${hora(r.alvoEm)}</td>
      <td class="${r.resultado}">${r.resultado === 'acertou' ? '✓ acertou' : '✕ errou'}</td>
      <td>${erro}</td>
    </tr>`;
  }).join('');
}

carregar();

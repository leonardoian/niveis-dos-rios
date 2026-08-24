import { executarColeta } from '../lib/coletar.js';

// Agendamento é externo (ex.: cron-job.org) chamando esta rota a cada 15 min
// com o header Authorization: Bearer $CRON_SECRET — o plano Hobby do Vercel
// só permite cron nativo 1x/dia, então não há Vercel Cron aqui.
// A coleta em si (fetch do feed + gravação) fica em lib/coletar.js e também
// pode ser rodada fora do Vercel — ver scripts/coletar-local.js.
export default async function handler(req, res) {
  const segredo = process.env.CRON_SECRET;

  // Falha FECHADA: sem CRON_SECRET configurado no ambiente, recusa tudo em
  // vez de liberar geral. Antes, "segredo &&" pulava a checagem inteira se a
  // variável não existisse — bastava esquecer de configurar no Vercel pra
  // essa rota (que dispara coleta e grava no banco) ficar pública.
  if (!segredo) {
    console.error('CRON_SECRET não configurado — recusando por segurança.');
    return res.status(503).json({ erro: 'Rota não configurada.' });
  }

  const autorizacao = req.headers.authorization;
  if (autorizacao !== `Bearer ${segredo}`) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }

  try {
    const resultado = await executarColeta();
    // 502 quando o feed de nível falhou: a coleta em si rodou (previsão e
    // ANA seguiram, ver lib/coletar.js) e o corpo diz exatamente o que
    // aconteceu, mas o status precisa continuar não-2xx pro agendador
    // externo alertar em vez de contar como sucesso silencioso.
    return res.status(resultado.ok ? 200 : 502).json(resultado);
  } catch (erro) {
    console.error('Falha na coleta:', erro);
    return res.status(500).json({ ok: false, erro: erro.message });
  }
}

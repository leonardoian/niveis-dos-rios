import { executarColeta } from '../lib/coletar.js';

// Agendamento é externo (ex.: cron-job.org) chamando esta rota a cada 15 min
// com o header Authorization: Bearer $CRON_SECRET — o plano Hobby do Vercel
// só permite cron nativo 1x/dia, então não há Vercel Cron aqui.
// A coleta em si (fetch do feed + gravação) fica em lib/coletar.js e também
// pode ser rodada fora do Vercel — ver scripts/coletar-local.js.
export default async function handler(req, res) {
  const segredo = process.env.CRON_SECRET;
  const autorizacao = req.headers.authorization;

  if (segredo && autorizacao !== `Bearer ${segredo}`) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }

  try {
    const resultado = await executarColeta();
    return res.status(200).json(resultado);
  } catch (erro) {
    console.error('Falha na coleta:', erro);
    return res.status(500).json({ ok: false, erro: erro.message });
  }
}

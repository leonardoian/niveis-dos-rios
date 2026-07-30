import { sql } from '../lib/db.js';

// Inscrição/cancelamento de notificações push (ver public/js/push.js e
// public/sw.js no cliente, lib/push.js no envio). Vercel já faz parse
// automático de JSON pra req.body em funções Node — sem body-parser.
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ erro: 'Inscrição inválida' });
    }

    await sql`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth)
      VALUES (${endpoint}, ${keys.p256dh}, ${keys.auth})
      ON CONFLICT (endpoint) DO NOTHING
    `;
    return res.status(201).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ erro: 'endpoint é obrigatório' });
    }

    await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ erro: 'Método não permitido' });
}

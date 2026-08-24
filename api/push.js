import { sql } from '../lib/db.js';
import { endpointPermitido, chavesValidas } from '../lib/push.js';

// Inscrição/cancelamento de notificações push (ver public/js/push.js e
// public/sw.js no cliente, lib/push.js no envio). Vercel já faz parse
// automático de JSON pra req.body em funções Node — sem body-parser.
//
// Rota pública de propósito (qualquer visitante pode se inscrever, igual um
// "avise-me"), então o `endpoint` é dado hostil: só passa se for HTTPS num
// dos serviços de push conhecidos (endpointPermitido em lib/push.js) — senão
// vira um SSRF disparado pelo nosso servidor a cada alerta. Ver README.
export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const { endpoint, keys } = req.body || {};
      if (!endpointPermitido(endpoint) || !chavesValidas(keys)) {
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
      // Sem allowlist aqui de propósito: apagar é sempre seguro, e uma
      // inscrição gravada antes da allowlist existir precisa continuar
      // podendo ser cancelada pelo próprio navegador que a criou.
      const { endpoint } = req.body || {};
      if (typeof endpoint !== 'string' || endpoint.length === 0) {
        return res.status(400).json({ erro: 'endpoint é obrigatório' });
      }

      await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ erro: 'Método não permitido' });
  } catch (erro) {
    console.error('Falha na inscrição push:', erro);
    return res.status(500).json({ erro: 'Falha interna.' });
  }
}

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
//
// `slugs` é opcional: ausente/vazio = todas as estações, que é o
// comportamento histórico e o default de quem não escolhe nada.
export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const { endpoint, keys, slugs } = req.body || {};
      if (!endpointPermitido(endpoint) || !chavesValidas(keys)) {
        return res.status(400).json({ erro: 'Inscrição inválida' });
      }

      // Valida contra as estações que existem de verdade, em vez de gravar
      // o que vier: um slug digitado errado viraria uma inscrição que nunca
      // recebe nada, e o silêncio é indistinguível de "não houve alerta".
      let slugsValidados = null;
      if (slugs !== undefined && slugs !== null) {
        if (!Array.isArray(slugs) || slugs.some((s) => typeof s !== 'string')) {
          return res.status(400).json({ erro: 'slugs deve ser uma lista de strings' });
        }
        const conhecidas = await sql`SELECT slug FROM estacoes WHERE ativa = TRUE`;
        const validos = new Set(conhecidas.map((e) => e.slug));
        const desconhecidos = slugs.filter((s) => !validos.has(s));
        if (desconhecidos.length > 0) {
          return res.status(400).json({ erro: `Estação desconhecida: ${desconhecidos.join(', ')}` });
        }
        // Lista vazia ou com todas as estações vira NULL — "todas" tem uma
        // representação só no banco, e NULL é a que acompanha uma estação
        // nova que entre no painel depois.
        slugsValidados = slugs.length === 0 || slugs.length === validos.size ? null : slugs;
      }

      // DO UPDATE, não DO NOTHING: reinscrever o mesmo navegador é como a
      // pessoa MUDA a preferência dela. Com DO NOTHING a troca era
      // silenciosamente ignorada e ela seguia recebendo o que tinha antes.
      await sql`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, slugs)
        VALUES (${endpoint}, ${keys.p256dh}, ${keys.auth}, ${slugsValidados})
        ON CONFLICT (endpoint) DO UPDATE
          SET p256dh = EXCLUDED.p256dh,
              auth   = EXCLUDED.auth,
              slugs  = EXCLUDED.slugs
      `;
      return res.status(201).json({ ok: true, slugs: slugsValidados });
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

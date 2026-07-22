import { executarColeta } from '../lib/coletar.js';

// Roda a coleta direto do terminal, sem passar pela rota HTTP do Vercel.
// Só precisa de DATABASE_URL no ambiente — não usa CRON_SECRET, já que
// não é uma rota exposta na internet.
//
// Uso:
//   node --env-file=.env scripts/coletar-local.js
//
// Pode ser chamado por qualquer agendador fora do Vercel: cron da própria
// máquina, GitHub Actions, etc.
try {
  const resultado = await executarColeta();
  console.log(JSON.stringify(resultado, null, 2));
} catch (erro) {
  console.error('Falha na coleta:', erro);
  process.exitCode = 1;
}

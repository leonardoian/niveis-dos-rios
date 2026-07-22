import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não definida. Configure em Settings > Environment Variables no Vercel.');
}

// Driver serverless da Neon: usa HTTP, ideal para funções do Vercel
// (sem pool persistente, sem conexões penduradas entre invocações).
export const sql = neon(process.env.DATABASE_URL);

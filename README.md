# Monitoramento de Níveis dos Rios — Bacia do Guaíba

Sistema interno que coleta os níveis das 13 estações do feed público de
`nivelguaiba.com.br`, guarda a série histórica no Neon e exibe o painel.

## Estrutura

```
api/coletar.js                       rota HTTP protegida por CRON_SECRET; chama lib/coletar.js
api/painel.js                         estado atual das estações (nível, cota, cm/h, status)
api/historico.js                      série temporal de uma estação
lib/db.js                             conexão com o Neon
lib/feed.js                           leitura e parse do feed JSON
lib/coletar.js                        lógica de coleta em si (fetch + grava + alertas)
scripts/coletar-local.js              roda a coleta fora do Vercel (terminal, GitHub Actions etc.)
.github/workflows/coletar.yml         GitHub Actions: roda a coleta a cada 15 min, sem o Vercel
public/index.html                     painel
schema.sql                            tabelas + carga inicial das 13 estações
```

## Passo a passo

### 1. Banco (Neon)

Abra o SQL Editor do seu projeto no Neon e rode o conteúdo de `schema.sql`.
Isso cria as tabelas `estacoes`, `leituras` e `alertas`, e já insere as 13
estações com as cotas de inundação.

Confira:

```sql
SELECT cidade, rio, cota_inundacao FROM estacoes ORDER BY ordem;
```

### 2. Variáveis de ambiente no Vercel

Em Settings → Environment Variables, adicione:

| Nome           | Valor                                              |
| -------------- | -------------------------------------------------- |
| `DATABASE_URL` | a connection string do Neon (com `?sslmode=require`) |
| `CRON_SECRET`  | uma string aleatória qualquer                       |

Gere o `CRON_SECRET` com: `openssl rand -hex 32`

Nunca coloque essas credenciais no código nem commite o `.env`.

### 3. Deploy

```bash
npm install
npx vercel --prod
```

O plano Hobby do Vercel não aceita cron nativo mais frequente que 1x/dia, então
o `vercel.json` não registra nenhum cron. O agendamento de 15 em 15 minutos é
feito por um serviço externo — ver passo seguinte.

### 4. Agendamento da coleta (cron externo)

O plano Hobby do Vercel não agenda nada nesse projeto, então a coleta de 15 em
15 minutos precisa vir de fora. Duas opções — escolha uma:

**Opção A — cron-job.org chamando o Vercel.** Configure um serviço como o
[cron-job.org](https://cron-job.org) para chamar `/api/coletar` a cada 15
minutos com o header:

```
Authorization: Bearer SEU_CRON_SECRET
```

A rota não depende de nada específico do Vercel Cron — é uma função HTTP comum
que só valida esse header, então funciona com qualquer serviço de agendamento
externo, não só o cron-job.org.

**Opção B — GitHub Actions, sem tocar no Vercel.** Este repositório já traz
`.github/workflows/coletar.yml`, que roda `scripts/coletar-local.js` a cada 15
minutos direto no Neon — não passa pela rota HTTP nem depende do Vercel estar
no ar. Pra ativar:

1. No GitHub: Settings → Secrets and variables → Actions → New repository
   secret → nome `DATABASE_URL`, valor a connection string do Neon.
2. Pronto — o workflow já está no repo e roda sozinho a partir do próximo
   agendamento. Pra testar sem esperar, vá em Actions → "Coleta de níveis dos
   rios" → Run workflow (usa o gatilho `workflow_dispatch`).

Duas ressalvas do GitHub Actions: o agendamento (`cron:`) não é exato — o
GitHub pode atrasar alguns minutos em horários de pico — e workflows agendados
são **desativados automaticamente após 60 dias sem nenhum commit** no
repositório (basta reativar em Actions se isso acontecer).

### 5. Primeira coleta

Para popular o banco na hora, sem esperar o primeiro disparo do agendador
externo:

```bash
curl -H "Authorization: Bearer SEU_CRON_SECRET" \
  https://SEU-PROJETO.vercel.app/api/coletar
```

Resposta esperada:

```json
{ "ok": true, "recebidas": 13, "inseridas": 13, "ignoradas": [], "alertas": [] }
```

A coluna `velocidadeCmH` só aparece a partir da segunda coleta — ela precisa de
duas leituras para calcular a variação.

## Rodando a coleta sem depender do Vercel

A coleta (buscar o feed + gravar no Neon) está isolada em `lib/coletar.js` e
não depende de nada específico do Vercel — o driver da Neon usa HTTP, então
funciona de qualquer lugar com Node 20+. Pra rodar direto do terminal, sem
passar pela rota `/api/coletar`:

1. Crie um `.env` local (nunca commitado — já está no `.gitignore`) com:

   ```
   DATABASE_URL=postgresql://usuario:senha@host.neon.tech/neondb?sslmode=require
   ```

   Não precisa de `CRON_SECRET` aqui — o script não é uma rota exposta na
   internet.

2. Rode:

   ```bash
   npm run coletar
   ```

   Isso executa `node --env-file=.env scripts/coletar-local.js`, que chama a
   mesma lógica de `api/coletar.js` e imprime o resultado no terminal.

Esse script pode ser agendado por qualquer coisa fora do Vercel — cron da sua
própria máquina, um GitHub Actions com `schedule:`, etc. — desde que o
ambiente tenha `DATABASE_URL`. Ele grava direto no Neon; o painel (`/api/painel`,
hospedado no Vercel) lê do mesmo banco e não precisa saber de onde veio o dado.

## Endpoints

| Rota                                    | Descrição                          |
| --------------------------------------- | ---------------------------------- |
| `GET /api/painel`                       | todas as estações, estado atual     |
| `GET /api/historico?slug=lajeado&horas=48` | série temporal de uma estação    |
| `GET /api/coletar`                      | força uma coleta (requer o header)  |

## Notas

- **Cota de inundação** não vem do feed. Fica fixa na tabela `estacoes`; para
  ajustar, faça `UPDATE estacoes SET cota_inundacao = X WHERE slug = 'Y'`.
- **Velocidade (cm/h)** é calculada em `api/painel.js` a partir das duas últimas
  leituras: `(Δnível em metros × 100) / horas decorridas`.
- **Duplicatas**: a constraint `UNIQUE (slug, medido_em)` faz o cron ser
  idempotente — se o feed não atualizou, nada é inserido.
- **Status**: normal < 60% da cota · atenção ≥ 60% · alerta ≥ 80% · alagado ≥ 100%.
- O agendamento da coleta é externo — o Vercel não agenda nada neste projeto,
  já que o plano Hobby só libera cron nativo 1x/dia. Use o GitHub Actions
  (`.github/workflows/coletar.yml`, já incluso) ou um serviço como o
  cron-job.org chamando `/api/coletar`.

## Fontes dos dados

Feed agregador `nivelguaiba.com.br` (projeto voluntário da Mahalo Ventures),
que por sua vez consome telemetria pública da SGB/CPRM e da ANA. Para decisões
críticas, consulte sempre a Defesa Civil do RS.

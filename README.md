# Monitoramento de Níveis dos Rios — Bacia do Guaíba

Sistema interno que coleta os níveis das 13 estações do feed público de
`nivelguaiba.com.br`, guarda a série histórica no Neon e exibe o painel.

## Estrutura

```
api/coletar.js     rota chamada pelo Vercel Cron a cada 15 min
api/painel.js      estado atual das estações (nível, cota, cm/h, status)
api/historico.js   série temporal de uma estação
lib/db.js          conexão com o Neon
lib/feed.js        leitura e parse do feed JSON
public/index.html  painel
schema.sql         tabelas + carga inicial das 13 estações
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

O `vercel.json` já registra o cron de 15 em 15 minutos apontando para
`/api/coletar`. O Vercel envia o header `Authorization: Bearer $CRON_SECRET`
automaticamente nas chamadas agendadas.

### 4. Primeira coleta

O cron leva até 15 minutos para rodar pela primeira vez. Para popular o banco
na hora:

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
- O plano gratuito do Vercel permite crons apenas uma vez por dia. Para o
  intervalo de 15 minutos é necessário o plano Pro; alternativa gratuita é usar
  o cron-job.org chamando a mesma rota com o header de autorização.

## Fontes dos dados

Feed agregador `nivelguaiba.com.br` (projeto voluntário da Mahalo Ventures),
que por sua vez consome telemetria pública da SGB/CPRM e da ANA. Para decisões
críticas, consulte sempre a Defesa Civil do RS.

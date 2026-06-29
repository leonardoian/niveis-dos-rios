# Níveis dos Rios — RS

Monitoramento em tempo real dos níveis dos rios do Rio Grande do Sul, com foco na bacia do Guaíba e do Taquari. Criado para uso pessoal após as enchentes de 2024 e como projeto de portfólio/estudo.

## Arquitetura

```
├── api/
│   ├── coletar.js     Cron horário: autentica na ANA e faz upsert no banco
│   ├── estacoes.js    GET /api/estacoes — status atual de todas as estações
│   └── historico.js   GET /api/historico?estacao=CODIGO — 72h de leituras
├── public/
│   ├── index.html     Mapa Leaflet com marcadores por status
│   └── estacao.html   Detalhe da estação + gráfico Chart.js (72h)
├── schema.sql         DDL do banco (rodar uma vez no Neon)
├── seed.sql           Estações iniciais (rodar após o schema)
└── vercel.json        Configuração do cron (executa /api/coletar 1×/hora)
```

**Stack:**
- Backend: funções serverless da [Vercel](https://vercel.com)
- Banco: [Neon PostgreSQL](https://neon.tech) via `@neondatabase/serverless`
- Frontend: HTML + JavaScript puro, [Leaflet.js](https://leafletjs.com) e [Chart.js](https://chartjs.org)

## Variáveis de ambiente

| Variável           | Descrição |
|--------------------|-----------|
| `DATABASE_URL`     | Connection string do Neon (painel → Connection Details → Pooled) |
| `ANA_IDENTIFICADOR`| Identificador da conta na API HidroWebService da ANA |
| `ANA_SENHA`        | Senha da conta ANA |
| `CRON_SECRET`      | String aleatória para proteger o endpoint `/api/coletar` |

Copie `.env.example` para `.env` e preencha antes de rodar localmente.

> **Credenciais da ANA:** solicite cadastro na [API HidroWebService](https://www.ana.gov.br/hidrowebservice). O endpoint de autenticação pode bloquear IPs com chamadas em alta frequência — o token já é cacheado por 50 min no `api/coletar.js`.

## Configuração do banco

Execute no console SQL do Neon (ou via `psql`) nesta ordem:

```bash
psql $DATABASE_URL -f schema.sql
psql $DATABASE_URL -f seed.sql
```

O `schema.sql` cria as tabelas `estacoes`, `leituras`, `inscricoes` e a view `estacao_status`. O `seed.sql` insere as 6 estações iniciais da bacia do Taquari/Guaíba.

As cotas de atenção/alerta de algumas estações estão como `NULL` no seed — preencha com os valores do boletim oficial do [SGB/SACE](https://sgb.gov.br/sace/taquari).

## Rodar localmente

```bash
npm install
npx vercel dev
```

Acesse `http://localhost:3000`. O mapa carregará as estações, mas as leituras só chegarão depois que suas credenciais da ANA forem ativadas e o cron executar pela primeira vez (ou você chamar `/api/coletar` manualmente).

Para testar o coletor manualmente:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/coletar
```

## Deploy na Vercel

1. Faça push do repositório para o GitHub.
2. Importe o projeto no painel da Vercel.
3. Adicione as variáveis de ambiente (`DATABASE_URL`, `ANA_IDENTIFICADOR`, `ANA_SENHA`, `CRON_SECRET`) em **Settings → Environment Variables**.
4. Faça o deploy. O cron do `vercel.json` passará a executar `/api/coletar` a cada hora automaticamente.

> O cron requer o plano **Hobby** ou superior da Vercel.

## Fontes de dados

- **ANA — Agência Nacional de Águas**: leituras das estações telemétricas via [HidroWebService](https://www.ana.gov.br/hidrowebservice)
- **SGB-CPRM / SACE**: cotas de referência (atenção, alerta, inundação) e boletins de situação — [sgb.gov.br/sace](https://sgb.gov.br/sace)

## Aviso

> Este aplicativo é informativo e pode apresentar falhas, atrasos ou dados incorretos. **Para alertas oficiais**, consulte a [Defesa Civil do RS](https://defesacivil.rs.gov.br) e o [SGB/SACE](https://sgb.gov.br/sace/taquari).

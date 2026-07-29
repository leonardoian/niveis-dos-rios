# Monitoramento de Níveis dos Rios — Bacia do Guaíba

Sistema interno que coleta os níveis das 14 estações do feed público de
`nivelguaiba.com.br`, guarda a série histórica no Neon e exibe o painel.

Node 20+, ESM, sem framework e sem build step — Vercel serverless (`/api`) +
estático (`/public`) + Neon Postgres. Não é sistema oficial de alerta.

## Principais funcionalidades

- **Painel** com nível, cota, tendência (cm/h), status de risco e frescor da
  leitura para as 14 estações, com busca/filtro e comparação entre estações
  no mesmo gráfico.
- **Estimativa "quanto falta pra cota"**, com uma página própria mostrando o
  quanto essa estimativa **acerta de verdade**, por antecedência.
- **Vazão e clima previstos** (Open-Meteo/GloFAS) — sempre separados do
  nível medido, nunca convertidos um no outro sem a curva-chave que não
  temos.
- **Comparativo com a cheia de maio/2024**, onde há registro confiável pra
  comparar.
- **Mapa da bacia** (Leaflet) com a hierarquia de como os rios se conectam.
- **Histórico de alertas**, exportação em CSV, recorde histórico no gráfico.
- **Tema claro/escuro, modo apresentação (tela cheia), PDF do painel.**
- **PWA** — instalável na tela inicial do celular — e responsivo em telas
  pequenas.
- **Status de saúde das próprias fontes de dados**, pra saber rápido se o
  feed ou a previsão pararam de responder.

## Índice

- [Estrutura](#estrutura)
- [Passo a passo](#passo-a-passo)
- [Rodando a coleta sem depender do Vercel](#rodando-a-coleta-sem-depender-do-vercel)
- [Endpoints](#endpoints)
- [Notas](#notas)
- [Testes](#testes)
- [Fontes dos dados](#fontes-dos-dados)

## Estrutura

```
api/coletar.js                       rota HTTP protegida por CRON_SECRET; chama lib/coletar.js
api/painel.js                         estado atual das estações (nível, cota, cm/h, status)
api/historico.js                      série temporal de uma estação
api/alertas.js                        últimos alertas (mudança de status), com nome da cidade
api/acerto.js                         acerto da estimativa de cota, por antecedência (ver Notas)
lib/db.js                             conexão com o Neon
lib/feed.js                           leitura e parse do feed JSON
lib/coletar.js                        lógica de coleta em si (fetch + grava + alertas + previsão + estimativas)
lib/previsao.js                       busca vazão (GloFAS) e clima (Open-Meteo) por coordenada
lib/calculo.js                        funções puras (classificar, cm/h, frescor, ETA cota) — testadas em tests/
scripts/coletar-local.js              roda a coleta fora do Vercel (terminal, GitHub Actions etc.)
.github/workflows/coletar.yml         GitHub Actions: roda a coleta a cada 15 min, sem o Vercel
tests/                                testes automatizados (node --test, sem dependência nova)
public/index.html                     painel (estrutura HTML só; CSS/JS em css/ e js/)
public/bacia.html                     mapa da bacia (Leaflet) + hierarquia dos rios
public/acerto.html                    acerto da estimativa de cota, por antecedência
public/css/tema.css                   variáveis de cor (claro/escuro) — as 3 páginas carregam
public/css/base.css                   reset + estilos base (body, button, .rodape-fontes...) — as 3 páginas carregam
public/css/painel.css                 estilos só de index.html
public/css/bacia.css                  estilos só de bacia.html
public/css/acerto.css                 estilos só de acerto.html
public/js/tema.js                     toggle de tema claro/escuro — as 3 páginas carregam
public/js/comum.js                    hora(), ROTULOS, CORES, CONDICOES/condicaoTexto — as 3 páginas carregam
public/js/painel.js                   lógica só de index.html
public/js/bacia.js                    lógica só de bacia.html
public/js/acerto.js                   lógica só de acerto.html
public/manifest.json                  PWA — nome, cores, ícones (pra "adicionar à tela inicial")
public/icons/                         ícones do PWA (gerados, ver nota abaixo)
schema.sql                            tabelas + carga inicial das 14 estações
```

Continua **sem build step** — os `<link rel="stylesheet">` e `<script src="...">` apontam direto pros arquivos em `css/`/`js/`, servidos como estático pelo Vercel, igual a qualquer outro arquivo em `public/`. Nenhum bundler, nenhum passo de compilação novo.

## Passo a passo

### 1. Banco (Neon)

Abra o SQL Editor do seu projeto no Neon e rode o conteúdo de `schema.sql`.
Isso cria as tabelas `estacoes`, `leituras` e `alertas`, e já insere as 13
estações com as cotas de inundação.

Confira:

```sql
SELECT cidade, rio, cota_inundacao FROM estacoes ORDER BY ordem;
```

Se o banco já existia antes de `lat`/`lon`/`previsoes` entrarem no schema, rodar
`schema.sql` de novo é seguro — todo o script é idempotente (`CREATE TABLE IF
NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO UPDATE`), então
completa o que faltar sem duplicar nem apagar nada que já está lá.

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
15 minutos precisa vir de fora. Tem duas fontes possíveis — **e a recomendação
é configurar as duas ao mesmo tempo**, não escolher uma só.

Motivo: na prática, o `schedule` do GitHub Actions não é confiável no minuto
exato — já aconteceu de passar mais de 30 minutos sem disparar, sem nenhum
erro visível, só silêncio. Rodar as duas fontes em paralelo, com os horários
intercalados, cobre a falha de uma com a outra. E isso é seguro: a constraint
`UNIQUE (slug, medido_em)` com `ON CONFLICT DO NOTHING` faz a coleta ser
idempotente, então duas fontes tentando gravar a mesma leitura no mesmo minuto
nunca duplicam nada — na pior das hipóteses, uma delas grava 0 linhas novas.

**Fonte A — cron-job.org chamando o Vercel.** Configure um cron job no
[cron-job.org](https://cron-job.org) apontando pra `/api/coletar` com o header:

```
Authorization: Bearer SEU_CRON_SECRET
```

Em vez de `*/15 * * * *` (que cairia nos mesmos minutos 0/15/30/45 do GitHub
Actions), usa um horário **intercalado**, por exemplo `7,22,37,52 * * * *` —
assim, se uma fonte atrasar ou falhar, a outra passa por ali uns 7-8 minutos
depois, em vez de só na próxima marca de 15 minutos inteira.

A rota não depende de nada específico do Vercel Cron — é uma função HTTP comum
que só valida esse header, então funciona com qualquer serviço de agendamento
externo, não só o cron-job.org.

**Fonte B — GitHub Actions, sem tocar no Vercel.** Este repositório já traz
`.github/workflows/coletar.yml`, que roda `scripts/coletar-local.js` a cada 15
minutos (`*/15 * * * *`) direto no Neon — não passa pela rota HTTP nem depende
do Vercel estar no ar. Pra ativar:

1. No GitHub: Settings → Secrets and variables → Actions → New repository
   secret → nome `DATABASE_URL`, valor a connection string do Neon.
2. Pronto — o workflow já está no repo e roda sozinho a partir do próximo
   agendamento. Pra testar sem esperar, vá em Actions → "Coleta de níveis dos
   rios" → Run workflow (usa o gatilho `workflow_dispatch`).

Duas ressalvas do GitHub Actions: o agendamento (`cron:`) não é exato — o
GitHub pode atrasar alguns minutos (às vezes bem mais) em horários de pico —
e workflows agendados são **desativados automaticamente após 60 dias sem
nenhum commit** no repositório (basta reativar em Actions se isso acontecer).
Rodar o cron-job.org junto cobre exatamente essa falha.

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
| `GET /api/alertas`                      | últimos 30 alertas (mudança de status) |
| `GET /api/acerto`                       | acerto da estimativa de cota, por antecedência |
| `GET /api/coletar`                      | força uma coleta (requer o header)  |

## Notas

### Segurança

Revisão feita cobrindo os ~20 pontos de acesso ao banco, os 3 HTML/JS do
front, dependências, segredos e cabeçalhos HTTP do site publicado. O que
achamos e corrigimos:

- **`/api/coletar` falhava aberto sem `CRON_SECRET`.** O código antigo era
  `if (segredo && autorizacao !== ...)` — se a variável de ambiente não
  existisse no Vercel, a checagem inteira era pulada e a rota (que dispara
  coleta e grava no banco) ficava pública pra qualquer um. Agora, sem
  `CRON_SECRET` configurado, a rota recusa tudo (503) em vez de liberar
  geral — falha **fechada**, não aberta.
- **Scripts de CDN sem Subresource Integrity (SRI).** Chart.js, html2canvas,
  jsPDF e Leaflet (JS + CSS) agora carregam com `integrity="sha384-..."` /
  `sha512-...` + `crossorigin="anonymous"` — se um desses CDNs for
  comprometido um dia e passar a servir um arquivo diferente do que
  esperamos, o navegador recusa executar em vez de rodar o que vier. Os
  hashes de `cdnjs.cloudflare.com` foram conferidos contra a própria API
  pública deles (`api.cdnjs.com/libraries/...?fields=sri`), não só
  calculados por nós.
- **`Content-Security-Policy` + headers de segurança** (`vercel.json`,
  aplicado a todas as rotas): `script-src` restrito a `'self'` + os dois
  domínios de CDN (sem `unsafe-inline`/`unsafe-eval` — não há mais nenhum
  `<script>` inline no projeto, então dava pra ser estrito de verdade).
  `style-src` precisou de `'unsafe-inline'` porque várias partes do painel
  usam `style="background:${cor}"` inline pra colorir card/tag/barra
  dinamicamente — é um trade-off consciente (CSS injection é bem menos
  grave que script injection) documentado aqui em vez de escondido.
  `frame-ancestors 'none'` + `X-Frame-Options: DENY` (clickjacking),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy` desligando
  câmera/mic/geolocalização (nada disso é usado). **Testado de verdade**,
  não só escrito: rodei Playwright injetando esses headers exatos e
  interagindo com o app inteiro (tema, abrir modal com gráfico, comparar
  estações, ajuda, Gerar PDF, o mapa da bacia) checando violação real de
  CSP no console — a primeira tentativa **pegou um bug real** (o
  `html2canvas`, usado no "Gerar PDF", injeta uma imagem `data:` internamente
  que a CSP inicial bloqueava; `img-src` precisou incluir `data:`).
- **3 pontos com `innerHTML = texto + e.message + texto`** (mensagens de
  erro em `painel.js`/`bacia.js`) viraram um helper único,
  `mostrarAviso()` (`comum.js`), que usa `textContent` pra parte variável.
  Hoje `e.message` só contém strings nossas (`"HTTP 500"` etc.), então não
  era explorável na prática — mas era um padrão frágil que ficaria
  vulnerável se um dia alguém passasse a incluir resposta do servidor na
  mensagem, sem perceber que estava abrindo um XSS.

O que **já estava bem** e não precisou de mudança: toda query ao banco usa
o template parametrizado do driver da Neon (`sql\`...\``) — nenhuma
concatenação de string em SQL em lugar nenhum, então sem risco de SQL
injection encontrado. Sem segredo commitado (conferido o histórico
completo do git, não só o estado atual). `npm audit`: 0 vulnerabilidades
(uma única dependência de runtime, `@neondatabase/serverless`). Sem
`eval`/`new Function`/`document.write`. HTTPS forçado (HSTS já vem por
padrão do Vercel). Os dados dinâmicos renderizados no front (cidade, rio,
a nota da régua de Porto Alegre) vêm todos da nossa própria tabela
`estacoes`, nunca de input de usuário ou do feed externo direto — não há
vetor prático de XSS pelos dados em si, mesmo sem escaping explícito em
todo lugar.

### Organização do CSS/JS entre as 3 páginas

`index.html`, `bacia.html` e `acerto.html` costumavam ter cada uma seu
próprio `<style>`/`<script>` inline — e três blocos praticamente idênticos
de variáveis de tema, `hora()`, `ROTULOS`/`CORES`/`CONDICOES` duplicados
byte a byte entre elas. Agora ficam em `public/css/` e `public/js/`:

- **`tema.css`/`tema.js`** e **`base.css`/`comum.js`**: o que é *idêntico*
  nas 3 páginas — variáveis de cor, reset, `body`/`button`/`.rodape-fontes`,
  toggle de tema, `hora()`, `ROTULOS`/`CORES`/`CONDICOES`. Confirmado
  idêntico com diff antes de extrair, não foi "parece igual".
- **`painel.css`/`painel.js`, `bacia.css`/`bacia.js`, `acerto.css`/`acerto.js`**:
  o que é específico de cada página.

Continua tudo `<link>`/`<script src="">` direto — sem bundler, sem passo de
build novo, sem módulos ES no navegador (as 3 páginas carregam os scripts
na mesma ordem/escopo global de antes: `tema.js` → `comum.js` → o script da
página). A refatoração foi só reorganização de arquivo; nenhum comportamento
deveria ter mudado — cada extração foi conferida com diff linha a linha
contra o original antes de ser considerada pronta.

Uma inconsistência que a refatoração **não corrigiu de propósito** (pra não
misturar reorganização com mudança de comportamento): o `@media (max-width:
600px)` que aumenta o alvo de toque dos botões no celular só existe em
`painel.css` — `bacia.html`/`acerto.html` nunca tiveram essa regra, mesmo
antes da refatoração. Se fizer sentido igualar, dá pra mover pra `base.css`
depois, como mudança separada.

### Vercel Analytics

As 3 páginas carregam `<script defer src="/_vercel/insights/script.js">`
antes do `</body>`. Não é o pacote `@vercel/analytics` (esse é pra projetos
React/Next.js) — é a versão "vanilla" pra site estático: o próprio Vercel
serve esse script automaticamente pra qualquer projeto com Web Analytics
habilitado no dashboard, sem precisar instalar nada nem mudar o build. Só
funciona depois de deployado no Vercel (localmente ou noutro host, o
`<script>` simplesmente falha em carregar, sem quebrar o resto da página).

### Como os números são calculados

- **Cota de inundação** não vem do feed. Fica fixa na tabela `estacoes`; para
  ajustar, faça `UPDATE estacoes SET cota_inundacao = X WHERE slug = 'Y'`.
- **Velocidade (cm/h)** é calculada em `api/painel.js` a partir das duas últimas
  leituras: `(Δnível em metros × 100) / horas decorridas`.
- **Duplicatas**: a constraint `UNIQUE (slug, medido_em)` faz o cron ser
  idempotente — se o feed não atualizou, nada é inserido.
- **Status**: normal < 60% da cota · atenção ≥ 60% · alerta ≥ 80% · alagado ≥ 100%.
- **Frescor por leitura** (`frescor` em cada estação do `/api/painel`) marca
  `ao_vivo` (≤20 min) / `atrasado` (≤1h) / `obsoleto` (>1h) individualmente —
  mais granular que o `ultimaColeta` global, que só reflete a estação mais
  recente entre todas.

### Estimativa de cota e sua validação

- **Estimativa "quanto falta pra cota" / "volta ao normal"** (`calcularEtaCota`
  em `public/index.html`, usada tanto no card quanto no modal de histórico):
  extrapolação linear simples da tendência **medida agora** (cm/h), não do
  modelo de vazão de dias. Dois casos, mutuamente exclusivos:
  - subindo e abaixo da cota → "⏱ atinge a cota em ~Xh";
  - descendo e ainda acima do limiar de status "normal" (60% da cota, mesmo
    limiar já usado em `classificar`) → "↩ volta ao normal em ~Xh".
  Ambos são estimativa de curto prazo, o texto (e o `title` no card) deixa
  isso explícito; não tenta prever além de poucas horas/dias porque o ritmo
  de subida/descida de um rio não é constante. Como usa só as duas últimas
  leituras, pode ficar zerada mesmo com uma tendência clara ao longo do dia
  (flutuação normal do instrumento entre duas leituras consecutivas) — o
  dado bruto está sempre no `/api/painel` (`velocidadeCmH`, `margem`) pra
  conferir.
- **Acerto da estimativa de cota** (`public/acerto.html` + `api/acerto.js`;
  tabela `estimativas_cota`; `registrarEstimativasCota`/`avaliarEstimativasCota`
  em `lib/coletar.js`; `calcularEtaCota` extraída pra `lib/calculo.js`,
  compartilhada em espírito com `renderizarEstimativaCota` do painel — a
  mesma conta reimplementada nos dois lados, já que `public/index.html` é
  script solto sem bundler e não dá pra importar `lib/`). Ideia veio de
  analisar o `enchentes.lab4ge.com`, que tem uma página parecida — mas com
  um escopo bem mais restrito, de propósito:
  - **Só valida a estimativa "⏱ atinge a cota" / "↩ volta ao normal"**, não
    a vazão prevista. Motivo: pra validar uma previsão, precisa de uma
    medição real e independente pra comparar depois — pra vazão a gente só
    tem modelo (Open-Meteo/GloFAS), nenhuma medição real, então "validar"
    isso seria só comparar um resultado do modelo com outro resultado do
    mesmo modelo. Pra estimativa de cota, a gente tem: ela é extrapolação
    da nossa própria telemetria de nível, e depois dá pra conferir contra
    o nível **real** medido depois — validação de verdade.
  - Cada vez que a coleta roda (`registrarEstimativasCota`), se a estação
    está subindo/descendo o bastante pra gerar uma estimativa e **não**
    existe uma "em aberto" ainda pra ela, arquiva: nível e velocidade no
    momento, `alvo_nivel` (a cota, ou 60% dela), horas estimadas, e o
    horário-alvo (`alvo_em`). Só uma em aberto por estação por vez — senão
    uma subida de várias horas geraria uma linha quase idêntica a cada 15
    min.
  - Quando o prazo vence (`alvo_em` + tolerância — 20% do horizonte
    estimado, entre 1h e 12h), `avaliarEstimativasCota` confere se alguma
    leitura real da estação cruzou o `alvo_nivel` dentro da janela
    `[previsto_em, alvo_em + tolerância]`. Cruzou = "acertou" (com
    `erro_horas` = diferença entre o cruzamento real e o horário previsto).
    Não cruzou (seja porque ainda não tinha chegado lá, seja porque a
    tendência reverteu antes) = "errou" — as duas situações contam igual,
    porque na hora H a estimativa não teria ajudado quem confiasse nela.
  - `/api/acerto` agrupa por antecedência (até 6h / 6–24h / mais de 24h) —
    a expectativa razoável é a taxa cair conforme o horizonte cresce, já
    que a extrapolação usa só as duas últimas leituras (bem sensível a
    ruído, como documentado em `calcularEtaCota`); um resultado "ruim" pras
    janelas longas não é bug, é o preço honesto de uma extrapolação simples
    tentando prever longe.

### Vazão e clima previstos

- **Previsão de vazão** (`lib/previsao.js`) vem do Open-Meteo/GloFAS, grátis e
  sem chave, buscada por coordenada (`lat`/`lon` em `estacoes`). É **vazão em
  m³/s, não nível em metros** — não dá pra converter uma na outra sem a
  curva-chave de cada estação, que não temos, então nunca é comparada com
  `cota_inundacao`. Atualizada no máximo 1x a cada 6h (~4x/dia) por estação —
  **não** é porque a Open-Meteo só atualiza a previsão nessa cadência (o
  modelo dela muda várias vezes ao dia); é só pra não bater a API a cada
  15 min de coleta sem necessidade. Uma falha na previsão não derruba a
  coleta de nível. Em rios largos como o Guaíba a grade de 5km do modelo
  pode não acertar o canal certo — os números saem baixos demais nesse
  caso, é limitação da fonte, não bug.
- **Clima previsto** (`buscarClima` em `lib/previsao.js`) vem da API padrão do
  Open-Meteo, mesma cadência (~4x/dia) e mesma linha de `previsoes` da vazão
  (dia + temperatura máx/mín + chuva prevista + condição). As duas chamadas
  são independentes (`Promise.allSettled`): se uma falhar, a outra ainda
  grava a parte dela, por isso as colunas são anuláveis e o `INSERT` usa
  `COALESCE`. Como a atualização não é instantânea, o que está salvo pode
  divergir um pouco do que a Open-Meteo mostra numa consulta ao vivo,
  principalmente nos dias mais distantes da previsão de 7 dias — é o
  trade-off de não bater a API a cada coleta.
- **Chuva prevista** aparece junto da tendência de vazão no modal de
  histórico (mesmo dado de `previsao`, campo `chuvaMm`).

### Qualidade e transparência dos dados

- **Comparativo com a cheia de maio/2024** (colunas `nivel_cheia_2024` /
  `data_cheia_2024` em `estacoes`): mostra "🌊 X% do nível da cheia de 2024"
  no card e uma linha tracejada extra no gráfico do modal ("Cheia de
  maio/2024"). Os valores foram extraídos do próprio `nivelguaiba.com.br`
  (mesma régua/estação já usada na coleta, então comparável direto com o
  nível atual sem risco de datum diferente) e cruzados com imprensa/SGB
  pra Porto Alegre, Lajeado e Muçum. Fica `NULL` de propósito em 3
  estações: **Cachoeira do Sul** e **Encantado** (o próprio site admite
  não ter registro consolidado pra elas) e **Roca Sales** (o site retorna
  um "pico" de só 5,32 m em 29/05/2024, mas a cidade foi uma das mais
  destruídas pela enchente já no início de maio — o número quase certamente
  reflete uma estação que só entrou em operação depois do auge do
  desastre, não o pico real; melhor não mostrar do que mostrar errado).
  Pra ajustar/completar esses valores no futuro, edite a carga inicial em
  `schema.sql` e rode o script de novo (idempotente).
- **Régua de Porto Alegre/Guaíba corrigida** (coluna `nota` em `estacoes`,
  achado analisando um site parecido de um amigo — https://enchentes.lab4ge.com/
  — e confirmado direto na fonte oficial da ANA, não só no site dele): em
  03/05/2024 a ANA e o SGB recalibraram a série da Usina do Gasômetro
  (código 87450020), subtraindo **1,18 m** de todas as leituras (passadas e
  futuras) pra alinhar ao referencial nacional IBGE 1788A. Isso mudou dois
  números que estavam errados pra essa régua:
  - `cota_inundacao`: era 3,00 m — que na verdade é a referência **pública**
    de inundação, medida no **Cais Mauá** (fonte: prefeitura.poa.br/dmae),
    um local diferente da estação que a gente realmente lê. O equivalente
    na régua atual do Gasômetro é **2,42 m** — confirmado batendo nosso
    nível ao vivo (1,14 m) com o da ANA/SGB no mesmo minuto exato.
  - `nivel_cheia_2024`: era 5,35 m (régua emergencial usada durante a
    própria enchente) — convertido pra série atual é **4,17 m** (5,35 −
    1,18), valor que a nota técnica da ANA cita explicitamente.
  A coluna `nota` (texto livre, pensada pra reaproveitar em qualquer outra
  estação que precisar de uma ressalva parecida) guarda essa explicação
  completa com as fontes, mostrada como ícone "ⓘ" ao lado da cota no card e
  como aviso no modal de histórico — pra quem cruzar com uma notícia que
  cita "3 metros" ou "5,35 m" não achar que a gente inventou um número
  diferente.
- **Status de saúde das fontes** (rodapé, `renderizarStatusFontes` em
  `public/index.html`; campo novo `ultimaPrevisao` em `/api/painel`, MAX
  de `previsoes.gerado_em`): mostra, à parte do frescor por estação, se as
  duas fontes externas (feed de nível do nivelguaiba.com.br e
  vazão/clima da Open-Meteo) estão respondendo — com limiares próprios pra
  cada uma (nível: ok ≤20min, atrasado ≤1h; previsão: ok ≤8h, atrasado
  ≤24h, já que ela só atualiza a cada 6h por design). Pensado pra flagrar
  rápido se uma fonte parar de vez, sem precisar abrir os 14 cards um por
  um.

### Interface do painel

- **Intro** (`#intro` em `index.html`, CSS puro em `painel.css` — sem JS
  além do clique pra pular): logo (ícone do PWA, `icons/icon-192.png`) +
  nome do projeto, entra escalonado e some sozinha em ~1,4s. Só em
  `index.html` — `bacia.html`/`acerto.html` normalmente são abertos a
  partir de lá, então repetir a intro ali seria repetitivo. Não atrasa o
  carregamento real: `carregar()` já roda em paralelo por baixo da
  animação. Clicar em qualquer lugar pula na hora; respeita
  `prefers-reduced-motion` (nem aparece, pra quem configurou o SO pra
  reduzir animação).
- **Tema claro/escuro**: segue `prefers-color-scheme` do sistema por padrão;
  o botão 🌙/☀️ no cabeçalho fixa uma preferência manual em `localStorage`
  (chave `tema`), que passa a valer independente do sistema.
- **Modo apresentação** (botão "🖥 Apresentação"): esconde controles
  secundários, aumenta os cards e tenta entrar em tela cheia
  (`requestFullscreen`) — se o navegador bloquear a tela cheia de verdade
  (permissão, iframe etc.), o resto do modo (cards maiores, menos
  distração) continua valendo mesmo assim. Sincroniza sozinho se a pessoa
  sair pelo ESC em vez de clicar no botão de novo.
- **Gerar PDF** (botão "🖨 Gerar PDF"): tira uma "foto" do painel inteiro
  (`html2canvas`) e encolhe pra caber numa página A4 só, mantendo as cores e
  o layout reais dos cards — em vez de imprimir em tamanho real e cortar em
  várias páginas.
- **PWA ("adicionar à tela inicial")**: `public/manifest.json` + `public/icons/`
  (ícone "gauge de nível" gerado — não é foto nem logo, é um desenho simples
  em SVG rasterizado) permitem instalar o painel como app no celular, com
  ícone e nome próprios em vez de aba do navegador. `index.html` e
  `bacia.html` linkam o mesmo manifest + tags da Apple (`apple-touch-icon`,
  `apple-mobile-web-app-*`), já que o iOS não segue o manifest sozinho pra
  isso. **De propósito não tem service worker** — então funciona bem pra
  "Adicionar à tela de início" (menu do navegador, manual) em Android e
  iOS, mas o banner automático "Instalar app" do Chrome/Android (que exige
  service worker) não deve aparecer sozinho. Cache offline ficaria pra uma
  extensão futura, se for necessário.
- **Mobile**: `header .acoes` (os botões do topo) e `header` de `bacia.html`
  usam `flex-wrap: wrap` — sem isso, o navegador no celular expandia a
  viewport inteira da página pra caber os 7 botões numa linha só (bug real,
  achado testando com Playwright em viewport de iPhone), o que empurrava a
  página inteira, inclusive os modais, pra fora da tela com scroll
  horizontal. `body`/`html` também têm `overflow-x: hidden` como rede de
  segurança contra qualquer elemento futuro que vaze da largura da tela.
  Há um `@media (max-width: 600px)` aumentando o alvo de toque dos botões
  (~36px → ~43px, perto da recomendação de 44px) e reduzindo a margem dos
  modais nessa faixa de largura.
- **Anel de progresso até a próxima coleta** (ao lado do texto "⏱ próxima
  coleta em..."): drena de cheio (acabou de coletar) pra vazio (hora da
  próxima), e muda de cor quando atrasa. Numa tela de monitor sem ninguém
  interagindo, ajuda a distinguir "tá tudo bem, só esperando a próxima
  leitura" de "isso travou" — mesma ideia visual do anel do
  enchentes.lab4ge.com, reimplementada do zero (SVG com `pathLength="100"`
  pra poder animar `stroke-dashoffset` em porcentagem direto).
- **Busca/filtro** (campo acima da grade de estações): filtra os cards por
  cidade, rio ou UF (substring, sem acentuação especial). Os KPIs do topo
  continuam refletindo **todas** as estações mesmo com filtro ativo — o
  filtro é só pra achar um card na tela, não um recorte do resumo geral.
- **KPI "Maior subida 24h"** (`variacao24hCm` em cada estação do
  `/api/painel`, calculado por `calcularVariacao24h` em `lib/calculo.js`):
  compara o nível atual com a leitura mais recente que já tem **pelo menos
  24h** (`referencia24hBruta` em `api/painel.js`) — não interpola nem pega a
  leitura mais próxima de qualquer lado; estação sem 24h de histórico ainda
  (ex.: recém-cadastrada) fica com `variacao24hCm: null` e é ignorada no
  ranking, em vez de mostrar uma janela que não é realmente de 24h. Só
  considera variações positivas pro destaque (não faz sentido "maior
  subida" ser uma descida).
- **Comparar estações** (botão "📊 Comparar estações" no cabeçalho): abre um
  modal com checkboxes das 14 estações, mesma janela de tempo do histórico
  individual (24h/3d/7d/30d), e desenha uma linha por estação selecionada no
  mesmo gráfico. Tem alternância "Nível (m)" / "% da cota" — comparar metros
  brutos entre rios diferentes engana (6m no Jacuí ≠ 6m no Guaíba), então o
  modo percentual normaliza pela `cota_inundacao` de cada estação. Exporta
  CSV combinado (`estacao,uf,rio,medido_em,nivel_m,percentual_cota`). Cada
  estação é buscada com sua própria chamada a `/api/historico` (sem rota
  nova no backend); o eixo X usa escala linear com epoch em ms em vez de
  categorias, porque os horários de leitura não coincidem exatamente entre
  estações diferentes. A seleção fica salva em `localStorage`.
- **Compartilhar** (📤 no card e no modal de histórico): monta um resumo em
  texto da estação (nível, tendência, margem pra cota, quando foi
  atualizado, link do painel) e entrega pro navegador decidir o canal — usa
  a Web Share API (`navigator.share`) quando disponível, que abre o menu
  nativo do celular (WhatsApp, SMS, e-mail, o que a pessoa escolher). Sem
  suporte (comum em desktop), cai pra copiar o texto na área de
  transferência, com feedback visual rápido no botão. Sem credencial, sem
  servidor mandando nada — só monta texto e usa API do próprio navegador.
- **Ajuda** (botão "❓ Ajuda" no cabeçalho): modal estático explicando o que
  cada ícone/cor/linha do painel significa (frescor, setas de tendência,
  estimativas ⏱/↩, badge da cheia de 2024, linhas do gráfico do histórico)
  — o app acumulou bastante coisa ao longo do tempo, isso ajuda quem não
  acompanhou tudo sendo construído.
- **Histórico de alertas** aparece no painel principal (não só no banco),
  puxando `/api/alertas` — até 30 mudanças de status mais recentes.
  `registrarAlertas` (`lib/coletar.js`) grava tanto a entrada num status de
  risco (atenção/alerta/alagado) quanto a **volta ao normal** — só não
  grava a primeira leitura de uma estação que já nasce normal (senão toda
  estação tranquila desde sempre ganharia uma linha "normal" à toa).
- **Exportar CSV**: no modal de histórico de uma estação, o botão gera o CSV
  no navegador a partir dos dados já carregados pro gráfico (`medido_em,
  nivel_m`) — não é uma rota nova no backend.
- **Recorde histórico** no gráfico de uma estação: `/api/historico` retorna
  `recorde` (maior nível já registrado, de toda a série — não só a janela
  aberta), desenhado como uma segunda linha tracejada além da cota.

## Testes

```bash
npm test
```

Usa o test runner nativo do Node (`node --test`), sem dependência nova.
Cobre as funções puras de `lib/calculo.js` (classificar, cm/h, frescor) e
`lib/feed.js` (parse do feed) — inclusive o caso do bug real que já
encontramos (nível sem casa decimal, tipo "1 metros"). Não testa rotas HTTP
nem acesso ao banco — essas dependem de `DATABASE_URL` e são verificadas
manualmente (`npm run coletar`, `curl` nos endpoints).

## Fontes dos dados

Feed agregador `nivelguaiba.com.br` (projeto voluntário da Mahalo Ventures),
que por sua vez consome telemetria pública da SGB/CPRM e da ANA. Para decisões
críticas, consulte sempre a Defesa Civil do RS.

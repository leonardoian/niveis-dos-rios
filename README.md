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
- **Notificações push** quando uma estação entra em risco ou volta ao
  normal — Web Push nativa do navegador, sem Telegram/Firebase.
- **Alerta de subida rápida** — avisa por ritmo (cm/h sustentados), não só
  quando um patamar de cota já foi cruzado.
- **Previsão de nível em metros** (experimental) — curva empírica ajustada
  com o histórico da própria estação, que transforma a vazão do modelo num
  número conferível, com o erro dela sempre ao lado.
- **Radar de chuva** opcional no mapa da bacia (RainViewer).
- **Página de confiança nas fontes** — uptime da coleta e comparação entre as
  duas fontes de nível (nivelguaiba × ANA oficial), pra saber onde as réguas
  concordam e onde divergem.

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
api/push.js                           inscrição/cancelamento de notificação push (POST/DELETE)
api/saude.js                          histórico de saúde da coleta (uptime por fonte, lacunas)
api/divergencia.js                    comparação nivelguaiba × ANA, por estação
api/curva.js                          acerto da previsão de nível, medido contra o nível real
lib/db.js                             conexão com o Neon
lib/feed.js                           leitura e parse do feed JSON
lib/coletar.js                        lógica de coleta em si (fetch + grava + alertas + previsão + estimativas + push)
lib/previsao.js                       busca vazão (GloFAS) e clima (Open-Meteo) por coordenada
lib/calculo.js                        funções puras (classificar, cm/h, frescor, ETA cota) — testadas em tests/
lib/push.js                           envio de notificação push (Web Push/VAPID) — testado em tests/
lib/ana.js                            cross-check com a API oficial da ANA — testado em tests/
lib/curva.js                          curva empírica vazão→nível (ajuste log-log) — testado em tests/
scripts/coletar-local.js              roda a coleta fora do Vercel (terminal, GitHub Actions etc.)
.github/workflows/coletar.yml         GitHub Actions: roda a coleta a cada 15 min, sem o Vercel
tests/                                testes automatizados (node --test, sem dependência nova)
public/index.html                     painel (estrutura HTML só; CSS/JS em css/ e js/)
public/bacia.html                     mapa da bacia (Leaflet) + hierarquia dos rios
public/acerto.html                    acerto da estimativa de cota, por antecedência
public/fontes.html                    saúde da coleta + divergência entre as duas fontes de nível
public/css/tema.css                   variáveis de cor (claro/escuro) — as 3 páginas carregam
public/css/base.css                   reset + estilos base (body, button, .rodape-fontes...) — as 3 páginas carregam
public/css/painel.css                 estilos só de index.html
public/css/bacia.css                  estilos só de bacia.html
public/css/acerto.css                 estilos só de acerto.html
public/css/fontes.css                 estilos só de fontes.html
public/js/tema.js                     toggle de tema claro/escuro — as 3 páginas carregam
public/js/comum.js                    hora(), ROTULOS, CORES, CONDICOES/condicaoTexto — as 3 páginas carregam
public/js/painel.js                   lógica só de index.html
public/js/bacia.js                    lógica só de bacia.html (inclui o toggle do radar de chuva)
public/js/acerto.js                   lógica só de acerto.html
public/js/fontes.js                   lógica só de fontes.html
public/js/push.js                     inscrever/cancelar notificação push — só index.html
public/sw.js                          service worker (só recebe push — sem cache/offline)
public/manifest.json                  PWA — nome, cores, ícones (pra "adicionar à tela inicial")
public/icons/                         ícones do PWA (gerados, ver nota abaixo)
schema.sql                            tabelas + carga inicial das 14 estações
```

Continua **sem build step** — os `<link rel="stylesheet">` e `<script src="...">` apontam direto pros arquivos em `css/`/`js/`, servidos como estático pelo Vercel, igual a qualquer outro arquivo em `public/`. Nenhum bundler, nenhum passo de compilação novo.

## Passo a passo

### 1. Banco (Neon)

Abra o SQL Editor do seu projeto no Neon e rode o conteúdo de `schema.sql`.
Isso cria as tabelas `estacoes`, `leituras` e `alertas`, e já insere as 14
estações com as cotas de inundação.

Confira:

```sql
SELECT cidade, rio, cota_inundacao FROM estacoes ORDER BY ordem;
```

Se o banco já existia antes de `lat`/`lon`/`previsoes` entrarem no schema, rodar
`schema.sql` de novo é seguro — todo o script é idempotente (`CREATE TABLE IF
NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO UPDATE`), então
completa o que faltar sem duplicar nem apagar nada que já está lá.

> **Rode o `schema.sql` de novo sempre que subir código que traga tabela ou
> coluna nova**, de preferência *antes* do deploy. Já aconteceu de o
> contrário derrubar o painel inteiro com HTTP 500: faltava `curvas_nivel`,
> tabela de uma feature experimental, e o `/api/painel` morria junto — o
> nível dos 14 rios sumia da tela por causa de um enfeite. Hoje as camadas
> opcionais do painel degradam sozinhas (ver "Camadas opcionais do painel"
> nas Notas), mas a migração continua sendo o passo certo.

### 2. Variáveis de ambiente no Vercel

Em Settings → Environment Variables, adicione:

| Nome                | Valor                                              |
| ------------------- | -------------------------------------------------- |
| `DATABASE_URL`      | a connection string do Neon (com `?sslmode=require`) |
| `CRON_SECRET`       | uma string aleatória qualquer                       |
| `VAPID_PUBLIC_KEY`  | opcional — só se quiser notificações push (ver abaixo) |
| `VAPID_PRIVATE_KEY` | opcional — idem, **nunca** commitar no repo         |
| `VAPID_SUBJECT`     | opcional — idem, formato `mailto:seuemail@exemplo.com` |
| `ANA_IDENTIFICADOR` | opcional — usuário da API da ANA, só pro cross-check (ver abaixo) |
| `ANA_SENHA`         | opcional — senha da API da ANA, **nunca** commitar no repo |
| `LIMIAR_CHUVA_6H_MM` | opcional, default `40` — mm acumulados na janela que disparam o alerta de chuva (ver abaixo) |
| `JANELA_CHUVA_HORAS` | opcional, default `6` — tamanho da janela usada nesse alerta |
| `LIMIAR_SUBIDA_CM_H` | opcional, default `15` — cm/h sustentados que disparam o alerta de subida rápida |
| `JANELA_SUBIDA_HORAS` | opcional, default `3` — janela usada pra medir esse ritmo |
| `RETENCAO_LEITURAS_DIAS` | opcional, **vazio = desligado** — apaga leitura crua acima de N dias (piso de 400). Ver a ressalva no README antes de ligar |

Gere o `CRON_SECRET` com: `openssl rand -hex 32`

Gere o par de chaves VAPID (necessário só se for usar notificações push) com:

```bash
npx web-push generate-vapid-keys
```

A chave **pública** também precisa ser colada em `public/js/push.js`
(constante `VAPID_PUBLIC_KEY` no topo do arquivo — não é secreta, só a
privada é). Sem essas 3 variáveis configuradas, o botão "🔔 Ativar
notificações" continua aparecendo mas a coleta simplesmente não envia nada
(feature opcional, não quebra o resto do sistema — ver nota mais abaixo).

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
2. **Se você usa as features opcionais, repita pros secrets delas.** As duas
   fontes rodam o mesmo `executarColeta()`, mas cada uma lê o ambiente do
   lugar onde roda: o que está no Vercel **não** chega ao GitHub Actions. Como
   toda feature opcional degrada em silêncio quando a variável falta (é o
   design — ver `lib/ana.js`/`lib/push.js`), o sintoma de esquecer é sutil:
   metade das coletas do dia grava chuva da ANA e dispara push, a outra
   metade não, sem erro em lugar nenhum. Os secrets são
   `ANA_IDENTIFICADOR`, `ANA_SENHA`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
   e `VAPID_SUBJECT`; `LIMIAR_CHUVA_6H_MM` e `JANELA_CHUVA_HORAS` não são
   segredo e vão na aba **Variables** ao lado (vazio = default do código).
   O workflow já referencia todos — só faltam os valores.
3. Pronto — o workflow já está no repo e roda sozinho a partir do próximo
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
{ "ok": true, "recebidas": 14, "inseridas": 14, "ignoradas": [], "alertas": [] }
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
| `GET /api/historico?slug=lajeado&horas=48` | série temporal de uma estação (inclui `chuvaAna`, chuva medida ANA na mesma janela) |
| `GET /api/alertas`                      | últimos 30 alertas — nível (`tipo='nivel'`) e chuva acumulada (`tipo='chuva'`) misturados por data |
| `GET /api/acerto`                       | acerto da estimativa de cota, por antecedência |
| `GET /api/saude`                        | saúde da coleta em 24h/7d: uptime por fonte, maior lacuna, última falha |
| `GET /api/divergencia?dias=30`          | diferença entre nivelguaiba e ANA por estação (mediana, oscilação, deriva) |
| `GET /api/curva?dias=90`                | erro da previsão de nível contra o nível medido, por estação |
| `GET /api/coletar`                      | força uma coleta (requer o header) — 502 se o feed de nível estiver fora, com o corpo dizendo o que as outras fontes conseguiram fazer |
| `POST /api/push`                        | inscreve/atualiza a notificação push (`{endpoint, keys:{p256dh,auth}, slugs?}` — `slugs` ausente = todas) |
| `DELETE /api/push`                      | cancela a inscrição (`{endpoint}`)  |

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

**Nota sobre `/api/push`** (adicionado depois desta revisão): diferente de
`/api/coletar`, é uma rota pública de propósito — qualquer visitante pode se
inscrever pra notificação, igual um formulário de "avise-me" comum, sem
segredo nem sessão. Não tem rate limit — risco aceito dado o porte do
projeto (uso interno, sem tráfego público relevante); se isso mudar, o
próximo passo seria limitar por IP.

### Segunda rodada de revisão

Uma verificação posterior do repositório inteiro (testes, dependências,
frontend nas 3 páginas com a CSP real aplicada, e a coleta ponta a ponta
com banco e feed simulados) achou mais isto, tudo já corrigido:

- **SSRF pelo `endpoint` de `/api/push`.** A validação antiga só conferia
  que `endpoint`/`keys.p256dh`/`keys.auth` estavam presentes — e o
  `endpoint` é depois requisitado **pelo nosso servidor**, a cada alerta,
  pra sempre. O `web-push` só checa que é string não-vazia
  (`web-push-lib.js:91`), não o host: dava pra registrar
  `http://169.254.169.254/latest/meta-data/` ou qualquer host interno e
  virar um SSRF cego com repetição automática. Agora `endpointPermitido()`
  (`lib/push.js`, pura e testada) exige HTTPS num dos quatro serviços de
  push reais — `fcm.googleapis.com`, `web.push.apple.com`,
  `*.push.services.mozilla.com`, `*.notify.windows.com` — e o mesmo filtro
  roda **de novo na saída**, em `enviarNotificacoesAlerta()`, pra cobrir
  linhas gravadas antes da allowlist existir. `endpoint`/`p256dh`/`auth`
  também ganharam limite de tamanho.
- **`erro.message` cru no corpo dos 500.** As 4 rotas públicas de leitura
  (`painel`/`historico`/`alertas`/`acerto`) devolviam a mensagem do driver
  do Neon — que pode citar nome de tabela/coluna e detalhe de conexão — pra
  quem chamasse direto. Agora o corpo é `{"erro":"Falha interna."}` e o erro
  real fica só no `console.error` (logs do Vercel). Sem mudança visível no
  front, que nunca leu esse campo (usa `'HTTP ' + status`). `/api/coletar`
  mantém a mensagem real de propósito: exige o `CRON_SECRET`, e quem chama
  é o operador.
- **`api/push.js` era o único handler sem `try/catch`.** Uma falha de banco
  virava rejeição não tratada e `FUNCTION_INVOCATION_FAILED` opaco, em vez
  do JSON de erro que as outras 5 rotas devolvem.
- **Workflow sem `permissions:`.** `.github/workflows/coletar.yml` herdava o
  default do repositório; agora declara `permissions: {}`, já que o job só
  precisa de rede de saída.

E dois problemas de robustez, não de segurança:

- **O feed de nível derrubava a coleta inteira.** `executarColeta()` abria
  com um `await buscarFeed()` cru, e `buscarFeed()` lança em qualquer HTTP
  não-2xx. Resultado: com o feed em 403/500, a função morria na primeira
  linha e **nenhuma** query chegava a rodar — previsão (Open-Meteo) e
  cross-check da ANA, que não dependem do feed pra absolutamente nada,
  ficavam de fora junto, justo quando uma fonte alternativa é mais útil.
  Contradizia o próprio comentário logo abaixo ("Independe do feed de nível
  ter respondido ou não"). Agora a falha é capturada, vira `erroFeed` no
  resultado, e o resto da coleta segue. O caminho de feed que responde
  **vazio** já era tratado e continua igual (`ok: true` + aviso) — é uma
  coleta bem-sucedida sem novidade, coisa diferente de fonte fora do ar.
- **Sinal de monitoramento preservado.** Como a coleta agora não explode
  mais, `/api/coletar` poderia passar a devolver 200 sempre e o agendador
  externo nunca mais alertaria. Pra não trocar um bug por outro, a rota
  devolve **502** quando `ok: false`, com o corpo completo — o operador
  continua sendo avisado, e a resposta diz o que as outras fontes
  conseguiram fazer apesar da falha.
- **Secrets faltando no GitHub Actions.** O workflow passava só
  `DATABASE_URL`, então a Fonte B rodava uma coleta silenciosamente menor
  que a Fonte A (sem ANA, sem alerta de chuva, sem push). Ver o passo 2 da
  seção de agendamento.

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
  em `public/js/painel.js`, usada tanto no card quanto no modal de histórico):
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
  mesma conta reimplementada nos dois lados, já que `public/js/painel.js` é
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
    leitura real da estação estava do outro lado do `alvo_nivel` dentro da
    **janela de acerto** `[alvo_em − tolerância, alvo_em + tolerância]` — a
    tolerância vale dos dois lados. Estava = "acertou"; não estava = "errou".
    Três situações contam como erro, igual: ainda não tinha chegado lá; a
    tendência reverteu antes; ou chegou cedo demais e já tinha ido embora
    quando a hora prevista veio. Nas três, na hora H a estimativa não teria
    ajudado quem confiasse nela.
  - `erro_horas` mede o cruzamento **real** (o primeiro depois do cálculo,
    não o primeiro dentro da janela) contra o horário previsto — negativo =
    adiantado. Então um "acertou" pode vir com `erro_horas = −39`: o rio
    chegou muito antes do estimado e ainda estava lá na hora prevista. O
    resultado foi acertado, o ritmo não; medir só dentro da janela faria
    todo acerto adiantado aparecer como exatamente `−tolerância`, escondendo
    o tamanho do erro.
  - **Correção posterior:** a janela de acerto era `[previsto_em, alvo_em +
    tolerância]`, ou seja, sem limite adiantado nenhum — qualquer cruzamento
    depois do cálculo contava. Uma estimativa de 40h cujo rio tocou o alvo 1h
    depois e recuou era registrada como "acertou" com `erro_horas ≈ −39`,
    inflando justamente a faixa "mais de 24h", que é onde a página existe pra
    mostrar a extrapolação falhando. A `public/acerto.html` sempre descreveu
    "±20% do horizonte" — era o código que não fazia isso. As linhas
    avaliadas **antes** dessa correção mantêm o veredito antigo (o campo
    `avaliado_em` não é recalculado), então a taxa das faixas longas deve
    cair aos poucos, conforme as avaliações novas entram. Se quiser zerar de
    uma vez: `UPDATE estimativas_cota SET avaliado_em = NULL, resultado =
    NULL, erro_horas = NULL, nivel_real_no_alvo = NULL;` — a próxima coleta
    reavalia tudo com o critério novo, desde que as `leituras` da época ainda
    estejam no banco.
  - O veredito em si é `avaliarEstimativa` em `lib/calculo.js` — pura, sem
    I/O, coberta por `tests/calculo.test.js`. `avaliarEstimativasCota` em
    `lib/coletar.js` só busca as leituras e grava o resultado.
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
- **Chance de chuva** (`chanceChuvaPct`, `precipitation_probability_max` da
  Open-Meteo) vem na mesma chamada de clima, sem custo extra — 0 a 100%,
  `NULL` quando a API não retorna esse campo pro dia.

### Aba "Previsão do tempo" no modal

Cada estação, no modal de histórico, tem duas abas: "Nível" (gráfico de
nível medido, igual sempre foi) e "Previsão do tempo" (card de 7 dias —
ícone da condição, temp. máx/mín, chuva prevista e chance de chuva, mais a
tendência de vazão que já existia). Sempre abre na aba "Nível". Dado 100%
Open-Meteo, mesmo já usado no resto do painel — não é um serviço novo.

### Radar de chuva

Camada opcional no mapa da bacia (botão "🌧 Radar de chuva", desligada por
padrão pra não gastar uma chamada de API à toa em quem só quer ver o mapa
das estações). Usa a API pública e gratuita do
[RainViewer](https://www.rainviewer.com/) — sem chave, sem cadastro:
`GET https://api.rainviewer.com/public/weather-maps.json` retorna os frames
disponíveis, o mais recente vira uma camada de tile no Leaflet. Zoom nativo
do radar é 7 (o mapa abre em 8) — acima disso o Leaflet faz upscale
automático da imagem, não é bug se ficar um pouco mais "pixelado" no zoom
máximo. Atualiza sozinho a cada ~10 min enquanto ligado.

### Chuva prevista no mapa

Segunda camada opcional no mapa da bacia (botão "🌦️ Chuva prevista" — ícone
diferente do radar de propósito, pra não confundir os dois), também
desligada por padrão. Não é um mapa de precipitação real (não temos fonte
própria de raster pra isso) — são círculos por estação, coloridos pela soma
da chuva prevista (Open-Meteo, mesmo campo `previsao[].chuvaMm` do resto do
painel) nos próximos 1/2/3/5/7 dias (seletor ao lado do botão). Escala fixa
em mm absolutos (não muda com o período, então trocar de 1d pra 7d
"molha" visivelmente mais o mapa) — 5 tons de azul, propositalmente longe
da paleta de status (verde/laranja/vermelho) pra não confundir as duas
informações. Círculos ficam sempre atrás dos marcadores de nível
(`bringToBack`) e não capturam clique (`interactive:false`) — servem de
contexto, não substituem os marcadores de status. Sem chamada de API extra:
reaproveita o mesmo `/api/painel` que o resto do mapa já busca a cada 5 min.

### Notificações push

Botão "🔔 Ativar notificações" no painel principal — avisa quando **qualquer**
uma das 14 estações entra em risco (atenção/alerta/alagado) ou volta ao
normal, mesmo critério que já popula o histórico de alertas (`registrarAlertas()`
em `lib/coletar.js`). Decisões de escopo (V1, deliberadas):

- **Preferência por estação** (botão "⚙️ Estações", que só aparece com a
  notificação ligada): coluna `slugs` em `push_subscriptions`, `NULL` =
  todas. `NULL` em vez de um array com as 14 de propósito — "não escolheu" é
  diferente de "escolheu todas", e só o primeiro deve passar a receber
  automaticamente de uma estação nova que entre no painel depois. Marcar
  todas, ou nenhuma, normaliza pra `NULL` nos dois lados (front e API), pra
  "todas" ter uma representação só no banco.
- **Notifica entrada em risco E volta ao normal** — não só "piorou".
- **Vale pros três tipos** (🌊 nível, 🌧️ chuva, 📈 subida): o filtro é por
  estação, não por tipo de aviso.

Implementação é Web Push nativa do navegador (Service Worker +
`PushManager` + VAPID) — **sem** Telegram, Firebase ou qualquer conta em
serviço terceiro. `lib/push.js` assina e envia direto pro serviço de push de
cada navegador (a lib `web-push` cuida da criptografia); `public/sw.js` só
existe pra receber o evento `push` e mostrar a notificação — não faz cache
de nada (cache agressivo numa ferramenta de tempo real seria pior que não
ter nada: mostraria nível desatualizado como se fosse atual). A feature é
opcional de propósito: sem as 3 variáveis `VAPID_*` configuradas no Vercel
(ver seção de variáveis de ambiente acima), `enviarNotificacoesAlerta()`
simplesmente não faz nada — não derruba a coleta.

Uma inscrição expirada (o navegador revogou, cache limpo etc.) é detectada
pelo próprio envio (`web-push` retorna 404/410) e apagada automaticamente
de `push_subscriptions` — sem faxina manual.

Três detalhes da preferência por estação que são decisões:

- **O `INSERT` virou `DO UPDATE`.** Reinscrever o mesmo navegador é como a
  pessoa *muda* a preferência — com o `DO NOTHING` de antes, a troca era
  silenciosamente ignorada e ela seguia recebendo o que tinha antes.
- **Slug desconhecido é recusado com 400**, não gravado. Uma preferência com
  slug digitado errado viraria uma inscrição que nunca recebe nada, e
  silêncio é indistinguível de "não houve alerta".
- **Alerta sem `slug` vai pra todo mundo** (`alertaInteressa` em
  `lib/push.js`): formato antigo ou origem que não identifica a estação.
  Melhor notificar demais que engolir um aviso de cheia por detalhe de
  formato.

Não existe `GET /api/push`, de propósito: exporia a preferência de qualquer
endpoint a quem soubesse a URL dele. O modal usa `localStorage` só pra não
abrir vazio — a fonte da verdade é o banco, que é quem o envio consulta.

### Cross-check com a API oficial da ANA

`lib/ana.js` busca, a cada coleta, **as 48h inteiras de telemetria**
(`DIAS_2`) de 12 das 14 estações direto da API oficial da ANA
(`hidrowebservice`, `HidroinfoanaSerieTelemetricaAdotada`) e grava numa
tabela separada,
`leituras_ana` — que **não substitui** a fonte principal
(`nivelguaiba.com.br`, via `lib/feed.js`).

Duas colunas, dois papéis, e vale não confundir: o **`nivel`** da ANA é
puro cross-check — nunca entra no cálculo de nível/status/alerta, é só um
registro pra comparar as duas fontes ao longo do tempo antes de considerar
qualquer mudança maior — comparação que agora existe de verdade, em
`/fontes` (ver seção própria). Já a **`chuva_mm`** *é* lida pelo painel (ver
"Chuva medida" logo abaixo): alimenta `chuvaMedidaAnaMm`/`frescorAna` em
`/api/painel`, `chuvaAna` em `/api/historico` e o alerta `tipo='chuva'` —
sempre rotulada "(ANA)" e em linha separada da previsão.

- **Por que só 12 das 14**: `lajeado` e `rocasales` ficaram de fora porque
  o inventário oficial da ANA não deu uma resposta inequívoca pra elas —
  a única estação telemétrica achada pra Lajeado está registrada no Rio
  Forqueta (não no Rio Taquari, que é o que `schema.sql` documenta pra
  essa estação), e não existe estação telemétrica própria no município de
  Roca Sales, só uma estação combinada "Encantado/Roca Sales" sob o
  município de Encantado. Preferimos deixar de fora a mostrar um código
  errado — mesmo critério já usado pra outros dados duvidosos no projeto
  (ver nota do `nivel_cheia_2024` de Roca Sales mais abaixo).
- **Datum/régua**: pra cada cidade que tem duas redes telemétricas
  paralelas (uma operada pela SGB-CPRM, que é a mesma operadora já
  confirmada pra Porto Alegre, e outra mais nova operada por "DCRS"), o
  código escolhido é sempre o da rede SGB-CPRM/ANA — mas isso não é
  garantia de que a régua bate exatamente com a do `nivelguaiba.com.br`
  pra todas elas (só validamos isso a fundo pra Porto Alegre). É
  exatamente esse tipo de coisa que o cross-check existe pra revelar antes
  de confiar.
- **Autenticação**: a API usa um endpoint próprio (`OAUth/v1`, headers
  `Identificador`/`Senha`) que devolve um JWT de curta duração (~1h).
  `lib/ana.js` reautentica a cada rodada de coleta em vez de tentar
  cachear o token entre execuções — funções serverless não compartilham
  memória de forma confiável entre invocações, e uma chamada GET a mais a
  cada 15 min é barato.
- Opcional de propósito: sem `ANA_IDENTIFICADOR`/`ANA_SENHA` configuradas,
  `buscarNiveisAna()` retorna vazio sem erro — não derruba a coleta.

**Por que guardar as 48h e não só a leitura mais recente:** a API devolve
~192 registros por estação no mesmo payload, e o código antigo ficava com
**um** e descartava os outros ~191 — dado já entregue, de graça. Guardar
tudo (o `INSERT` já era idempotente por `(slug, medido_em)`) dá três coisas:
série da ANA na resolução real da estação em vez de amostrada pela nossa
cadência de coleta; **retroativo de 48h que tapa buraco quando o feed do
nivelguaiba fica fora** — antes essas horas sumiam pra sempre; e chuva
acumulada calculada sobre as leituras de verdade da janela, não sobre uma
amostra delas.

Isso muda o custo da gravação: ~2300 linhas por rodada em vez de 12. Por
isso `registrarLeiturasAna` faz **bulk insert via `UNNEST`**, um comando só,
em vez de um `INSERT` por leitura — o driver da Neon é HTTP, cada `sql` é
uma requisição, e em loop isso seria ~2300 round-trips a cada 15 min. Da
segunda rodada em diante quase tudo já está lá e o `ON CONFLICT DO NOTHING`
não insere nada. O bulk também exige filtrar slugs desconhecidos antes de
mandar: `leituras_ana` tem FK pra `estacoes`, e um comando único falha
inteiro se **uma** linha violar — diferente do loop, onde uma linha ruim
derrubava só a si mesma.

Além do nível, a mesma resposta da ANA já traz `Chuva_Adotada` — chuva
acumulada **medida** na própria estação, diferente da previsão do
Open-Meteo. Isso alimenta três coisas no painel, todas só nas 12 estações
com código ANA mapeado (`lajeado`/`rocasales` ficam de fora, mesmo motivo
acima):

- **Chuva medida no card e no popup do mapa** (💧 X mm medidos na estação):
  campo `chuvaMedidaAnaMm` em `/api/painel`, sempre rotulado "(ANA)" e numa
  linha separada da previsão, pra nunca conflar medição real com modelo.
- **Gráfico chuva × nível** no modal de histórico de cada estação: barras
  de chuva medida (eixo direito, mm) sobrepostas à linha de nível (eixo
  esquerdo, m), na mesma janela de tempo já selecionada (24h/3d/7d/30d).
  `/api/historico` retorna `chuvaAna: [{chuvaMm, medidoEm}]`; o frontend
  encaixa cada leitura de chuva no rótulo de nível mais próximo
  (`alinharChuvaAosLabels` em `public/js/painel.js`) porque as duas fontes
  não leem no mesmo instante. Valores brutos (não delta) — se `Chuva_Adotada`
  reinicia periodicamente (não confirmado ao vivo), uma queda brusca na
  barra não significa chuva negativa, só um possível reinício da contagem
  da própria ANA (aviso disso aparece abaixo do gráfico quando a barra existe).
- **Alerta de chuva acumulada** (`registrarAlertasChuva()` em
  `lib/coletar.js`), independente do alerta de nível: soma os deltas
  positivos de `chuva_mm` entre leituras consecutivas na janela
  `JANELA_CHUVA_HORAS` (default 6h) — ignora quedas em vez de subtrair,
  pra funcionar tanto se o valor for um total corrido quanto se reiniciar
  em algum horário. Cruzando `LIMIAR_CHUVA_6H_MM` (default 40mm, ajustável
  sem redeploy), grava uma linha em `alertas` com `tipo='chuva'` — mesma
  tabela do alerta de nível, discriminada por essa coluna pra nunca
  misturar o dedup de um com o do outro — e dispara push
  (`🌧️ <cidade>` / "Xmm em Yh — atenção"). Segue exatamente o mesmo
  critério de dedup do alerta de nível: só notifica na transição de
  status, não a cada rodada de coleta enquanto o valor continuar alto.
- **Badge de frescor por fonte** no card (`ANA: há X min`, ao lado do
  frescor principal já existente): mostra a idade da leitura ANA mais
  recente, independente da leitura do nivelguaiba. Puramente informativo
  nesta fase — não substitui o número principal nem alimenta
  status/alerta (ver ressalva de datum acima); serve só pra notar quando
  uma fonte ficou defasada em relação à outra.

### Camadas opcionais do painel

`/api/painel` separa o que é **núcleo** do que é **enriquecimento**. Núcleo:
nível, cota, status, velocidade, série recente. Enriquecimento: previsão,
curva vazão→nível, chuva medida da ANA, frescor por fonte.

Só o núcleo é fatal. Cada camada de enriquecimento passa por um helper
`opcional()` que captura a falha, loga qual camada caiu e segue com vazio.

Isso veio de um incidente real: o código novo subiu antes do `schema.sql`, e
o painel inteiro respondeu 500 porque faltava `curvas_nivel` — a tabela de
uma feature *experimental*. Num monitor de cheia isso é o pior resultado
possível: o dado crítico sumiu da tela por causa de um enfeite que nem
estava pronto pra ser usado.

O critério agora é explícito: **o nível dos rios tem que aparecer mesmo com
todo o resto quebrado.** Se a previsão, a curva ou a ANA falharem — por
tabela ausente, coluna nova, credencial faltando ou API fora — o card
continua mostrando nível, cota e status, e o log diz exatamente o que caiu.

A consulta principal continua fatal de propósito: sem ela não existe painel
nenhum pra degradar, e mascarar isso com um 200 vazio seria pior que o 500.

### Volume de dados: rollup horário e retenção

`leituras` cresce ~1.344 linhas/dia (14 estações × 96 coletas) — cerca de
**490 mil por ano** — e `/api/painel` faz window function sobre a tabela
inteira. Duas coisas pra isso não virar problema:

**Rollup horário** (`leituras_horarias`, preenchido a cada coleta): min,
máx, média e contagem por estação-hora. `atualizarRollup` só recalcula as
últimas 3 horas, não a tabela inteira — só as horas recentes mudam, já que
retroativo da ANA vai pra `leituras_ana`, não pra `leituras`.

`/api/historico` passa a usar o rollup acima de 7 dias de janela: 90 dias em
bruto são ~8.600 pontos por estação, mais do que a tela resolve e caro de
trazer a cada abertura de modal. **O agregado devolve o MÁXIMO da hora, não
a média** — numa escala de semanas é o pico da cheia que importa, e a média
horária o suavizaria justamente onde ninguém quer suavização. A resposta traz
`resolucao: 'bruto' | 'horario'` e o modal avisa na tela quando está
mostrando máximo horário, em vez de deixar o leitor supor que cada ponto é
uma medição.

Guardar min *e* máx (e não só a média) é pelo mesmo motivo: a média horária
sozinha esconderia o pico, que é a informação que mais importa nessa escala.

**Retenção de dado bruto** (`RETENCAO_LEITURAS_DIAS`): **desligada por
padrão, e isso é deliberado.** Apagar leitura crua é irreversível, e nenhum
default deveria fazer isso sozinho no banco de ninguém. Só age se a variável
for definida explicitamente. Mesmo assim há duas travas:

1. **Piso de 400 dias.** Pedir menos não é obedecido — a janela máxima de
   `/api/historico` é 90 dias e a curva vazão→nível ajusta sobre 1 ano;
   retenção curta quebraria as duas em silêncio. O código eleva ao piso e
   loga o aviso.
2. **Só apaga hora que já está no rollup** (`EXISTS` no `DELETE`). O rollup
   é o que sustenta a série longa depois que o bruto some; apagar antes de
   agregar perderia o dado de vez.

Na prática: o rollup resolve o custo de consulta sozinho, sem apagar nada. A
retenção só faz sentido se o limite de armazenamento do Neon apertar.

### Previsão de nível: a curva empírica (experimental)

O README sempre disse — e continua verdade — que converter vazão em nível
"de verdade" exige a curva-chave da estação, que não temos. **Isto não é
uma curva-chave.**

É uma regressão sobre dado que já estava no banco: para cada dia passado, a
vazão que o GloFAS estimou pra aquele dia (`previsoes.vazao_m3s`, que fica
guardada mesmo depois do dia vencer) contra o nível que a estação
**realmente mediu** (média diária de `leituras`). O que ela ajusta é a
composição de duas coisas: a relação física vazão-nível daquela régua **e** o
viés do modelo naquele ponto da grade. Fisicamente é impuro. Mas o objetivo
não é interpretação física, é valor preditivo: *"quando o GloFAS diz 800
m³/s aqui, esta estação historicamente marcou ~12 m"*.

**O ganho real não é a conveniência de ler em metros — é auditabilidade.** A
vazão prevista é hoje o único número do painel que não dá pra conferir: não
temos medição independente de vazão, só outro resultado do mesmo modelo, e
comparar modelo com modelo não é validação (é exatamente o argumento que a
página `/acerto` já usava pra se recusar a avaliar vazão). Convertida em
nível, ela vira falsificável — nível a gente mede. É isso que
`GET /api/curva` e o terceiro bloco de `/fontes` mostram: erro médio, erro
mediano e **viés com sinal** de cada estação, contra o que aconteceu.

Viés separado do erro absoluto de propósito: uma curva que erra ±30 cm pra
cima e pra baixo é coisa diferente de uma que erra 30 cm **sempre** pra
cima — a segunda dá pra corrigir.

Detalhes de implementação que são decisões, não acidentes:

- **Lei de potência ajustada em log-log** (`h = a·Q^b` vira reta sobre
  `ln Q × ln h`): mínimos quadrados de solução fechada, sem iteração e sem
  dependência nova. Dois parâmetros só, de propósito — com poucas dezenas de
  pontos diários e ruído dos dois lados, um modelo mais flexível decoraria
  o ruído em vez da relação.
- **Não extrapola.** `estimarNivel` devolve `null` quando a vazão está fora
  da faixa em que a curva foi ajustada. É onde uma lei de potência erra
  feio — e numa cheia, justamente quando importa, erraria pra cima. Por isso
  é normal alguns dias da previsão aparecerem sem `≈ m`; o rodapé no modal
  explica isso em vez de deixar o buraco sem justificativa.
- **Só publica com lastro**: mínimo de 30 pares e R² ≥ 0,5
  (`MINIMO_PARES`/`MINIMO_R2` em `lib/curva.js`). Abaixo disso a curva é
  ajustada e guardada, mas não vira número na tela. No começo, a maioria das
  estações vai estar assim — e é assim que tem que ser.
- **O número nunca aparece sozinho.** O rodapé do modal traz sempre n, R² e
  erro médio junto do `≈ m`. Mostrar "≈ 12,40 m" sem dizer que a curva erra
  ±0,45 m em média convidaria a confiar mais do que o número aguenta.
- **`nivel_estimado_m` é o único campo do `INSERT` de previsões sem
  `COALESCE`.** Se a curva deixou de ser confiável, o certo é apagar a
  estimativa antiga, não preservá-la — manter um número que o modelo atual
  não sustenta é pior que não mostrar nada.
- **Reajuste 1x/dia**, janela de 1 ano. Os pares são médias diárias, então
  reajustar mais de uma vez por dia refaria a mesma conta; e 1 ano cobre
  estiagem e cheia (a curva precisa das duas pontas pra ter faixa útil) sem
  arrastar dado que talvez nem reflita a régua atual — a recalibração de
  2024 em Porto Alegre é o lembrete de que régua muda.
- **A avaliação não precisou de tabela nova.** `previsoes` guarda linhas de
  dias passados com o `nivel_estimado_m` que valia na época, e `leituras`
  tem o que aconteceu: é uma query sobre dado que já existe.

### Alerta de subida rápida

Terceiro eixo de alerta, independente dos outros dois. O alerta de nível
reage a **patamar** (60/80/100% da cota) e o de chuva reage a **entrada de
água**; este reage a **ritmo**.

O motivo: um rio a 40% da cota subindo 20 cm/h sustentados é mais urgente
que um parado a 85%. O primeiro chega na cota hoje; o segundo pode ficar
onde está por uma semana. Sem isso, o sistema só avisava **depois** que o
patamar tinha sido cruzado — que é tarde pra quem precisa tirar coisa do
chão.

Usa `calcularSubidaSustentada` (`lib/calculo.js`), que mede entre as pontas
de uma janela de horas (`JANELA_SUBIDA_HORAS`, default 3h) — **não**
`calcularVelocidade`, que usa as duas últimas leituras. Essa distinção é o
ponto todo: o README já documentava que a velocidade instantânea "pode
ficar zerada mesmo com uma tendência clara ao longo do dia (flutuação
normal do instrumento entre duas leituras consecutivas)". Ruído tolerável
num número exibido no card; inaceitável pra disparar notificação, porque
alertaria por oscilação de instrumento e ficaria calado numa subida real e
constante.

Devolve `null` — e não alerta — quando a janela tem cobertura menor que
metade do pedido (estação nova, ou buraco de coleta): melhor não afirmar
ritmo do que dividir uma diferença real por um intervalo que não
representa a janela.

Grava em `alertas` com `tipo='subida'` e `velocidade_cm_h`, seguindo
exatamente o mesmo dedup por transição de status dos outros dois tipos —
só notifica quando o status **muda**, não a cada rodada enquanto o rio
continua subindo. O push usa emoji próprio (`📈 <cidade>` / "subindo X cm/h
nas últimas Yh"): na tela de notificação do celular o título é quase tudo
que se lê, e 🌊/🌧️/📈 já dizem qual dos três eixos disparou antes de abrir.

### Página de confiança nas fontes (`/fontes`)

Responde duas perguntas que o painel não respondia, e que são bem diferentes
uma da outra:

**1. A coleta está rodando?** (`GET /api/saude`, tabela `coletas`) — cada
rodada de `executarColeta()` grava uma linha com feed OK/erro, se a ANA
respondeu, quantas leituras entraram, quantos alertas saíram e quanto
demorou. O painel já mostrava `frescor`, mas frescor diz se o dado está
velho **agora**; isso aqui diz se aquilo é um soluço ou o terceiro do dia —
e distingue "o feed falhou" de "o feed respondeu e não tinha novidade", que
o painel não tem como separar (`leituras_inseridas = 0` é rotina, o feed não
atualiza toda estação a cada 15 min).

Além do uptime por fonte em 24h/7d, mostra a **maior lacuna entre duas
rodadas** na janela — é o número que revela "ficou 3h sem coletar", que
nenhuma média mostra. Só é sinalizada como anormal acima de 3× o intervalo
agendado, porque o GitHub Actions atrasa alguns minutos rotineiramente.
`ana_ok` é `NULL` quando as credenciais da ANA não estão configuradas:
ausência de feature opcional não é falha, e some da conta em vez de puxar a
taxa pra baixo.

**2. As duas fontes de nível concordam?** (`GET /api/divergencia`) — essa é a
razão de `leituras_ana` existir. O schema sempre disse que a tabela servia
"pra comparar as duas fontes ao longo do tempo antes de considerar qualquer
mudança maior", mas **nada lia a coluna `nivel`**: ela era gravada a cada 15
min e nunca olhada. Agora vira informação.

O emparelhamento é por **bucket de hora**, não por "leitura mais próxima":
as duas fontes não medem no mesmo instante nem na mesma cadência, e casar a
mais próxima criaria pares com defasagem variável — num rio subindo rápido,
20 min de defasagem viram centímetros que não são divergência de régua, são
desencontro de horário. A média horária de cada fonte tira esse ruído.

Três números por estação, e o veredito sai da combinação deles:

| Veredito | O que significa |
| --- | --- |
| **concordam** | diferença mediana ≤ 5 cm — as duas réguas leem o mesmo |
| **offset estável** | diferença grande mas constante: é datum diferente, não erro (o caso do Gasômetro, ver nota em `schema.sql`) |
| **oscila** | o miolo p10–p90 passa de 15 cm: não é offset de régua, é discordância real |
| **derivando** | a mediana da metade recente difere da antiga em ≥ 10 cm — alguma coisa mexeu numa das réguas no meio do caminho |
| **dado insuficiente** | menos de 24h pareadas |

Os limiares ficam no topo de `public/js/fontes.js`, não escondidos no meio
da lógica — são escolha nossa de leitura, não algo que veio do dado, e
mudar um deles não deveria exigir caçar onde está.

Isso responde direto à ressalva documentada estação por estação em
`ESTACOES_ANA` ("escolhemos a rede SGB-CPRM, mas só validamos a régua a
fundo pra Porto Alegre"). As cores dos vereditos são deliberadamente
**fora** da paleta de status do painel: aqui é qualidade de dado, não risco
de enchente, e confundir as duas leituras seria pior que não ter cor.

As 2 estações sem código ANA (`lajeado`, `rocasales`) aparecem numa nota
explícita de "sem comparação **por decisão**, não por falha" — pra a página
não parecer que perdeu dado.

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
  `public/js/painel.js`; campo novo `ultimaPrevisao` em `/api/painel`, MAX
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
  isso. O único service worker é o `public/sw.js`, registrado por
  `public/js/push.js` **apenas quando a pessoa ativa as notificações** — e
  ele só trata os eventos `push`/`notificationclick`, **sem cache de nada**
  (cache agressivo numa ferramenta de tempo real mostraria nível
  desatualizado como se fosse atual). Como não há handler de `fetch`, o
  banner automático "Instalar app" do Chrome/Android pode não aparecer
  sozinho; "Adicionar à tela de início" pelo menu do navegador funciona
  normalmente em Android e iOS. Cache offline ficaria pra uma extensão
  futura, se for necessário.
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

Usa o test runner nativo do Node (`node --test`), sem dependência nova de
teste. Cobre as funções puras de `lib/calculo.js` (classificar, cm/h,
frescor), `lib/feed.js` (parse do feed) — inclusive o caso do bug real que
já encontramos (nível sem casa decimal, tipo "1 metros") — e `lib/push.js`
(payload da notificação, detecção de inscrição expirada). Não testa rotas
HTTP nem acesso ao banco — essas dependem de `DATABASE_URL` e são
verificadas manualmente (`npm run coletar`, `curl` nos endpoints). Por isso
`lib/push.js` importa `./db.js` de forma tardia (dentro da função, não no
topo do arquivo) — um import no topo quebraria a suite, já que `db.js`
lança erro se `DATABASE_URL` não estiver definida.

## Fontes dos dados

Feed agregador `nivelguaiba.com.br` (projeto voluntário da Mahalo Ventures),
que por sua vez consome telemetria pública da SGB/CPRM e da ANA. Para decisões
críticas, consulte sempre a Defesa Civil do RS.

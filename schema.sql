-- ============================================================
-- Sistema de Monitoramento de Níveis dos Rios — Bacia do Guaíba
-- Banco: Neon (PostgreSQL)
-- Execute este script uma vez no SQL Editor do Neon.
-- ============================================================

-- Tabela de configuração das estações monitoradas.
-- A cota de inundação NÃO vem do feed — é constante e fica aqui.
CREATE TABLE IF NOT EXISTS estacoes (
    slug            TEXT PRIMARY KEY,          -- chave do feed: portoalegre, lajeado...
    cidade          TEXT NOT NULL,
    uf              CHAR(2) NOT NULL DEFAULT 'RS',
    rio             TEXT NOT NULL,
    estacao         TEXT,                       -- nome da estação telemétrica
    cota_inundacao  NUMERIC(6,2) NOT NULL,      -- em metros
    ordem           INT NOT NULL DEFAULT 0,     -- ordem de exibição no painel
    ativa           BOOLEAN NOT NULL DEFAULT TRUE,
    lat             NUMERIC(9,6),               -- sede da cidade (fonte: Wikipédia), usada na previsão de vazão
    lon             NUMERIC(9,6),
    nivel_cheia_2024 NUMERIC(7,2),              -- pico da enchente de maio/2024, mesma régua da estação
    data_cheia_2024  DATE,                      -- NULL quando não há registro consolidado confiável
    nota             TEXT                       -- ressalva livre sobre a régua/cota dessa estação (ver Porto Alegre)
);

-- Idempotente: garante as colunas em bancos que rodaram este script antes
-- delas existirem.
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6);
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS lon NUMERIC(9,6);
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS nivel_cheia_2024 NUMERIC(7,2);
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS data_cheia_2024 DATE;
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS nota TEXT;

-- Série histórica de leituras.
-- UNIQUE evita duplicar a mesma medição quando o cron roda e o feed não mudou.
CREATE TABLE IF NOT EXISTS leituras (
    id          BIGSERIAL PRIMARY KEY,
    slug        TEXT NOT NULL REFERENCES estacoes(slug) ON DELETE CASCADE,
    nivel       NUMERIC(7,2) NOT NULL,          -- em metros
    medido_em   TIMESTAMPTZ NOT NULL,           -- horário da medição (vem do feed)
    coletado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT leituras_unicas UNIQUE (slug, medido_em)
);

CREATE INDEX IF NOT EXISTS idx_leituras_slug_data
    ON leituras (slug, medido_em DESC);

-- Log de alertas disparados, para não repetir notificação do mesmo evento.
CREATE TABLE IF NOT EXISTS alertas (
    id           BIGSERIAL PRIMARY KEY,
    slug         TEXT NOT NULL REFERENCES estacoes(slug) ON DELETE CASCADE,
    status       TEXT NOT NULL,                 -- normal | atencao | alerta | alagado | chuva_alerta | chuva_normal | subida_rapida | subida_normal
    nivel        NUMERIC(7,2),                  -- NULL nos alertas de chuva (ver tipo)
    criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alertas_slug_data
    ON alertas (slug, criado_em DESC);

-- Idempotente: bancos que criaram a tabela antes destas colunas existirem.
-- tipo discrimina nível (comportamento original, default pra não quebrar
-- linhas já gravadas) de chuva acumulada (ver registrarAlertasChuva em
-- lib/coletar.js) — dedup do coletor passa a ser sempre escopado por
-- (slug, tipo), nunca comparando status de nível contra status de chuva.
ALTER TABLE alertas ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'nivel';
ALTER TABLE alertas ALTER COLUMN nivel DROP NOT NULL;
ALTER TABLE alertas ADD COLUMN IF NOT EXISTS chuva_mm_acumulada NUMERIC(6,2);
-- Velocidade sustentada que disparou um alerta tipo='subida' (NULL nos
-- outros tipos) — ver registrarAlertasSubida em lib/coletar.js.
ALTER TABLE alertas ADD COLUMN IF NOT EXISTS velocidade_cm_h NUMERIC(8,2);

CREATE INDEX IF NOT EXISTS idx_alertas_slug_tipo_data
    ON alertas (slug, tipo, criado_em DESC);

-- Previsão diária por estação — vazão (m³/s, não nível em metros — ver nota
-- em lib/previsao.js) e clima (Open-Meteo, mesmo provedor). Colunas anuláveis
-- porque vazão e clima vêm de duas chamadas independentes: se uma falhar, a
-- outra ainda grava sua parte. Atualizada no máximo 1x a cada 6h (~4x/dia)
-- por estação — ver atualizarPrevisoes em lib/coletar.js.
CREATE TABLE IF NOT EXISTS previsoes (
    id               BIGSERIAL PRIMARY KEY,
    slug             TEXT NOT NULL REFERENCES estacoes(slug) ON DELETE CASCADE,
    dia              DATE NOT NULL,
    vazao_m3s        NUMERIC(12,2),
    temp_max         NUMERIC(5,2),
    temp_min         NUMERIC(5,2),
    chuva_mm         NUMERIC(6,2),
    condicao_codigo  INT,               -- WMO weather code (Open-Meteo)
    chance_chuva_pct SMALLINT,          -- 0-100, precipitation_probability_max (Open-Meteo)
    gerado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT previsoes_unicas UNIQUE (slug, dia)
);

-- Idempotente: bancos que criaram a tabela antes destas colunas existirem.
ALTER TABLE previsoes ALTER COLUMN vazao_m3s DROP NOT NULL;
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS temp_max NUMERIC(5,2);
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS temp_min NUMERIC(5,2);
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS chuva_mm NUMERIC(6,2);
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS condicao_codigo INT;
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS chance_chuva_pct SMALLINT;
-- Nível estimado a partir da vazão prevista, pela curva empírica da estação
-- (ver curvas_nivel e lib/curva.js). NULL quando a estação não tem curva
-- confiável ou a vazão caiu fora da faixa ajustada — que é a maioria dos
-- casos no começo, de propósito.
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS nivel_estimado_m NUMERIC(7,2);

CREATE INDEX IF NOT EXISTS idx_previsoes_slug_dia
    ON previsoes (slug, dia);

-- Arquiva cada estimativa "⏱ atinge a cota" / "↩ volta ao normal" (ver
-- calcularEtaCota em lib/calculo.js) no momento em que foi calculada, pra
-- depois conferir contra o nível REAL medido — diferente da previsão de
-- vazão (que não temos como validar, é só modelo sem medição real pra
-- comparar), aqui a estimativa é extrapolação da nossa própria telemetria
-- de nível, então dá pra avaliar com integridade.
--
-- Só uma estimativa "em aberto" por estação por vez (ver lib/coletar.js):
-- enquanto a última ainda não foi avaliada, não cria outra — senão toda
-- subida de 6h+ geraria uma linha nova a cada 15 min, quase todas
-- redundantes entre si.
CREATE TABLE IF NOT EXISTS estimativas_cota (
    id                  BIGSERIAL PRIMARY KEY,
    slug                TEXT NOT NULL REFERENCES estacoes(slug) ON DELETE CASCADE,
    classe              TEXT NOT NULL,               -- subindo | descendo
    previsto_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nivel_no_calculo    NUMERIC(7,2) NOT NULL,
    velocidade_cm_h     NUMERIC(8,2) NOT NULL,
    alvo_nivel          NUMERIC(7,2) NOT NULL,       -- nível que precisa ser cruzado (cota, ou 60% dela)
    horas_estimadas     NUMERIC(8,2) NOT NULL,
    alvo_em             TIMESTAMPTZ NOT NULL,        -- previsto_em + horas_estimadas
    tolerancia_horas    NUMERIC(6,2) NOT NULL,       -- janela de tolerância além do alvo_em pra considerar "acertou"
    avaliado_em         TIMESTAMPTZ,                 -- NULL = ainda em aberto
    resultado           TEXT,                        -- 'acertou' | 'errou' (NULL até avaliar)
    nivel_real_no_alvo  NUMERIC(7,2),                -- leitura real mais próxima do alvo_em, pra contexto
    erro_horas          NUMERIC(8,2)                 -- diferença real vs. previsto, só quando 'acertou'
);

CREATE INDEX IF NOT EXISTS idx_estimativas_cota_pendentes
    ON estimativas_cota (slug) WHERE avaliado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_estimativas_cota_avaliadas
    ON estimativas_cota (avaliado_em) WHERE avaliado_em IS NOT NULL;

-- Projeções de NÍVEL por horizonte fixo (6/12/24/48h).
--
-- Objeto diferente do de estimativas_cota, e é essa diferença que justifica
-- a tabela nova: lá o previsto é um TEMPO (quando o nível cruza um valor),
-- aqui é um NÍVEL (quantos metros a estação vai marcar daqui a X horas). A
-- literatura de previsão fluvial — inclusive as previsões emergenciais do
-- Guaíba publicadas na RBRH 30 (2025) — avalia a segunda coisa: erro de
-- nível por horizonte fixo, com RMSE/NSE. Sem registrar isso, nada do que
-- este sistema produz é comparável com esses trabalhos.
--
-- Três métodos gravados lado a lado pro mesmo instante e horizonte:
--   persistencia — o nível fica onde está. É a REFERÊNCIA (a mesma que a
--                  RBRH 30 registra faltar): método que não supera a
--                  persistência não está agregando informação nenhuma.
--   tendencia    — extrapolação linear pela velocidade medida em cm/h, a
--                  mesma conta de calcularEtaCota (lib/calculo.js).
--   curva        — previsoes.nivel_estimado_m do dia do alvo (curva
--                  empírica vazão→nível, ver curvas_nivel). Só existe
--                  quando a estação tem curva confiável e a vazão caiu na
--                  faixa ajustada, então tem N bem menor que os outros dois
--                  — de propósito, e a análise precisa levar isso em conta.
--
-- Cadência: UMA emissão por hora por estação, não uma por coleta. A coleta
-- roda a cada 15 min, mas projeções emitidas a cada 15 min são quase
-- idênticas entre si e seus erros são fortemente autocorrelacionados —
-- reportar o n bruto delas inflaria artificialmente a amostra na análise
-- estatística (quatro linhas quase iguais contadas como quatro observações
-- independentes). De quebra, o volume cai de ~10,7 mil pra ~2,7 mil
-- linhas/dia. Não é a trava de "uma em aberto por vez" da estimativas_cota:
-- aqui não se espera a anterior ser avaliada, cada hora emite a sua.
CREATE TABLE IF NOT EXISTS projecoes_nivel (
    id               BIGSERIAL PRIMARY KEY,
    slug             TEXT NOT NULL REFERENCES estacoes(slug) ON DELETE CASCADE,
    metodo           TEXT NOT NULL,               -- persistencia | tendencia | curva
    horizonte_h      SMALLINT NOT NULL,           -- 6 | 12 | 24 | 48
    gerada_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nivel_no_calculo NUMERIC(7,2) NOT NULL,       -- último nível medido no momento da projeção
    velocidade_cm_h  NUMERIC(8,2),                -- ritmo medido na hora; 'persistencia' ignora no cálculo, mas fica gravado pra dar pra estratificar o erro por ritmo do rio depois
    nivel_previsto   NUMERIC(7,2) NOT NULL,
    alvo_em          TIMESTAMPTZ NOT NULL,        -- gerada_em + horizonte_h
    avaliada_em      TIMESTAMPTZ,                 -- NULL = ainda em aberto
    nivel_real       NUMERIC(7,2),                -- leitura medida mais próxima de alvo_em (±30 min); NULL = não houve leitura na janela
    -- nivel_real − nivel_previsto, COM SINAL preservado: positivo = o rio
    -- estava mais alto do que a projeção dizia (previu baixo demais).
    -- Guardar o sinal é o que separa erro (magnitude) de viés (tendência
    -- sistemática) — um método que erra ±30 cm pros dois lados é coisa
    -- diferente de um que erra 30 cm sempre pra baixo, e só o segundo dá
    -- pra corrigir. Mesmo raciocínio do vies_m em /api/curva.
    erro_m           NUMERIC(7,3)
    -- A chave de unicidade é um índice por HORA, logo abaixo — não cabe
    -- aqui dentro porque envolve expressão (date_trunc).
);

-- Idempotente: bancos que criaram a tabela antes destas colunas existirem.
ALTER TABLE projecoes_nivel ADD COLUMN IF NOT EXISTS velocidade_cm_h NUMERIC(8,2);
ALTER TABLE projecoes_nivel ADD COLUMN IF NOT EXISTS avaliada_em TIMESTAMPTZ;
ALTER TABLE projecoes_nivel ADD COLUMN IF NOT EXISTS nivel_real NUMERIC(7,2);
ALTER TABLE projecoes_nivel ADD COLUMN IF NOT EXISTS erro_m NUMERIC(7,3);

-- Unicidade POR HORA, não pelo timestamp exato: a gravação é 1x/hora por
-- estação (ver registrarProjecoesNivel em lib/coletar.js), e uma chave com
-- gerada_em cravado deixaria duas rodadas da mesma hora passarem batido —
-- exatamente o que a cadência horária existe pra impedir.
--
-- date_trunc sobre `gerada_em AT TIME ZONE 'UTC'` porque índice exige
-- expressão IMMUTABLE, e date_trunc('hour', timestamptz) é só STABLE
-- (depende do TimeZone da sessão). O fuso escolhido não muda o resultado:
-- hora cheia em UTC e em America/Sao_Paulo são o mesmo balde de 60 min,
-- já que o offset é inteiro.
ALTER TABLE projecoes_nivel DROP CONSTRAINT IF EXISTS projecoes_nivel_unicas;

-- Em DO block em vez de um CREATE UNIQUE INDEX solto por um motivo só: um
-- banco que já rodou a versão anterior (gravação a cada 15 min) tem várias
-- linhas do mesmo trio dentro da mesma hora, e o índice único falharia
-- levando o script inteiro junto. Apagar as repetidas pra "resolver" está
-- fora de questão — é dado prospectivo já emitido, e apagar isso é
-- irreversível. Então avisa e segue: a cadência horária já está garantida
-- pela aplicação, e o índice entra quando o operador decidir o que fazer
-- com o histórico misto (o de sempre: separar por gerada_em < data do
-- deploy, ou simplesmente deixar como está e filtrar na análise).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM projecoes_nivel
    GROUP BY slug, metodo, horizonte_h, date_trunc('hour', gerada_em AT TIME ZONE 'UTC')
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'projecoes_nivel: existem linhas do mesmo (slug, metodo, horizonte_h) na mesma hora, da época em que a gravação era a cada 15 min — o índice único por hora NÃO foi criado. Nenhuma linha foi apagada; a aplicação já grava 1x/hora.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS projecoes_nivel_unicas_hora
      ON projecoes_nivel (slug, metodo, horizonte_h, (date_trunc('hour', gerada_em AT TIME ZONE 'UTC')));
  END IF;
END $$;

-- Espelham os índices de estimativas_cota (um parcial pras pendentes, outro
-- pras avaliadas), adaptados às duas únicas consultas que existem sobre
-- esta tabela: a avaliação varre as pendentes já vencidas (por alvo_em), e
-- /api/projecoes agrega as avaliadas por metodo × horizonte_h. Aqui os
-- parciais importam mais que lá: esta tabela cresce ~100 linhas por rodada
-- (14 estações × 4 horizontes × 2-3 métodos), não uma por evento.
CREATE INDEX IF NOT EXISTS idx_projecoes_nivel_pendentes
    ON projecoes_nivel (alvo_em) WHERE avaliada_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_projecoes_nivel_avaliadas
    ON projecoes_nivel (metodo, horizonte_h) WHERE avaliada_em IS NOT NULL;

-- Inscrições de notificação push (Web Push API — ver lib/push.js). Uma
-- linha por navegador/dispositivo inscrito. `slugs` NULL = todas as
-- estações (default); um array restringe às escolhidas. endpoint é único
-- porque o próprio navegador garante isso (é a URL do serviço de push
-- dele) — reinscrever o mesmo endpoint atualiza a preferência, nunca
-- duplica.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          BIGSERIAL PRIMARY KEY,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotente: bancos que criaram a tabela antes desta coluna existir.
-- NULL = todas as estações, que é o comportamento que a tabela sempre teve
-- (e continua sendo o default de quem se inscreve sem escolher nada) — por
-- isso NULL em vez de um array com as 14: "não escolheu" é diferente de
-- "escolheu todas", e só o primeiro deve acompanhar automaticamente uma
-- estação nova que entre no painel depois.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS slugs TEXT[];

-- Cross-check com a API oficial da ANA (ver lib/ana.js) — mesmo formato de
-- leituras, propositalmente SEPARADA: a coluna `nivel` daqui nunca entra no
-- cálculo de nível/status/alerta do painel (api/painel.js continua 100%
-- baseado em `leituras`, a fonte atual via nivelguaiba.com.br). A coluna
-- `chuva_mm` é lida, sim — alimenta chuvaMedidaAnaMm/frescorAna em
-- /api/painel, chuvaAna em /api/historico e o alerta tipo='chuva' — mas
-- sempre rotulada "(ANA)" e nunca conflada com o nível.
-- Só 12 das 14 estações têm código ANA mapeado —
-- lajeado e rocasales ficam de fora até resolver ambiguidades encontradas
-- no inventário oficial (ver comentário em ESTACOES_ANA).
CREATE TABLE IF NOT EXISTS leituras_ana (
    id          BIGSERIAL PRIMARY KEY,
    slug        TEXT NOT NULL REFERENCES estacoes(slug) ON DELETE CASCADE,
    nivel       NUMERIC(7,2) NOT NULL,
    medido_em   TIMESTAMPTZ NOT NULL,
    coletado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT leituras_ana_unicas UNIQUE (slug, medido_em)
);

-- Idempotente: bancos que criaram a tabela antes desta coluna existir.
-- Chuva_Adotada vem no mesmo payload que Cota_Adotada — chuva acumulada
-- MEDIDA na própria estação (não é previsão, diferente de previsoes.chuva_mm).
ALTER TABLE leituras_ana ADD COLUMN IF NOT EXISTS chuva_mm NUMERIC(6,2);

CREATE INDEX IF NOT EXISTS idx_leituras_ana_slug_data
    ON leituras_ana (slug, medido_em DESC);

-- Agregado horário de `leituras`, preenchido incrementalmente a cada coleta
-- (ver atualizarRollup em lib/coletar.js).
--
-- Motivo: `leituras` cresce ~1.344 linhas/dia (14 estações × 96 coletas) —
-- cerca de 490 mil/ano — e /api/painel faz window function sobre a tabela
-- inteira. O rollup deixa as janelas longas do gráfico (30d, 90d) baratas
-- sem precisar apagar nada, e é o que permite manter anos de histórico
-- mesmo se um dia a retenção de dado bruto for ligada.
--
-- Guarda min/máx além da média de propósito: numa janela de 90 dias a média
-- horária esconderia exatamente o pico de uma cheia, que é a informação que
-- mais importa nessa escala de tempo.
CREATE TABLE IF NOT EXISTS leituras_horarias (
    slug        TEXT NOT NULL REFERENCES estacoes(slug) ON DELETE CASCADE,
    hora        TIMESTAMPTZ NOT NULL,      -- date_trunc('hour', medido_em)
    n           INT NOT NULL,
    nivel_min   NUMERIC(7,2) NOT NULL,
    nivel_max   NUMERIC(7,2) NOT NULL,
    nivel_med   NUMERIC(7,2) NOT NULL,
    PRIMARY KEY (slug, hora)
);

CREATE INDEX IF NOT EXISTS idx_leituras_horarias_slug_hora
    ON leituras_horarias (slug, hora DESC);

-- Curva empírica vazão → nível por estação (ver lib/curva.js), reajustada
-- no máximo 1x/dia a partir do histórico pareado que já temos:
-- previsoes.vazao_m3s (modelo) × média diária de leituras.nivel (medido).
--
-- NÃO é curva-chave: ajusta ao mesmo tempo a relação física da régua e o
-- viés do GloFAS naquele ponto da grade. É impura fisicamente e útil
-- preditivamente — e, diferente da vazão crua, produz um número que dá pra
-- CONFERIR contra medição real depois, porque nível a gente mede.
--
-- Uma linha por estação (o slug é a PK): a curva é reajustada sobre a
-- janela inteira a cada vez, não versionada. Guardar histórico de
-- coeficiente não ajudaria a responder nada que a gente pergunte hoje.
CREATE TABLE IF NOT EXISTS curvas_nivel (
    slug            TEXT PRIMARY KEY REFERENCES estacoes(slug) ON DELETE CASCADE,
    alfa            DOUBLE PRECISION NOT NULL,   -- ln(h) = alfa + beta·ln(Q)
    beta            DOUBLE PRECISION NOT NULL,
    n               INT NOT NULL,                -- pares usados no ajuste
    r2              DOUBLE PRECISION,            -- no espaço log; NULL = indefinido
    erro_medio_m    NUMERIC(7,3),                -- erro absoluto médio, em metros
    vazao_min_m3s   DOUBLE PRECISION NOT NULL,   -- faixa observada: fora dela não
    vazao_max_m3s   DOUBLE PRECISION NOT NULL,   -- extrapolamos (é onde erraria feio)
    ajustada_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uma linha por rodada de coleta — o histórico de saúde das fontes, que o
-- `frescor` do painel não dá: ele diz se o dado está velho AGORA, não se
-- isso é um soluço ou o terceiro do dia. Alimenta GET /api/saude e a página
-- public/fontes.html.
--
-- feed_ok separa "o feed respondeu" de "o feed respondeu e não tinha
-- novidade" (leituras_inseridas = 0 é normal: a coleta roda a cada 15 min e
-- nem toda estação atualiza nesse ritmo). ana_ok é NULL quando as
-- credenciais da ANA não estão configuradas — feature opcional, ausência
-- não é falha.
CREATE TABLE IF NOT EXISTS coletas (
    id                     BIGSERIAL PRIMARY KEY,
    iniciada_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duracao_ms             INT,
    feed_ok                BOOLEAN NOT NULL,
    erro_feed              TEXT,
    ana_ok                 BOOLEAN,
    leituras_recebidas     INT NOT NULL DEFAULT 0,
    leituras_inseridas     INT NOT NULL DEFAULT 0,
    leituras_ana_recebidas INT NOT NULL DEFAULT 0,
    leituras_ana_inseridas INT NOT NULL DEFAULT 0,
    previsoes_atualizadas  INT NOT NULL DEFAULT 0,
    alertas_criados        INT NOT NULL DEFAULT 0
);

-- Idempotente: bancos que criaram a tabela antes destas colunas existirem.
--
-- projecoes_gravadas fecha um ponto cego real: o registro das projeções roda
-- dentro de try/catch (é instrumentação, não pode derrubar a coleta), então
-- uma falha permanente — schema.sql não aplicado depois do deploy, por
-- exemplo — deixaria projecoes_nivel vazia sem que nada, visto de fora,
-- parecesse diferente de uma coleta saudável. Com o contador e a mensagem em
-- `coletas`, /api/saude mostra na hora.
ALTER TABLE coletas ADD COLUMN IF NOT EXISTS projecoes_gravadas INT NOT NULL DEFAULT 0;
ALTER TABLE coletas ADD COLUMN IF NOT EXISTS erro_projecoes TEXT;

CREATE INDEX IF NOT EXISTS idx_coletas_data ON coletas (iniciada_em DESC);

-- ============================================================
-- Carga inicial das 14 estações (cotas conforme sua planilha)
-- Coordenadas: sede do município (fonte: Wikipédia), usadas só para
-- consultar a previsão de vazão por coordenada — não afetam nível/cota.
--
-- nivel_cheia_2024 / data_cheia_2024: pico da enchente de maio/2024,
-- extraído do próprio nivelguaiba.com.br (mesma régua/estação que já
-- usamos pra coleta, então é comparável direto com o nível atual sem
-- risco de datum diferente). Cruzado com imprensa/SGB pra Porto Alegre,
-- Lajeado e Muçum — bateu. Fica NULL pra 3 estações de propósito:
--   - cachoeiradosul e encantado: o próprio site admite "não há registro
--     consolidado" pra essas estações.
--   - rocasales: o site retorna um "pico" de 5,32 m em 29/05/2024, mas
--     Roca Sales foi uma das cidades mais destruídas pela enchente (mais
--     de 100 casas, evacuação total) já no início de maio — esse número
--     quase certamente não é o pico real, e sim o maior valor captado por
--     uma estação que só entrou em operação depois do auge do desastre.
--     Melhor não mostrar do que mostrar um dado enganoso.
--
-- Porto Alegre é um caso à parte: em 03/05/2024 a ANA e o SGB recalibraram
-- a série da Usina do Gasômetro (código 87450020), subtraindo 1,18 m de
-- TODAS as leituras (passadas e futuras) pra alinhar ao referencial
-- nacional IBGE 1788A — confirmado direto na nota técnica oficial da ANA,
-- não só no site do amigo que serviu de pista. Isso muda dois números:
--   - cota_inundacao: 3,00 m era a referência pública (Cais Mauá, outro
--     local/régua); nesta série (Gasômetro, a que a gente realmente lê)
--     o equivalente é 2,42 m — confirmado batendo nosso nível ao vivo
--     (1,14 m) com o da ANA/SGB no mesmo minuto exato.
--   - nivel_cheia_2024: era 5,35 m (régua emergencial antiga); convertido
--     pra série atual é 4,17 m (5,35 − 1,18), valor que a própria ANA cita.
-- Ver nota da estação e README pra fontes e o texto completo da ressalva.
-- ============================================================
INSERT INTO estacoes (slug, cidade, rio, estacao, cota_inundacao, ordem, lat, lon, nivel_cheia_2024, data_cheia_2024, nota) VALUES
    ('portoalegre',       'Porto Alegre',          'Guaíba',           'Usina do Gasômetro',                 2.42,  1, -30.032780, -51.230000,  4.17, '2024-05-05',
     'Cota e pico de 2024 ajustados pra régua ATUAL da Usina do Gasômetro (não é a régua da maioria das notícias). Em 03/05/2024 a ANA e o SGB recalibraram essa série, subtraindo 1,18 m de todas as leituras pra alinhar ao referencial nacional IBGE 1788A — por isso o pico da cheia de maio/2024 aqui é 4,17 m, não os 5,35 m mais divulgados (mesma medição, régua diferente). A cota de inundação "oficial" mais conhecida, 3,00 m, é medida no Cais Mauá, não na Usina do Gasômetro — o equivalente dela nesta régua é 2,42 m. Fontes: gov.br/ana (nota técnica da readequação) e prefeitura.poa.br/dmae (referência do Cais Mauá).'),
    ('saoleopoldo',       'São Leopoldo',          'Rio dos Sinos',    'Ponte 25 de Julho',                  4.50,  2, -29.760000, -51.146940,  8.09, '2024-05-04', NULL),
    ('lajeado',           'Lajeado',               'Rio Taquari',      'Arroio do Meio/Lajeado',            19.00,  3, -29.466940, -51.960830, 33.66, '2024-05-02', NULL),
    ('bomretirodosul',    'Bom Retiro do Sul',     'Rio Taquari',      'Montante',                          19.00,  4, -29.608890, -51.942780, 21.74, '2024-05-02', NULL),
    ('cachoeiradosul',    'Cachoeira do Sul',      'Rio Jacuí',        'Passo São Lourenço',                18.00,  5, -30.038900, -52.893900,  NULL,  NULL, NULL),
    ('donafrancisca',     'Dona Francisca',        'Rio Jacuí',        NULL,                                 7.50,  6, -29.621940, -53.356940,  9.48, '2024-05-12', NULL),
    ('encantado',         'Encantado',             'Rio Alto Taquari', 'Usina Hidrelétrica Dona Francisca', 12.00,  7, -29.235830, -51.870000,  NULL,  NULL, NULL),
    ('feliz',             'Feliz',                 'Rio Caí',          NULL,                                 9.00,  8, -29.450830, -51.305830,  9.93, '2024-05-12', NULL),
    ('gravatai',          'Gravataí',              'Rio Gravataí',     'Passo das Canoas',                   4.75,  9, -29.943890, -50.991940,  6.23, '2024-05-07', NULL),
    ('mucum',             'Muçum',                 'Rio Alto Taquari', NULL,                                18.00, 10, -29.167000, -51.883000, 25.57, '2024-05-02', NULL),
    ('riopardo',          'Rio Pardo',             'Rio Jacuí',        'Rio Pardo',                         12.50, 11, -29.989720, -52.378060, 20.04, '2024-05-05', NULL),
    ('saosebastiaodocai', 'São Sebastião do Caí',  'Rio Caí',          'Barca do Caí',                      10.00, 12, -29.586940, -51.375830, 15.80, '2024-05-13', NULL),
    ('taquara',           'Taquara',               'Rio dos Sinos',    NULL,                                 6.00, 13, -29.650560, -50.780560, 10.68, '2024-05-02', NULL),
    ('rocasales',         'Roca Sales',            'Rio Alto Taquari', NULL,                                18.00, 14, -29.283000, -51.867000,  NULL,  NULL, NULL)
ON CONFLICT (slug) DO UPDATE SET
    cidade            = EXCLUDED.cidade,
    rio               = EXCLUDED.rio,
    estacao           = EXCLUDED.estacao,
    cota_inundacao    = EXCLUDED.cota_inundacao,
    ordem             = EXCLUDED.ordem,
    lat               = EXCLUDED.lat,
    lon               = EXCLUDED.lon,
    nivel_cheia_2024  = EXCLUDED.nivel_cheia_2024,
    data_cheia_2024   = EXCLUDED.data_cheia_2024,
    nota              = EXCLUDED.nota;

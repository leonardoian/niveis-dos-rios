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

-- Inscrições de notificação push (Web Push API — ver lib/push.js). Uma
-- linha por navegador/dispositivo inscrito; sem coluna de "quais estações"
-- de propósito — quem se inscreve recebe alerta de todas as 14, mesmo
-- critério que já popula a tabela alertas (entrada em risco E volta ao
-- normal). endpoint é único porque o próprio navegador garante isso (é a
-- URL do serviço de push dele) — reinscrever o mesmo endpoint só atualiza,
-- nunca duplica.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          BIGSERIAL PRIMARY KEY,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

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
    data_cheia_2024  DATE                       -- NULL quando não há registro consolidado confiável
);

-- Idempotente: garante as colunas em bancos que rodaram este script antes
-- delas existirem.
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6);
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS lon NUMERIC(9,6);
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS nivel_cheia_2024 NUMERIC(7,2);
ALTER TABLE estacoes ADD COLUMN IF NOT EXISTS data_cheia_2024 DATE;

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
    status       TEXT NOT NULL,                 -- atencao | alerta | alagado
    nivel        NUMERIC(7,2) NOT NULL,
    criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alertas_slug_data
    ON alertas (slug, criado_em DESC);

-- Previsão diária por estação — vazão (m³/s, não nível em metros — ver nota
-- em lib/previsao.js) e clima (Open-Meteo, mesmo provedor). Colunas anuláveis
-- porque vazão e clima vêm de duas chamadas independentes: se uma falhar, a
-- outra ainda grava sua parte. Atualizada no máximo 1x/dia por estação.
CREATE TABLE IF NOT EXISTS previsoes (
    id               BIGSERIAL PRIMARY KEY,
    slug             TEXT NOT NULL REFERENCES estacoes(slug) ON DELETE CASCADE,
    dia              DATE NOT NULL,
    vazao_m3s        NUMERIC(12,2),
    temp_max         NUMERIC(5,2),
    temp_min         NUMERIC(5,2),
    chuva_mm         NUMERIC(6,2),
    condicao_codigo  INT,               -- WMO weather code (Open-Meteo)
    gerado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT previsoes_unicas UNIQUE (slug, dia)
);

-- Idempotente: bancos que criaram a tabela antes destas colunas existirem.
ALTER TABLE previsoes ALTER COLUMN vazao_m3s DROP NOT NULL;
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS temp_max NUMERIC(5,2);
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS temp_min NUMERIC(5,2);
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS chuva_mm NUMERIC(6,2);
ALTER TABLE previsoes ADD COLUMN IF NOT EXISTS condicao_codigo INT;

CREATE INDEX IF NOT EXISTS idx_previsoes_slug_dia
    ON previsoes (slug, dia);

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
-- ============================================================
INSERT INTO estacoes (slug, cidade, rio, estacao, cota_inundacao, ordem, lat, lon, nivel_cheia_2024, data_cheia_2024) VALUES
    ('portoalegre',       'Porto Alegre',          'Guaíba',           'Usina do Gasômetro',                 3.00,  1, -30.032780, -51.230000,  5.35, '2024-05-05'),
    ('saoleopoldo',       'São Leopoldo',          'Rio dos Sinos',    'Ponte 25 de Julho',                  4.50,  2, -29.760000, -51.146940,  8.09, '2024-05-04'),
    ('lajeado',           'Lajeado',               'Rio Taquari',      'Arroio do Meio/Lajeado',            19.00,  3, -29.466940, -51.960830, 33.66, '2024-05-02'),
    ('bomretirodosul',    'Bom Retiro do Sul',     'Rio Taquari',      'Montante',                          19.00,  4, -29.608890, -51.942780, 21.74, '2024-05-02'),
    ('cachoeiradosul',    'Cachoeira do Sul',      'Rio Jacuí',        'Passo São Lourenço',                18.00,  5, -30.038900, -52.893900,  NULL,  NULL),
    ('donafrancisca',     'Dona Francisca',        'Rio Jacuí',        NULL,                                 7.50,  6, -29.621940, -53.356940,  9.48, '2024-05-12'),
    ('encantado',         'Encantado',             'Rio Alto Taquari', 'Usina Hidrelétrica Dona Francisca', 12.00,  7, -29.235830, -51.870000,  NULL,  NULL),
    ('feliz',             'Feliz',                 'Rio Caí',          NULL,                                 9.00,  8, -29.450830, -51.305830,  9.93, '2024-05-12'),
    ('gravatai',          'Gravataí',              'Rio Gravataí',     'Passo das Canoas',                   4.75,  9, -29.943890, -50.991940,  6.23, '2024-05-07'),
    ('mucum',             'Muçum',                 'Rio Alto Taquari', NULL,                                18.00, 10, -29.167000, -51.883000, 25.57, '2024-05-02'),
    ('riopardo',          'Rio Pardo',             'Rio Jacuí',        'Rio Pardo',                         12.50, 11, -29.989720, -52.378060, 20.04, '2024-05-05'),
    ('saosebastiaodocai', 'São Sebastião do Caí',  'Rio Caí',          'Barca do Caí',                      10.00, 12, -29.586940, -51.375830, 15.80, '2024-05-13'),
    ('taquara',           'Taquara',               'Rio dos Sinos',    NULL,                                 6.00, 13, -29.650560, -50.780560, 10.68, '2024-05-02'),
    ('rocasales',         'Roca Sales',            'Rio Alto Taquari', NULL,                                18.00, 14, -29.283000, -51.867000,  NULL,  NULL)
ON CONFLICT (slug) DO UPDATE SET
    cidade            = EXCLUDED.cidade,
    rio               = EXCLUDED.rio,
    estacao           = EXCLUDED.estacao,
    cota_inundacao    = EXCLUDED.cota_inundacao,
    ordem             = EXCLUDED.ordem,
    lat               = EXCLUDED.lat,
    lon               = EXCLUDED.lon,
    nivel_cheia_2024  = EXCLUDED.nivel_cheia_2024,
    data_cheia_2024   = EXCLUDED.data_cheia_2024;

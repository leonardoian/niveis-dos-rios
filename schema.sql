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
    ativa           BOOLEAN NOT NULL DEFAULT TRUE
);

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

-- ============================================================
-- Carga inicial das 14 estações (cotas conforme sua planilha)
-- ============================================================
INSERT INTO estacoes (slug, cidade, rio, estacao, cota_inundacao, ordem) VALUES
    ('portoalegre',       'Porto Alegre',          'Guaíba',           'Usina do Gasômetro',                 3.00,  1),
    ('saoleopoldo',       'São Leopoldo',          'Rio dos Sinos',    'Ponte 25 de Julho',                  4.50,  2),
    ('lajeado',           'Lajeado',               'Rio Taquari',      'Arroio do Meio/Lajeado',            19.00,  3),
    ('bomretirodosul',    'Bom Retiro do Sul',     'Rio Taquari',      'Montante',                          19.00,  4),
    ('cachoeiradosul',    'Cachoeira do Sul',      'Rio Jacuí',        'Passo São Lourenço',                18.00,  5),
    ('donafrancisca',     'Dona Francisca',        'Rio Jacuí',        NULL,                                 7.50,  6),
    ('encantado',         'Encantado',             'Rio Alto Taquari', 'Usina Hidrelétrica Dona Francisca', 12.00,  7),
    ('feliz',             'Feliz',                 'Rio Caí',          NULL,                                 9.00,  8),
    ('gravatai',          'Gravataí',              'Rio Gravataí',     'Passo das Canoas',                   4.75,  9),
    ('mucum',             'Muçum',                 'Rio Alto Taquari', NULL,                                18.00, 10),
    ('riopardo',          'Rio Pardo',             'Rio Jacuí',        'Rio Pardo',                         12.50, 11),
    ('saosebastiaodocai', 'São Sebastião do Caí',  'Rio Caí',          'Barca do Caí',                      10.00, 12),
    ('taquara',           'Taquara',               'Rio dos Sinos',    NULL,                                 6.00, 13),
    ('rocasales',         'Roca Sales',            'Rio Alto Taquari', NULL,                                18.00, 14)
ON CONFLICT (slug) DO UPDATE SET
    cidade         = EXCLUDED.cidade,
    rio            = EXCLUDED.rio,
    estacao        = EXCLUDED.estacao,
    cota_inundacao = EXCLUDED.cota_inundacao,
    ordem          = EXCLUDED.ordem;

-- ============================================================
-- Monitoramento de Rios do RS — Schema PostgreSQL (Neon)
-- ============================================================

CREATE TABLE estacoes (
    codigo          BIGINT PRIMARY KEY,
    nome            TEXT NOT NULL,
    rio             TEXT,
    municipio       TEXT,
    uf              TEXT DEFAULT 'RS',
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    cota_atencao    NUMERIC(6,2),
    cota_alerta     NUMERIC(6,2),
    cota_inundacao  NUMERIC(6,2),
    ativa           BOOLEAN DEFAULT TRUE,
    criado_em       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE leituras (
    id              BIGSERIAL PRIMARY KEY,
    estacao         BIGINT NOT NULL REFERENCES estacoes(codigo),
    medido_em       TIMESTAMPTZ NOT NULL,
    nivel_m         NUMERIC(7,2),
    vazao           NUMERIC(12,2),
    chuva_mm        NUMERIC(7,2),
    qualidade       SMALLINT,
    coletado_em     TIMESTAMPTZ DEFAULT now(),
    UNIQUE (estacao, medido_em)
);

CREATE INDEX idx_leituras_estacao_tempo
    ON leituras (estacao, medido_em DESC);

CREATE VIEW estacao_status AS
SELECT
    e.codigo, e.nome, e.rio, e.municipio, e.latitude, e.longitude,
    e.cota_atencao, e.cota_alerta, e.cota_inundacao,
    l.nivel_m, l.medido_em,
    CASE
        WHEN l.nivel_m IS NULL THEN 'sem_dado'
        WHEN e.cota_inundacao IS NOT NULL AND l.nivel_m >= e.cota_inundacao THEN 'inundacao'
        WHEN e.cota_alerta   IS NOT NULL AND l.nivel_m >= e.cota_alerta   THEN 'alerta'
        WHEN e.cota_atencao  IS NOT NULL AND l.nivel_m >= e.cota_atencao  THEN 'atencao'
        ELSE 'normal'
    END AS status
FROM estacoes e
LEFT JOIN LATERAL (
    SELECT nivel_m, medido_em FROM leituras
    WHERE estacao = e.codigo ORDER BY medido_em DESC LIMIT 1
) l ON true
WHERE e.ativa;

CREATE TABLE inscricoes (
    id              BIGSERIAL PRIMARY KEY,
    nome            TEXT,
    push_endpoint   TEXT NOT NULL,
    push_keys       JSONB NOT NULL,
    estacao         BIGINT REFERENCES estacoes(codigo),
    nivel_gatilho   TEXT DEFAULT 'alerta',
    criado_em       TIMESTAMPTZ DEFAULT now()
);

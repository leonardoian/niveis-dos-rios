-- Estações da Bacia do Guaíba (foco Taquari + região metropolitana)
-- Cotas em METROS. Fonte: boletins SGB/SACE e referências cruzadas.
-- Cotas de atenção/alerta NULL onde não há fonte oficial confirmada —
-- preencher com o boletim do SGB (sgb.gov.br/sace/taquari).
INSERT INTO estacoes
    (codigo, nome, rio, municipio, latitude, longitude, cota_atencao, cota_alerta, cota_inundacao) VALUES
    (86510000, 'Muçum',              'Taquari', 'Muçum',             -29.1664, -51.8703, 5.00, 9.00, 18.00),
    (86720000, 'Encantado',          'Taquari', 'Encantado',         -29.2356, -51.8694, NULL, NULL, 12.00),
    (86879300, 'Lajeado',            'Taquari', 'Lajeado',           -29.4669, -51.9614, NULL, NULL, 19.00),
    (86881000, 'Bom Retiro do Sul',  'Taquari', 'Bom Retiro do Sul', -29.6072, -51.9447, NULL, NULL, 19.00),
    (87382000, 'São Leopoldo',       'Sinos',   'São Leopoldo',      -29.7603, -51.1472, NULL, NULL, 4.50),
    (87450020, 'Porto Alegre (Cais)','Guaíba',  'Porto Alegre',      -30.0277, -51.2287, NULL, NULL, 3.00);

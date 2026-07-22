import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extrairSlug, extrairNivel } from '../lib/feed.js';

test('extrairSlug: pega o pathname de uma estação normal', () => {
  assert.equal(extrairSlug('https://nivelguaiba.com.br/taquara'), 'taquara');
});

test('extrairSlug: Porto Alegre é a home ("/") e vira "portoalegre"', () => {
  assert.equal(extrairSlug('https://nivelguaiba.com.br/'), 'portoalegre');
});

test('extrairSlug: ignora barra dupla/trailing slash', () => {
  assert.equal(extrairSlug('https://nivelguaiba.com.br/rocasales/'), 'rocasales');
});

test('extrairNivel: número com casa decimal (ponto)', () => {
  assert.equal(extrairNivel('Nível atual em Taquara / Rio dos Sinos: 2.22 metros. Status: normal.'), 2.22);
});

test('extrairNivel: número inteiro sem casa decimal (bug real já corrigido — feed manda "1 metros")', () => {
  assert.equal(extrairNivel('Nível atual em Porto Alegre / Guaíba: 1 metros. Status: normal.'), 1);
});

test('extrairNivel: número grande (estações do Alto Taquari passam de 19m)', () => {
  assert.equal(extrairNivel('Nível atual em Roca Sales / Rio Alto Taquari: 19.01 metros. Status: alagado.'), 19.01);
});

test('extrairNivel: texto sem "metros" retorna null', () => {
  assert.equal(extrairNivel('texto qualquer sem nível nenhum'), null);
});

test('extrairNivel: texto vazio retorna null', () => {
  assert.equal(extrairNivel(''), null);
});

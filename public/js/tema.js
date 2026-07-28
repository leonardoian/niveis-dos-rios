// Tema claro/escuro — compartilhado por index.html, bacia.html e
// acerto.html. Sem preferência salva, o CSS (@media prefers-color-scheme)
// decide sozinho; só fixamos data-tema quando o usuário clica no botão, pra
// poder sobrepor a preferência do sistema. Espera um <button id="temaToggle">
// já presente no HTML antes desse script rodar.
function aplicarIconeTema(tema) {
  document.getElementById('temaToggle').textContent = tema === 'escuro' ? '☀️' : '🌙';
}
function temaEfetivoAtual() {
  const salvo = document.documentElement.getAttribute('data-tema');
  if (salvo) return salvo;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
}
function alternarTema() {
  const novo = temaEfetivoAtual() === 'escuro' ? 'claro' : 'escuro';
  localStorage.setItem('tema', novo);
  document.documentElement.setAttribute('data-tema', novo);
  aplicarIconeTema(novo);
}
const temaSalvo = localStorage.getItem('tema');
if (temaSalvo) document.documentElement.setAttribute('data-tema', temaSalvo);
aplicarIconeTema(temaEfetivoAtual());
document.getElementById('temaToggle').addEventListener('click', alternarTema);

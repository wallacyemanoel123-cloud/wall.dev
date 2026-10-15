// WALL Finance — inicialização, navegação e sincronização entre aparelhos.
import { api, post } from './js/api.js';
import { S, loadAll } from './js/state.js';
import { icon, toast, isDialogOpen, esc, applyTheme } from './js/ui.js';
import * as fin from './js/views-fin.js';
import * as os from './js/views-os.js';
import * as more from './js/views-more.js';
import * as brain from './js/views-brain.js';

const ROUTES = [
  { group: 'WALL OS' },
  { id: 'hoje', label: 'Hoje', icon: 'sun', view: os.hoje },
  { id: 'planejamento', label: 'Planejamento', icon: 'list', view: os.planejamento },
  { id: 'objetivos', label: 'Metas e objetivos', icon: 'flag', view: os.objetivos },
  { id: 'projetos', label: 'Projetos e negócios', icon: 'briefcase', view: os.projetos },
  { id: 'calendario', label: 'Calendário', icon: 'calendar', view: os.calendario },
  { id: 'diario', label: 'Diário', icon: 'book', view: os.diario },
  { id: 'checklist', label: 'Checklist diário', icon: 'check', view: os.checklist },
  { id: 'habitos', label: 'Hábitos e saúde', icon: 'heart', view: os.habitos },
  { id: 'ingles', label: 'Estudos de inglês', icon: 'globe', view: os.ingles },
  { group: 'WALL Finance' },
  { id: 'painel', label: 'Visão financeira', icon: 'home', view: fin.painel },
  { id: 'lancamentos', label: 'Lançamentos', icon: 'list', view: fin.lancamentos },
  { id: 'contas', label: 'Contas e reservas', icon: 'wallet', view: fin.contas },
  { id: 'recibos', label: 'Recibos', icon: 'receipt', view: fin.recibos },
  { id: 'extrato', label: 'Importar extrato', icon: 'upload', view: fin.extrato },
  { id: 'orcamentos', label: 'Orçamentos', icon: 'pie', view: fin.orcamentos },
  { id: 'recorrentes', label: 'Fixas e planejadas', icon: 'repeat', view: fin.recorrentes },
  { id: 'delivery', label: 'Delivery', icon: 'bike', view: fin.delivery },
  { id: 'investimentos', label: 'Investimentos', icon: 'chart', view: fin.investimentos },
  { id: 'metas', label: 'Metas financeiras', icon: 'target', view: fin.metas },
  { id: 'desejos', label: 'Lista de desejos', icon: 'star', view: fin.desejos },
  { id: 'relatorios', label: 'Relatórios', icon: 'chart', view: fin.relatorios },
  { group: 'Sistema' },
  { id: 'cerebro', label: 'Cérebro WALL', icon: 'spark', view: brain.cerebro },
  { id: 'assistente', label: 'Assistente WALL', icon: 'spark', view: more.assistente },
  { id: 'dados', label: 'Dados e segurança', icon: 'shield', view: more.dados },
];
const pages = ROUTES.filter(r => r.id);
const $ = s => document.querySelector(s);

function currentRoute() {
  const id = location.hash.replace(/^#\/?/, '').split('?')[0] || 'hoje';
  return pages.find(p => p.id === id) || pages[0];
}

function renderNav(active) {
  $('#nav').innerHTML = ROUTES.map(r => r.group ? `<div class="nav-group eyebrow">${esc(r.group)}</div>`
    : `<a href="#/${r.id}"${r.id === active.id ? ' aria-current="page"' : ''}>${icon(r.icon)}${esc(r.label)}</a>`).join('');
  const tab = (id, label, ic) => `<a href="#/${id}"${id === active.id ? ' aria-current="page"' : ''}>${icon(ic)}${label}</a>`;
  $('#tabbar').innerHTML = tab('hoje', 'Hoje', 'sun') + tab('painel', 'Finanças', 'wallet')
    + `<button type="button" class="fab" data-quick aria-label="Novo lançamento">${icon('plus')}Lançar</button>`
    + tab('recibos', 'Recibo', 'camera') + `<button type="button" data-more aria-label="Mais opções">${icon('more')}Mais</button>`;
}

export async function render() {
  const route = currentRoute();
  renderNav(route);
  $('#page-title').textContent = route.label;
  document.title = `${route.label} · WALL OS`;
  const host = $('#view');
  try { await route.view(host, { rerender: render, refresh }); }
  catch (e) { host.innerHTML = `<div class="banner error">Não foi possível exibir esta tela: ${esc(e.message)}</div>`; console.error(e); }
}

// Recarrega do servidor e redesenha a tela.
export async function refresh() {
  setSync('busy', 'Atualizando…');
  try { await loadAll(); setSync('', 'Sincronizado ' + S.loadedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })); await render(); }
  catch (e) { setSync('off', 'Sem conexão'); throw e; }
}
function setSync(cls, text) { const el = $('#sync'); el.className = 'sync ' + cls; el.textContent = text; }

// Sincronização: verifica a revisão do banco a cada 20 s (com a tela visível) e ao voltar ao app.
let checking = false;
async function checkRevision() {
  if (checking || document.hidden || !S.fin) return;
  checking = true;
  try {
    const { revision } = await api('revision');
    if (revision !== S.revision) {
      if (isDialogOpen()) setSync('busy', 'Há alterações de outro aparelho');
      else { await refresh(); }
    } else setSync('', 'Sincronizado ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
  } catch { setSync('off', 'Sem conexão — dados podem estar desatualizados'); }
  finally { checking = false; }
}

function showMoreMenu() {
  const dlg = document.getElementById('dialog');
  dlg.innerHTML = `<form class="modal" method="dialog"><div class="modal-head"><h2>Menu</h2><button class="ghost small" aria-label="Fechar">${icon('close')}</button></div>
    <div class="modal-body"><nav class="nav">${ROUTES.map(r => r.group ? `<div class="nav-group eyebrow">${esc(r.group)}</div>` : `<a href="#/${r.id}">${icon(r.icon)}${esc(r.label)}</a>`).join('')}</nav></div></form>`;
  dlg.querySelectorAll('a').forEach(a => a.addEventListener('click', () => dlg.close()));
  dlg.showModal();
}

async function start() {
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  document.addEventListener('click', e => {
    if (e.target.closest('[data-quick]') || e.target.closest('#quick-add')) fin.quickAdd(refresh);
    if (e.target.closest('[data-more]')) showMoreMenu();
  });
  window.addEventListener('hashchange', () => { render(); $('#view').focus({ preventScroll: true }); window.scrollTo(0, 0); });
  window.addEventListener('wf:logout', () => showLogin('Sua sessão terminou. Entre novamente.'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRevision(); });
  window.addEventListener('online', checkRevision);
  setInterval(checkRevision, 20000);

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button');
    $('#login-error').textContent = '';
    btn.disabled = true;
    try {
      await post('auth/login', { email: f.email.value, password: f.password.value });
      f.password.value = '';
      await enter();
    } catch (err) { $('#login-error').textContent = err.message; }
    finally { btn.disabled = false; }
  });

  try { const me = await api('auth/me'); S.email = me.email; await enter(); }
  catch { showLogin(); }
}

function showLogin(message = '') {
  $('#boot').hidden = true; $('#app').hidden = true; $('#login').hidden = false;
  $('#login-error').textContent = message;
  S.fin = null;
  document.getElementById('dialog').open && document.getElementById('dialog').close();
}

async function enter() {
  await loadAll();
  $('#boot').hidden = true; $('#login').hidden = true; $('#app').hidden = false;
  setSync('', 'Sincronizado');
  await render();
}

start().catch(e => { $('#boot').innerHTML = `<p class="banner error">Falha ao iniciar: ${esc(e.message)}</p>`; });
export { toast };

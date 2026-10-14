// Telas do WALL OS: Hoje, planejamento, metas e objetivos, projetos e negócios, calendário,
// diário, checklist, hábitos e estudos de inglês. Tudo editável pela interface.
import { post, del } from './api.js';
import { S } from './state.js';
import { esc, money, icon, fmtDate, monthLabel, openForm, confirmDialog, toast } from './ui.js';
import { addDays, addMonths, periodRange } from '../shared/finance.js';
import { reorderList } from './lists.js';

const today = () => S.fin.today;
const STATUS = [['aberto', 'Aberto'], ['em_andamento', 'Em andamento'], ['concluido', 'Concluído'], ['cancelado', 'Cancelado']];
const STATUS_LABEL = Object.fromEntries(STATUS);
const HORIZON = { curto: 'Curto prazo (até 3 meses)', medio: 'Médio prazo (até 1 ano)', longo: 'Longo prazo (mais de 1 ano)' };
const MODULE_LABEL = { objetivo: 'meta', plano: 'plano', diario: 'registro no diário', checklist: 'item do checklist', evento: 'compromisso', projeto: 'projeto', habito: 'hábito', estudo: 'sessão de estudo' };
const SKILLS = ['Vocabulário', 'Gramática', 'Listening', 'Speaking', 'Leitura', 'Escrita', 'Aula', 'Outro'];
// Hábitos: unidade exibida → fator de armazenamento (horas guardadas em minutos).
const UNITS = { horas: 60, copos: 1, minutos: 1, vezes: 1, litros: 1000 };
const HABIT_PRESETS = { sono: ['Sono', 'horas', 8], agua: ['Hidratação', 'copos', 8], exercicio: ['Exercício', 'minutos', 30], outro: ['Hábito', 'vezes', 1] };
const showArchived = {};

const data = i => { try { return JSON.parse(i.data_json || '{}'); } catch { return {}; } };
const items = (module, { archived = false } = {}) => S.os.filter(i => i.module === module && (archived || !i.archived)).sort((a, b) => a.sort - b.sort);
const empty = t => `<div class="empty"><p>${esc(t)}</p></div>`;
const fmtNum = n => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

async function save(item, changes, refresh) {
  await post('os/items', { ...item, data: data(item), ...changes });
  await refresh();
}

export function osForm(module, item, refresh, preset = {}) {
  const v = item || { date: preset.date ?? (['diario', 'evento', 'checklist', 'estudo'].includes(module) ? today() : ''), status: 'aberto', ...preset };
  const extra = { ...data(v), ...(preset.data || {}) };
  const fields = [{ name: 'title', label: module === 'checklist' ? 'Item' : module === 'estudo' ? 'Tema estudado' : module === 'habito' ? 'Nome do hábito' : 'Título', required: true, value: v.title, max: 200, full: true }];
  if (module !== 'habito') fields.push({ name: 'date', label: ['evento', 'diario', 'estudo'].includes(module) ? 'Data' : 'Data / prazo', type: 'date', required: ['diario', 'evento', 'estudo'].includes(module), value: v.date || '' });
  if (module === 'evento') fields.push({ name: 'time', label: 'Hora', type: 'time', value: v.time || '' }, { name: 'repeat', label: 'Repetir', type: 'select', options: [['', 'Não repete'], ['semanal', 'Toda semana']], value: extra.repeat || '' });
  if (module === 'objetivo') fields.push({ name: 'horizon', label: 'Prazo', type: 'select', options: Object.entries(HORIZON), value: v.horizon || 'curto' });
  if (['objetivo', 'projeto', 'plano'].includes(module)) fields.push({ name: 'status', label: 'Situação', type: 'select', options: STATUS, value: v.status });
  if (module === 'projeto') fields.push({ name: 'tipo', label: 'Tipo', type: 'select', options: [['negocio', 'Negócio'], ['pessoal', 'Pessoal']], value: extra.tipo || 'negocio' },
    { name: 'budget', label: 'Investimento previsto (EUR, opcional)', type: 'money', value: extra.budget_cents ?? null }, { name: 'next', label: 'Próximo passo', value: extra.next || '', full: true });
  if (module === 'diario') fields.push({ name: 'mood', label: 'Como você está?', type: 'select', options: ['Não informado', 'Muito bem', 'Bem', 'Neutro', 'Cansado', 'Preocupado'], value: extra.mood || 'Não informado' });
  if (module === 'estudo') fields.push({ name: 'minutes', label: 'Minutos', type: 'number', required: true, value: extra.minutes ?? '' }, { name: 'skill', label: 'Habilidade', type: 'select', options: SKILLS, value: extra.skill || 'Vocabulário' });
  if (module === 'habito') fields.push({ name: 'kind', label: 'Tipo', type: 'select', options: [['sono', 'Sono'], ['agua', 'Hidratação'], ['exercicio', 'Exercício'], ['outro', 'Outro']], value: extra.kind || 'outro' },
    { name: 'unit', label: 'Unidade', type: 'select', options: Object.keys(UNITS), value: extra.unit || 'vezes' }, { name: 'target', label: 'Meta diária', type: 'decimal', required: true, value: extra.target ?? '' });
  if (!['checklist', 'habito'].includes(module)) fields.push({ name: 'body', label: module === 'diario' ? 'Como foi o dia?' : module === 'estudo' ? 'O que aprendeu / palavras novas' : 'Detalhes', type: 'textarea', value: v.body, max: 10000 });
  openForm({
    title: item ? `Editar ${MODULE_LABEL[module]}` : `Novo ${MODULE_LABEL[module]}`, fields,
    extra: item ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir', `Excluir “${item.title}”? A exclusão é lógica e fica na auditoria.`, { danger: true, confirmLabel: 'Excluir' })) { await del('os/items/' + item.id); d.close(); toast('Excluído.'); await refresh(); } } }] : [],
    onSubmit: async val => {
      const out = { ...extra };
      if (module === 'evento') out.repeat = val.repeat || undefined;
      if (module === 'projeto') Object.assign(out, { tipo: val.tipo, budget_cents: val.budget ?? undefined, next: val.next || undefined });
      if (module === 'diario') out.mood = val.mood;
      if (module === 'estudo') { const m = Number(val.minutes); if (!Number.isInteger(m) || m <= 0 || m > 1440) throw new Error('Minutos: informe um número inteiro entre 1 e 1440.'); Object.assign(out, { minutes: m, skill: val.skill }); }
      if (module === 'habito') { const t = Number(String(val.target).replace(',', '.')); if (!(t > 0)) throw new Error('Meta diária inválida.'); Object.assign(out, { kind: val.kind, unit: val.unit, target: t }); }
      await post('os/items', { id: item?.id, version: item?.version, module, title: val.title, date: val.date || null, time: val.time || null, horizon: val.horizon || item?.horizon || null,
        status: val.status || item?.status || 'aberto', done: item?.done === 1, archived: item?.archived === 1, body: val.body, data: out });
      toast('Salvo.'); await refresh();
    },
  });
}

// Lista reutilizável com concluir, arquivar, reordenar e editar.
function listHtml(list, module, { check = false } = {}) {
  if (!list.length) return empty('Nada por aqui ainda.');
  return `<div class="list">${list.map((i, k) => {
    const d = data(i);
    const meta = [i.date && fmtDate(i.date), i.time, ['objetivo', 'projeto', 'plano'].includes(module) && STATUS_LABEL[i.status], d.tipo === 'negocio' && 'Negócio', d.budget_cents && 'previsto ' + money(d.budget_cents, 'EUR'), d.next && 'Próximo: ' + esc(d.next)].filter(Boolean).join(' · ');
    const late = i.date && i.date < today() && !i.done && !['concluido', 'cancelado'].includes(i.status);
    return `<div class="row">${check ? `<input type="checkbox" data-toggle="${esc(i.id)}"${i.done ? ' checked' : ''} aria-label="Concluir ${esc(i.title)}">` : ''}
      <div class="grow"><div class="title ${i.done || i.status === 'concluido' ? 'muted' : ''}">${esc(i.title)} ${i.archived ? '<span class="tag">Arquivado</span>' : ''}${late ? '<span class="tag warn">atrasado</span>' : ''}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</div>
      ${!check && !['concluido', 'cancelado'].includes(i.status) ? `<button class="small ghost" data-done="${esc(i.id)}">Concluir</button>` : ''}
      <button class="small ghost" data-up="${k}" aria-label="Subir"${k === 0 ? ' disabled' : ''}>${icon('up')}</button><button class="small ghost" data-down="${k}" aria-label="Descer"${k === list.length - 1 ? ' disabled' : ''}>${icon('down')}</button>
      <button class="small ghost" data-archive="${esc(i.id)}" aria-label="${i.archived ? 'Desarquivar' : 'Arquivar'} ${esc(i.title)}">${icon('archive')}</button>
      <button class="small ghost" data-edit="${esc(i.id)}">Editar</button></div>`;
  }).join('')}</div>`;
}

function bindList(host, list, refresh) {
  const byId = id => S.os.find(i => i.id === id);
  host.querySelectorAll('[data-toggle]').forEach(c => c.addEventListener('change', () => { const it = byId(c.dataset.toggle); save(it, { done: c.checked, status: c.checked ? 'concluido' : 'aberto' }, refresh); }));
  host.querySelectorAll('[data-done]').forEach(b => b.onclick = () => save(byId(b.dataset.done), { status: 'concluido', done: true }, refresh));
  host.querySelectorAll('[data-archive]').forEach(b => b.onclick = () => { const it = byId(b.dataset.archive); save(it, { archived: !it.archived }, refresh).then(() => toast(it.archived ? 'Desarquivado.' : 'Arquivado.')); });
  host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const it = byId(b.dataset.edit); osForm(it.module, it, refresh); });
  host.querySelectorAll('[data-up],[data-down]').forEach(b => b.onclick = () => reorderList('os_items', list, Number(b.dataset.up ?? b.dataset.down), b.dataset.up !== undefined ? -1 : 1, refresh));
}

function archivedToggle(key) {
  return `<label class="check small"><input type="checkbox" data-show-archived="${key}"${showArchived[key] ? ' checked' : ''}> Mostrar arquivados</label>`;
}
function bindArchivedToggle(host, rerender) {
  host.querySelectorAll('[data-show-archived]').forEach(c => c.addEventListener('change', () => { showArchived[c.dataset.showArchived] = c.checked; rerender(); }));
}

// Eventos (com repetição semanal) que caem numa data.
function eventsOn(date) {
  return items('evento').filter(e => e.date === date || (data(e).repeat === 'semanal' && e.date && e.date <= date && Math.round((Date.parse(date) - Date.parse(e.date)) / 86400000) % 7 === 0))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

const habitValue = (h, date) => S.habitLogs.find(l => l.habit_id === h.id && l.date === date);
const display = (h, raw) => fmtNum(raw / (UNITS[data(h).unit] || 1));

function habitQuick(refresh) {
  const habits = items('habito');
  if (!habits.length) return `<p class="muted small">Nenhum hábito. <a href="#/habitos">Criar hábitos</a> (sono, hidratação, exercício…).</p>`;
  return `<div class="list">${habits.map(h => { const d = data(h), log = habitValue(h, today()); const ok = log && log.value >= d.target * (UNITS[d.unit] || 1);
    return `<form class="row" data-habit="${esc(h.id)}"><div class="grow"><div class="title">${esc(h.title)} ${ok ? '<span class="tag ok">meta atingida</span>' : ''}</div><div class="meta">Meta ${fmtNum(d.target)} ${esc(d.unit)}/dia</div></div>
      <input name="value" inputmode="decimal" aria-label="${esc(h.title)} hoje em ${esc(d.unit)}" placeholder="${esc(d.unit)}" value="${log ? display(h, log.value) : ''}" class="habit-input"><button class="small">Salvar</button></form>`; }).join('')}</div>`;
}
function bindHabitQuick(host, refresh) {
  host.querySelectorAll('[data-habit]').forEach(f => f.addEventListener('submit', async e => {
    e.preventDefault();
    const h = S.os.find(i => i.id === f.dataset.habit), n = Number(String(f.value.value).replace(',', '.'));
    if (!(n >= 0)) return toast('Valor inválido.', 'error');
    await post('os/habit-logs', { habit_id: h.id, date: today(), value: Math.round(n * (UNITS[data(h).unit] || 1)) });
    toast('Registrado.'); await refresh();
  }));
}

// ───────────── Hoje ─────────────
export async function hoje(host, { refresh }) {
  const t = today();
  const checklist = items('checklist').filter(i => i.date === t || (!i.done && (!i.date || i.date < t)));
  const done = checklist.filter(i => i.done).length;
  const e = S.dash.byCurrency.EUR;
  const daily = S.dash.budgets.find(b => b.period === 'diario' && b.currency === 'EUR');
  const [ws, we] = periodRange('semanal', t);
  const due = S.fin.recurring.filter(r => r.active && r.next_date <= we).length + (S.fin.planned || []).filter(p => p.status === 'planejada' && p.due_date && p.due_date <= we).length;
  const studyToday = items('estudo').filter(s => s.date === t).reduce((s, x) => s + (data(x).minutes || 0), 0);
  const habits = items('habito'), habitsDone = habits.filter(h => { const l = habitValue(h, t); return l && l.value >= data(h).target * (UNITS[data(h).unit] || 1); }).length;
  const journal = items('diario').find(j => j.date === t);
  host.innerHTML = `
    <div class="page-head"><div><span class="eyebrow">${esc(new Date(t + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }))}</span><h1>Hoje</h1><p>Tarefas, agenda, hábitos e dinheiro do dia em um só lugar.</p></div>
      <div class="actions"><button data-journal>${journal ? 'Abrir diário de hoje' : 'Escrever no diário'}</button></div></div>
    <div class="kpis">
      <div class="kpi"><span class="eyebrow">Disponível (EUR)</span><span class="value ${e.available < 0 ? 'neg' : ''}">${money(e.available, 'EUR')}</span><span class="sub">${daily ? `Orçamento do dia: pode usar ${money(daily.usable, 'EUR')} de ${money(daily.limit_cents, 'EUR')}` : 'Livre de reservas'}</span></div>
      <div class="kpi"><span class="eyebrow">Checklist</span><span class="value">${done}/${checklist.length}</span><span class="sub">tarefas de hoje</span></div>
      <div class="kpi"><span class="eyebrow">Hábitos</span><span class="value">${habitsDone}/${habits.length}</span><span class="sub">metas do dia</span></div>
      <div class="kpi"><span class="eyebrow">Inglês</span><span class="value">${studyToday} min</span><span class="sub">estudados hoje</span></div>
    </div>
    ${daily?.limitedByAvailability ? `<div class="banner warn">O orçamento diário está limitado: só ${money(daily.usable, 'EUR')} estão livres de reservas.</div>` : ''}
    ${due ? `<div class="banner">${due} conta(s) ou planejada(s) vencem até ${fmtDate(we)}. <a href="#/recorrentes">Ver</a></div>` : ''}
    <div class="grid-2">
      <section class="card"><div class="card-head"><h2>Checklist do dia</h2><a class="small" href="#/checklist">Ver tudo</a></div>
        <form id="quick-check" class="actions"><input name="title" placeholder="Novo item…" aria-label="Novo item do checklist" maxlength="200"><button class="primary">Adicionar</button></form>
        ${listHtml(checklist, 'checklist', { check: true })}</section>
      <section class="card"><div class="card-head"><h2>Agenda</h2><button class="small" data-new-event>+ Compromisso</button></div>
        <div class="list">${eventsOn(t).map(ev => `<div class="row"><div class="grow"><div class="title">${esc(ev.title)}</div><div class="meta">${ev.time || 'Dia todo'}${data(ev).repeat ? ' · semanal' : ''}</div></div></div>`).join('') || empty('Sem compromissos hoje.')}</div></section>
    </div>
    <div class="grid-2">
      <section class="card"><div class="card-head"><h2>Hábitos de hoje</h2><a class="small" href="#/habitos">Gerenciar</a></div>${habitQuick(refresh)}</section>
      <section class="card"><div class="card-head"><h2>Estudo de inglês</h2><button class="small" data-study>+ Registrar estudo</button></div>
        <p class="muted small">${studyToday ? `${studyToday} minutos hoje.` : 'Nenhum estudo registrado hoje.'} <a href="#/ingles">Histórico</a></p></section>
    </div>`;
  host.querySelector('#quick-check').addEventListener('submit', async ev => {
    ev.preventDefault();
    const title = ev.target.title.value.trim();
    if (!title) return;
    await post('os/items', { module: 'checklist', title, date: t }); await refresh();
  });
  host.querySelector('[data-new-event]').onclick = () => osForm('evento', null, refresh);
  host.querySelector('[data-journal]').onclick = () => osForm('diario', journal || null, refresh);
  host.querySelector('[data-study]').onclick = () => osForm('estudo', null, refresh);
  bindList(host.querySelector('.grid-2'), checklist, refresh);
  bindHabitQuick(host, refresh);
}

// ───────────── Planejamento ─────────────
export async function planejamento(host, ctx) {
  const { refresh } = ctx;
  const [ws, we] = periodRange('semanal', today());
  const plans = items('plano', { archived: showArchived.plano });
  const week = plans.filter(p => p.date && p.date >= ws && p.date <= we);
  const later = plans.filter(p => !week.includes(p));
  const cur = id => S.fin.accounts.find(a => a.id === id)?.currency || 'EUR';
  const due = S.fin.recurring.filter(r => r.active && r.next_date <= we);
  const planned = (S.fin.planned || []).filter(p => p.status === 'planejada' && p.due_date && p.due_date <= we);
  host.innerHTML = `
    <div class="page-head"><div><h1>Planejamento pessoal</h1><p>Semana de ${fmtDate(ws)} a ${fmtDate(we)}.</p></div><div class="actions">${archivedToggle('plano')}<button class="primary" data-new>+ Plano</button></div></div>
    <div class="grid-2"><section class="card" id="pw"><h2>Esta semana</h2>${listHtml(week, 'plano')}</section>
      <section class="card"><h2>Compromissos financeiros da semana</h2><div class="list">${[...due.map(r => [r.next_date, r.description, r.amount_cents, cur(r.account_id), 'Recorrente']), ...planned.map(p => [p.due_date, p.description, p.amount_cents, p.currency, 'Planejada'])]
        .sort((a, b) => a[0].localeCompare(b[0])).map(([d, n, a, c, k]) => `<div class="row"><div class="grow"><div class="title">${esc(n)}</div><div class="meta">${fmtDate(d)} · ${k}</div></div><span class="amount">${money(a, c)}</span></div>`).join('') || empty('Nenhum vencimento.')}</div></section></div>
    <section class="card" id="pl"><h2>Próximos e sem data</h2>${listHtml(later, 'plano')}</section>`;
  host.querySelector('[data-new]').onclick = () => osForm('plano', null, refresh);
  bindList(host.querySelector('#pw'), week, refresh); bindList(host.querySelector('#pl'), later, refresh);
  bindArchivedToggle(host, () => planejamento(host, ctx));
}

// ───────────── Metas e objetivos ─────────────
export async function objetivos(host, ctx) {
  const { refresh } = ctx;
  const all = items('objetivo', { archived: showArchived.objetivo });
  host.innerHTML = `
    <div class="page-head"><div><h1>Metas e objetivos</h1><p>Objetivos de vida por prazo. Metas em dinheiro ficam em <a href="#/metas">Metas financeiras</a>.</p></div>
      <div class="actions">${archivedToggle('objetivo')}<button class="primary" data-new>+ Meta</button></div></div>
    ${Object.entries(HORIZON).map(([h, label]) => `<section class="card" data-h="${h}"><div class="card-head"><h2>${label}</h2><button class="small" data-new-h="${h}">+ Adicionar</button></div>${listHtml(all.filter(i => (i.horizon || 'curto') === h), 'objetivo')}</section>`).join('')}
    <section class="card"><div class="card-head"><h2>Metas financeiras</h2><a class="small" href="#/metas">Abrir</a></div>
      <div class="bars-h">${S.dash.goals.map(g => `<div class="item"><span>${esc(g.name)}</span><span class="money">${g.pct === null ? '—' : String(g.pct).replace('.', ',') + '%'}</span><progress max="100" value="${g.pct ?? 0}" aria-label="${esc(g.name)}"></progress></div>`).join('') || '<p class="muted small">Nenhuma meta financeira.</p>'}</div></section>`;
  host.querySelector('[data-new]').onclick = () => osForm('objetivo', null, refresh);
  host.querySelectorAll('[data-new-h]').forEach(b => b.onclick = () => osForm('objetivo', null, refresh, { horizon: b.dataset.newH }));
  host.querySelectorAll('[data-h]').forEach(sec => bindList(sec, all.filter(i => (i.horizon || 'curto') === sec.dataset.h), refresh));
  bindArchivedToggle(host, () => objetivos(host, ctx));
}

// ───────────── Projetos e negócios ─────────────
export async function projetos(host, ctx) {
  const { refresh } = ctx;
  const all = items('projeto', { archived: showArchived.projeto });
  const biz = all.filter(p => (data(p).tipo || 'negocio') === 'negocio'), pers = all.filter(p => data(p).tipo === 'pessoal');
  host.innerHTML = `
    <div class="page-head"><div><h1>Projetos e negócios</h1><p>Ex.: WALL.dev. Registre situação, próximo passo e investimento previsto.</p></div>
      <div class="actions">${archivedToggle('projeto')}<button class="primary" data-new>+ Projeto</button></div></div>
    <section class="card" id="biz"><h2>Negócios</h2>${listHtml(biz, 'projeto')}</section>
    <section class="card" id="pers"><h2>Pessoais</h2>${listHtml(pers, 'projeto')}</section>`;
  host.querySelector('[data-new]').onclick = () => osForm('projeto', null, refresh);
  bindList(host.querySelector('#biz'), biz, refresh); bindList(host.querySelector('#pers'), pers, refresh);
  bindArchivedToggle(host, () => projetos(host, ctx));
}

// ───────────── Checklist ─────────────
export async function checklist(host, ctx) {
  const { refresh } = ctx;
  const t = today();
  const all = items('checklist', { archived: showArchived.checklist });
  const open = all.filter(i => !i.done), doneList = all.filter(i => i.done).slice(0, 50);
  host.innerHTML = `
    <div class="page-head"><div><h1>Checklist diário</h1><p>Itens abertos de hoje e atrasados. Marque, reordene ou arquive.</p></div><div class="actions">${archivedToggle('checklist')}</div></div>
    <section class="card" id="ck-open"><form id="quick-check" class="actions"><input name="title" placeholder="Novo item para hoje…" aria-label="Novo item" maxlength="200"><button class="primary">Adicionar</button></form>${listHtml(open, 'checklist', { check: true })}</section>
    <section class="card" id="ck-done"><h2>Concluídos</h2>${listHtml(doneList, 'checklist', { check: true })}</section>`;
  host.querySelector('#quick-check').addEventListener('submit', async e => { e.preventDefault(); const title = e.target.title.value.trim(); if (title) { await post('os/items', { module: 'checklist', title, date: t }); await refresh(); } });
  bindList(host.querySelector('#ck-open'), open, refresh); bindList(host.querySelector('#ck-done'), doneList, refresh);
  bindArchivedToggle(host, () => checklist(host, ctx));
}

// ───────────── Hábitos, sono, hidratação e exercícios ─────────────
export async function habitos(host, ctx) {
  const { refresh } = ctx;
  const habits = items('habito', { archived: showArchived.habito });
  const days = Array.from({ length: 7 }, (_, k) => addDays(today(), k - 6));
  host.innerHTML = `
    <div class="page-head"><div><h1>Hábitos e saúde</h1><p>Sono, hidratação, exercícios e o que mais quiser acompanhar, com meta diária.</p></div>
      <div class="actions">${archivedToggle('habito')}${Object.entries(HABIT_PRESETS).slice(0, 3).filter(([k]) => !habits.some(h => data(h).kind === k)).map(([k, [n]]) => `<button data-preset="${k}">+ ${n}</button>`).join('')}<button class="primary" data-new>+ Hábito</button></div></div>
    <section class="card"><h2>Registrar hoje</h2>${habitQuick(refresh)}</section>
    <section class="card" id="hl"><h2>Últimos 7 dias</h2>${habits.length ? `<div class="table-wrap"><table><thead><tr><th>Hábito</th>${days.map(d => `<th class="r">${fmtDate(d).slice(0, 5)}</th>`).join('')}<th class="r">Meta</th></tr></thead><tbody>
      ${habits.map(h => { const d = data(h), f = UNITS[d.unit] || 1; return `<tr><td>${esc(h.title)}</td>${days.map(day => { const l = habitValue(h, day); return `<td class="r num ${l && l.value >= d.target * f ? 'pos' : ''}">${l ? display(h, l.value) : '—'}</td>`; }).join('')}<td class="r">${fmtNum(d.target)} ${esc(d.unit)}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
      ${listHtml(habits, 'habito')}</section>`;
  host.querySelector('[data-new]').onclick = () => osForm('habito', null, refresh);
  host.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { const [n, unit, target] = HABIT_PRESETS[b.dataset.preset]; osForm('habito', null, refresh, { title: n, data: { kind: b.dataset.preset, unit, target } }); });
  bindHabitQuick(host, refresh);
  bindList(host.querySelector('#hl'), habits, refresh);
  bindArchivedToggle(host, () => habitos(host, ctx));
}

// ───────────── Estudos de inglês ─────────────
export async function ingles(host, ctx) {
  const { refresh } = ctx;
  const sessions = items('estudo', { archived: showArchived.estudo }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const [ws, we] = periodRange('semanal', today());
  const mins = (from, to) => sessions.filter(s => s.date >= from && s.date <= to).reduce((s, x) => s + (data(x).minutes || 0), 0);
  let streak = 0;
  for (let d = today(); sessions.some(s => s.date === d); d = addDays(d, -1)) streak++;
  const bySkill = {};
  for (const s of sessions.filter(x => x.date >= addDays(today(), -30))) bySkill[data(s).skill || 'Outro'] = (bySkill[data(s).skill || 'Outro'] || 0) + (data(s).minutes || 0);
  const max = Math.max(1, ...Object.values(bySkill));
  host.innerHTML = `
    <div class="page-head"><div><h1>Estudos de inglês</h1><p>Registre cada sessão: tema, minutos e habilidade praticada.</p></div><div class="actions">${archivedToggle('estudo')}<button class="primary" data-new>+ Sessão de estudo</button></div></div>
    <div class="kpis"><div class="kpi"><span class="eyebrow">Hoje</span><span class="value">${mins(today(), today())} min</span></div>
      <div class="kpi"><span class="eyebrow">Esta semana</span><span class="value">${mins(ws, we)} min</span></div>
      <div class="kpi"><span class="eyebrow">Últimos 30 dias</span><span class="value">${mins(addDays(today(), -29), today())} min</span></div>
      <div class="kpi"><span class="eyebrow">Sequência</span><span class="value">${streak} dia(s)</span></div></div>
    <section class="card"><h2>Habilidades (30 dias)</h2>${Object.keys(bySkill).length ? `<div class="bars-h">${Object.entries(bySkill).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="item"><span>${esc(k)}</span><span class="money">${v} min</span><progress max="${max}" value="${v}" aria-label="${esc(k)}"></progress></div>`).join('')}</div>` : '<p class="muted small">Sem sessões nos últimos 30 dias.</p>'}</section>
    <section class="card" id="st"><h2>Sessões</h2>${sessions.length ? `<div class="list">${sessions.map(s => `<div class="row"><div class="grow"><div class="title">${esc(s.title)}</div><div class="meta">${fmtDate(s.date)} · ${data(s).minutes || 0} min · ${esc(data(s).skill || '')}${s.body ? ' · ' + esc(s.body.slice(0, 80)) : ''}</div></div><button class="small ghost" data-archive="${esc(s.id)}" aria-label="Arquivar">${icon('archive')}</button><button class="small ghost" data-edit="${esc(s.id)}">Editar</button></div>`).join('')}</div>` : empty('Nenhuma sessão registrada.')}</section>`;
  host.querySelector('[data-new]').onclick = () => osForm('estudo', null, refresh);
  bindList(host.querySelector('#st'), sessions, refresh);
  bindArchivedToggle(host, () => ingles(host, ctx));
}

// ───────────── Diário ─────────────
export async function diario(host, ctx) {
  const { refresh } = ctx;
  const list = items('diario', { archived: showArchived.diario }).sort((a, b) => b.date.localeCompare(a.date));
  host.innerHTML = `
    <div class="page-head"><div><h1>Diário pessoal</h1><p>Registros privados, protegidos pelo mesmo login.</p></div><div class="actions">${archivedToggle('diario')}<button class="primary" data-new>+ Escrever</button></div></div>
    <div class="list">${list.map(j => `<section class="card"><div class="card-head"><div><span class="eyebrow">${fmtDate(j.date)} · ${esc(data(j).mood || '')}</span><h2>${esc(j.title)}</h2></div>
      <div class="actions"><button class="small ghost" data-archive="${esc(j.id)}" aria-label="Arquivar">${icon('archive')}</button><button class="small ghost" data-edit="${esc(j.id)}">Editar</button></div></div>
      <p class="pre">${esc(j.body || '')}</p></section>`).join('') || empty('Nenhum registro ainda.')}</div>`;
  host.querySelector('[data-new]').onclick = () => osForm('diario', null, refresh);
  bindList(host, list, refresh);
  bindArchivedToggle(host, () => diario(host, ctx));
}

// ───────────── Calendário ─────────────
let calMonth = '';
export async function calendario(host, ctx) {
  const { refresh } = ctx;
  calMonth ||= today().slice(0, 7);
  const first = calMonth + '-01';
  const start = addDays(first, -((new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const marks = date => [
    ...eventsOn(date).map(e => ({ t: (e.time ? e.time + ' ' : '') + e.title, id: e.id })),
    ...S.os.filter(i => i.date === date && !i.archived && ['plano', 'objetivo', 'projeto'].includes(i.module)).map(i => ({ t: '◆ ' + i.title, id: i.id })),
    ...S.fin.recurring.filter(r => r.active && r.next_date === date).map(r => ({ t: '€ ' + r.description })),
    ...(S.fin.planned || []).filter(p => p.status === 'planejada' && p.due_date === date).map(p => ({ t: '€ ' + p.description })),
    ...S.fin.goals.filter(g => g.due_date === date).map(g => ({ t: '◎ ' + g.name })),
  ];
  host.innerHTML = `
    <div class="page-head"><div><h1>Calendário</h1><p>Compromissos, planos, vencimentos e prazos de metas.</p></div>
      <div class="actions"><button data-nav="-1" aria-label="Mês anterior">‹</button><button data-nav="0">Hoje</button><button data-nav="1" aria-label="Próximo mês">›</button><button class="primary" data-new>+ Compromisso</button></div></div>
    <section class="card"><h2>${esc(monthLabel(calMonth))}</h2>
      <div class="cal">${['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map(d => `<div class="h">${d}</div>`).join('')}
      ${days.map(d => `<button type="button" class="d${d.slice(0, 7) !== calMonth ? ' out' : ''}${d === today() ? ' today' : ''}" data-day="${d}" aria-label="${fmtDate(d)}, ${marks(d).length} item(ns)">${Number(d.slice(8))}${marks(d).slice(0, 3).map(m => `<span class="ev">${esc(m.t)}</span>`).join('')}${marks(d).length > 3 ? `<span class="ev">+${marks(d).length - 3}</span>` : ''}</button>`).join('')}</div></section>
    <section class="card" id="day-detail" hidden></section>`;
  host.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { calMonth = b.dataset.nav === '0' ? today().slice(0, 7) : addMonths(calMonth + '-01', Number(b.dataset.nav)).slice(0, 7); calendario(host, ctx); });
  host.querySelector('[data-new]').onclick = () => osForm('evento', null, refresh);
  host.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
    const d = b.dataset.day, m = marks(d), box = host.querySelector('#day-detail');
    box.hidden = false;
    box.innerHTML = `<div class="card-head"><h2>${fmtDate(d)}</h2><button class="small" data-add-on="${d}">+ Compromisso neste dia</button></div>
      <div class="list">${m.map(x => `<div class="row"><div class="grow">${esc(x.t)}</div>${x.id ? `<button class="small ghost" data-edit="${esc(x.id)}">Editar</button>` : ''}</div>`).join('') || empty('Nada neste dia.')}</div>`;
    box.querySelector('[data-add-on]').onclick = () => osForm('evento', null, refresh, { date: d });
    box.querySelectorAll('[data-edit]').forEach(x => x.onclick = () => { const it = S.os.find(i => i.id === x.dataset.edit); osForm(it.module, it, refresh); });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

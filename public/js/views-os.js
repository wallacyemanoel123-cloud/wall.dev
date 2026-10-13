// Telas do WALL OS: hoje, objetivos e projetos, planejamento, diário e calendário.
import { post, del } from './api.js';
import { S } from './state.js';
import { esc, money, fmtDate, monthLabel, openForm, confirmDialog, toast } from './ui.js';
import { addDays, addMonths, periodRange } from '../shared/finance.js';

const today = () => S.fin.today;
const STATUS = [['aberto', 'Aberto'], ['em_andamento', 'Em andamento'], ['concluido', 'Concluído'], ['cancelado', 'Cancelado']];
const STATUS_LABEL = Object.fromEntries(STATUS);
const MODULE_LABEL = { objetivo: 'objetivo', plano: 'plano', diario: 'registro no diário', checklist: 'item do checklist', evento: 'compromisso', projeto: 'projeto' };
const items = module => S.os.filter(i => i.module === module);
const data = i => { try { return JSON.parse(i.data_json || '{}'); } catch { return {}; } };
const empty = t => `<div class="empty"><p>${esc(t)}</p></div>`;

export function osForm(module, item, refresh, preset = {}) {
  const v = item || { date: preset.date || (['diario', 'evento', 'checklist'].includes(module) ? today() : ''), status: 'aberto', ...preset };
  const extra = data(v);
  const fields = [
    { name: 'title', label: module === 'checklist' ? 'Item' : 'Título', required: true, value: v.title, max: 200, full: true },
    { name: 'date', label: module === 'evento' ? 'Data' : module === 'diario' ? 'Data' : 'Data / prazo', type: 'date', required: ['diario', 'evento'].includes(module), value: v.date || '' },
  ];
  if (module === 'evento') fields.push({ name: 'time', label: 'Hora', type: 'time', value: v.time || '' }, { name: 'repeat', label: 'Repetir', type: 'select', options: [['', 'Não repete'], ['semanal', 'Toda semana']], value: extra.repeat || '' });
  if (['objetivo', 'projeto', 'plano'].includes(module)) fields.push({ name: 'status', label: 'Situação', type: 'select', options: STATUS, value: v.status });
  if (module === 'projeto') fields.push({ name: 'budget', label: 'Investimento previsto (EUR, opcional)', type: 'money', value: extra.budget_cents ?? null });
  if (module === 'diario') fields.push({ name: 'mood', label: 'Como você está?', type: 'select', options: ['Não informado', 'Muito bem', 'Bem', 'Neutro', 'Cansado', 'Preocupado'], value: extra.mood || 'Não informado' });
  if (module !== 'checklist') fields.push({ name: 'body', label: module === 'diario' ? 'Como foi o dia?' : 'Detalhes', type: 'textarea', value: v.body, max: 10000 });
  openForm({
    title: item ? `Editar ${MODULE_LABEL[module]}` : `Novo ${MODULE_LABEL[module]}`, fields,
    extra: item ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir', `Excluir “${item.title}”?`, { danger: true, confirmLabel: 'Excluir' })) { await del('os/items/' + item.id); d.close(); toast('Excluído.'); await refresh(); } } }] : [],
    onSubmit: async val => {
      const dataOut = { ...extra };
      if (module === 'evento') dataOut.repeat = val.repeat || undefined;
      if (module === 'projeto') dataOut.budget_cents = val.budget ?? undefined;
      if (module === 'diario') dataOut.mood = val.mood;
      await post('os/items', { id: item?.id, version: item?.version, module, title: val.title, date: val.date || null, time: val.time || null, status: val.status || item?.status || 'aberto', done: item?.done === 1, body: val.body, data: dataOut });
      toast('Salvo.'); await refresh();
    },
  });
}

async function toggle(item, refresh) {
  await post('os/items', { ...item, data: data(item), done: !item.done, status: !item.done ? 'concluido' : 'aberto' });
  await refresh();
}

function checkRow(i) {
  return `<div class="row"><label class="check grow"><input type="checkbox" data-toggle="${esc(i.id)}"${i.done ? ' checked' : ''}> <span class="${i.done ? 'muted' : ''}">${esc(i.title)}</span></label>
    ${i.date && i.date < today() && !i.done ? '<span class="tag warn">atrasado</span>' : ''}<button class="small ghost" data-edit="${esc(i.id)}">Editar</button></div>`;
}

function bind(host, refresh, module) {
  host.querySelectorAll('[data-toggle]').forEach(c => c.addEventListener('change', () => toggle(S.os.find(i => i.id === c.dataset.toggle), refresh)));
  host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const it = S.os.find(i => i.id === b.dataset.edit); osForm(it.module || module, it, refresh); });
}

// Eventos (com repetição semanal) que caem numa data.
function eventsOn(date) {
  return items('evento').filter(e => e.date === date || (data(e).repeat === 'semanal' && e.date && e.date <= date && (new Date(date) - new Date(e.date)) % (7 * 86400000) === 0))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

export async function hoje(host, { refresh }) {
  const t = today();
  const checklist = items('checklist').filter(i => (i.date === t) || (!i.done && (!i.date || i.date < t)));
  const done = checklist.filter(i => i.done).length;
  const spentToday = S.fin.transactions.filter(x => x.date === t && x.kind === 'despesa' && x.status === 'confirmada' && x.currency === 'EUR').reduce((s, x) => s - x.amount_cents, 0);
  const daily = S.dash.budgets.filter(b => b.period === 'diario' && b.currency === 'EUR');
  const journal = items('diario').find(j => j.date === t);
  host.innerHTML = `
    <div class="page-head"><div><span class="eyebrow">${esc(fmtDate(t))}</span><h1>Hoje</h1><p>Checklist, agenda e finanças do dia num só lugar.</p></div></div>
    <div class="kpis"><div class="kpi"><span class="eyebrow">Checklist</span><span class="value">${done}/${checklist.length}</span></div>
      <div class="kpi"><span class="eyebrow">Gasto hoje (EUR)</span><span class="value">${money(spentToday, 'EUR')}</span><span class="sub">${daily.length ? daily.map(b => `${esc(b.name)}: resta ${money(b.remaining, 'EUR')}`).join(' · ') : 'Sem orçamento diário'}</span></div></div>
    <div class="grid-2">
      <section class="card"><div class="card-head"><h2>Checklist do dia</h2></div>
        <form id="quick-check" class="actions"><input name="title" placeholder="Novo item…" aria-label="Novo item do checklist" maxlength="200"><button class="primary">Adicionar</button></form>
        <div class="list">${checklist.map(checkRow).join('') || empty('Nada pendente para hoje.')}</div></section>
      <section class="card"><div class="card-head"><h2>Agenda</h2><button class="small" data-new-event>+ Compromisso</button></div>
        <div class="list">${eventsOn(t).map(e => `<div class="row"><div class="grow"><div class="title">${esc(e.title)}</div><div class="meta">${e.time || 'Dia todo'}${data(e).repeat ? ' · semanal' : ''}</div></div><button class="small ghost" data-edit="${esc(e.id)}">Editar</button></div>`).join('') || empty('Sem compromissos hoje.')}</div>
        <div class="card-head"><h2>Diário</h2><button class="small" data-journal>${journal ? 'Abrir registro de hoje' : 'Escrever sobre hoje'}</button></div></section>
    </div>`;
  host.querySelector('#quick-check').addEventListener('submit', async e => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    await post('os/items', { module: 'checklist', title, date: t }); await refresh();
  });
  host.querySelector('[data-new-event]').onclick = () => osForm('evento', null, refresh);
  host.querySelector('[data-journal]').onclick = () => osForm('diario', journal || null, refresh);
  bind(host, refresh);
}

function statusList(module, refresh) {
  const list = items(module).sort((a, b) => (a.status === 'concluido') - (b.status === 'concluido') || String(a.date || '9').localeCompare(String(b.date || '9')));
  return list.map(i => `<div class="row"><div class="grow"><div class="title">${esc(i.title)}</div>
    <div class="meta">${STATUS_LABEL[i.status] || i.status}${i.date ? ' · ' + fmtDate(i.date) : ''}${data(i).budget_cents ? ' · previsto ' + money(data(i).budget_cents, 'EUR') : ''}${i.body ? ' · ' + esc(i.body.slice(0, 80)) : ''}</div></div>
    <span class="tag ${i.status === 'concluido' ? 'ok' : i.date && i.date < today() && i.status !== 'cancelado' ? 'warn' : ''}">${STATUS_LABEL[i.status]}</span><button class="small ghost" data-edit="${esc(i.id)}">Editar</button></div>`).join('') || empty('Nada por aqui ainda.');
}

export async function objetivos(host, { refresh }) {
  host.innerHTML = `
    <div class="page-head"><div><h1>Objetivos e projetos</h1><p>Objetivos de vida e projetos pessoais. As metas em dinheiro ficam em <a href="#/metas">Metas e investimentos</a>.</p></div>
      <div class="actions"><button class="primary" data-new="objetivo">+ Objetivo</button><button data-new="projeto">+ Projeto</button></div></div>
    <div class="grid-2"><section class="card"><h2>Objetivos</h2><div class="list">${statusList('objetivo', refresh)}</div></section>
      <section class="card"><h2>Projetos</h2><div class="list">${statusList('projeto', refresh)}</div></section></div>`;
  host.querySelectorAll('[data-new]').forEach(b => b.onclick = () => osForm(b.dataset.new, null, refresh));
  bind(host, refresh);
}

export async function planejamento(host, { refresh }) {
  const [ws, we] = periodRange('semanal', today());
  const plans = items('plano');
  const week = plans.filter(p => p.date && p.date >= ws && p.date <= we);
  const later = plans.filter(p => !week.includes(p));
  const due = S.fin.recurring.filter(r => r.active && r.next_date <= we);
  const row = i => `<div class="row"><div class="grow"><div class="title">${esc(i.title)}</div><div class="meta">${i.date ? fmtDate(i.date) : 'Sem data'} · ${STATUS_LABEL[i.status]}</div></div><button class="small ghost" data-edit="${esc(i.id)}">Editar</button></div>`;
  host.innerHTML = `
    <div class="page-head"><div><h1>Planejamento</h1><p>Semana de ${fmtDate(ws)} a ${fmtDate(we)}.</p></div><div class="actions"><button class="primary" data-new>+ Plano</button></div></div>
    <div class="grid-2"><section class="card"><h2>Esta semana</h2><div class="list">${week.map(row).join('') || empty('Nada planejado para esta semana.')}</div></section>
      <section class="card"><h2>Compromissos financeiros da semana</h2><div class="list">${due.map(r => `<div class="row"><div class="grow"><div class="title">${esc(r.description)}</div><div class="meta">${fmtDate(r.next_date)}</div></div><span class="amount">${money(r.amount_cents, S.fin.accounts.find(a => a.id === r.account_id)?.currency || 'EUR')}</span></div>`).join('') || empty('Nenhum vencimento.')}</div></section></div>
    <section class="card"><h2>Outros planos</h2><div class="list">${later.map(row).join('') || empty('Sem outros planos.')}</div></section>`;
  host.querySelector('[data-new]').onclick = () => osForm('plano', null, refresh);
  bind(host, refresh, 'plano');
}

export async function diario(host, { refresh }) {
  const list = items('diario').sort((a, b) => b.date.localeCompare(a.date));
  host.innerHTML = `
    <div class="page-head"><div><h1>Diário</h1><p>Registros privados, protegidos pelo mesmo login.</p></div><div class="actions"><button class="primary" data-new>+ Escrever</button></div></div>
    <div class="list">${list.map(j => `<section class="card"><div class="card-head"><div><span class="eyebrow">${fmtDate(j.date)} · ${esc(data(j).mood || '')}</span><h2>${esc(j.title)}</h2></div><button class="small ghost" data-edit="${esc(j.id)}">Editar</button></div>
      <p class="pre">${esc(j.body || '')}</p></section>`).join('') || empty('Nenhum registro ainda.')}</div>`;
  host.querySelector('[data-new]').onclick = () => osForm('diario', null, refresh);
  bind(host, refresh, 'diario');
}

let calMonth = '';
export async function calendario(host, { refresh }) {
  calMonth ||= today().slice(0, 7);
  const first = calMonth + '-01';
  const start = addDays(first, -((new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const marks = date => [
    ...eventsOn(date).map(e => ({ t: (e.time ? e.time + ' ' : '') + e.title, id: e.id })),
    ...S.os.filter(i => i.date === date && ['plano', 'objetivo', 'projeto'].includes(i.module)).map(i => ({ t: '◆ ' + i.title, id: i.id })),
    ...S.fin.recurring.filter(r => r.active && r.next_date === date).map(r => ({ t: '€ ' + r.description })),
    ...S.fin.goals.filter(g => g.due_date === date).map(g => ({ t: '◎ ' + g.name })),
  ];
  host.innerHTML = `
    <div class="page-head"><div><h1>Calendário</h1><p>Compromissos, planos, vencimentos e prazos de metas.</p></div>
      <div class="actions"><button data-nav="-1" aria-label="Mês anterior">‹</button><button data-nav="0">Hoje</button><button data-nav="1" aria-label="Próximo mês">›</button><button class="primary" data-new>+ Compromisso</button></div></div>
    <section class="card"><h2>${esc(monthLabel(calMonth))}</h2>
      <div class="cal">${['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map(d => `<div class="h">${d}</div>`).join('')}
      ${days.map(d => `<button type="button" class="d${d.slice(0, 7) !== calMonth ? ' out' : ''}${d === today() ? ' today' : ''}" data-day="${d}" aria-label="${fmtDate(d)}">${Number(d.slice(8))}${marks(d).slice(0, 3).map(m => `<span class="ev">${esc(m.t)}</span>`).join('')}${marks(d).length > 3 ? `<span class="ev">+${marks(d).length - 3}</span>` : ''}</button>`).join('')}</div></section>
    <section class="card" id="day-detail" hidden></section>`;
  host.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { calMonth = b.dataset.nav === '0' ? today().slice(0, 7) : addMonths(calMonth + '-01', Number(b.dataset.nav)).slice(0, 7); calendario(host, { refresh }); });
  host.querySelector('[data-new]').onclick = () => osForm('evento', null, refresh);
  host.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
    const d = b.dataset.day, m = marks(d), box = host.querySelector('#day-detail');
    box.hidden = false;
    box.innerHTML = `<div class="card-head"><h2>${fmtDate(d)}</h2><button class="small" data-add-on="${d}">+ Compromisso neste dia</button></div>
      <div class="list">${m.map(x => `<div class="row"><div class="grow">${esc(x.t)}</div>${x.id ? `<button class="small ghost" data-edit="${esc(x.id)}">Editar</button>` : ''}</div>`).join('') || empty('Nada neste dia.')}</div>`;
    box.querySelector('[data-add-on]').onclick = () => osForm('evento', null, refresh, { date: d });
    bind(box, refresh);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

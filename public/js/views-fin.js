// Telas do WALL Finance.
import { api, post, del } from './api.js';
import { S, accountName, accountById, activeAccounts, accountOptions } from './state.js';
import { reorderList } from './lists.js';
import { esc, money, icon, fmtDate, monthLabel, openForm, confirmDialog, withReserveConfirm, toast, centsToInput, brToIso } from './ui.js';
import { groupedBars, categoryBars } from './charts.js';
import { monthlyReport, lastMonths, deliveryStats, budgetStatus, addMonths, periodRange, findDuplicates } from '../shared/finance.js';
import { parseCSV, detectColumns, toTransactions } from '../shared/statement.js';
import { parseReceipt } from '../shared/receipt.js';
import { formatMoney, parseRateMilli, parseAmount } from '../shared/money.js';
import { prepareFile, readText } from './ocr.js';

const KIND_LABEL = { receita: 'Receita', despesa: 'Despesa', transferencia: 'Transferência', ajuste: 'Ajuste' };
const ACCOUNT_KINDS = [['banco', 'Banco'], ['carteira_digital', 'Carteira digital'], ['especie', 'Espécie (dinheiro)'], ['reserva', 'Reserva'], ['investimento', 'Investimento'], ['outro', 'Outro']];
const PERIOD_LABEL = { diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal' };
const FREQ_LABEL = { semanal: 'Semanal', mensal: 'Mensal', anual: 'Anual' };
const today = () => S.fin.today;
const sign = t => (t.amount_cents > 0 ? 'pos' : t.amount_cents < 0 ? 'neg' : '');
const decimalX = (s, factor) => { const n = Number(String(s || '0').replace(',', '.')); if (!Number.isFinite(n) || n < 0) throw new Error('Número inválido.'); return Math.round(n * factor); };

function empty(text, action = '') { return `<div class="empty"><p>${esc(text)}</p>${action}</div>`; }

function txRow(t) {
  const att = S.fin.attachments.filter(a => a.transaction_id === t.id).length;
  return `<div class="row clickable" data-tx="${esc(t.id)}" tabindex="0" role="button" aria-label="Editar ${esc(t.description)}">
    <div class="grow"><div class="title">${esc(t.description)}</div>
    <div class="meta">${fmtDate(t.date)} · ${esc(accountName(t.account_id))} · ${esc(t.kind === 'transferencia' ? 'Transferência' : t.category)}${att ? ` · ${att} anexo(s)` : ''}</div></div>
    ${t.status === 'pendente' ? '<span class="tag warn">Pendente</span>' : ''}${t.reconciled_at ? '<span class="tag ok">Conciliado</span>' : ''}${t.kind === 'transferencia' ? '<span class="tag">Transf.</span>' : ''}${t.kind === 'ajuste' ? '<span class="tag">Ajuste</span>' : ''}
    <span class="amount ${sign(t)}">${money(t.amount_cents, t.currency, { sign: true })}</span></div>`;
}

function bindTxRows(host, refresh) {
  host.querySelectorAll('[data-tx]').forEach(el => {
    const open = () => editTransaction(S.fin.transactions.find(t => t.id === el.dataset.tx), refresh);
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

function needAccounts() {
  if (activeAccounts().length) return false;
  toast('Cadastre uma conta primeiro (Contas e saldos).', 'error');
  location.hash = '#/contas';
  return true;
}

// ───────────── Lançamento rápido / edição ─────────────
export function quickAdd(refresh, preset = {}) {
  if (needAccounts()) return;
  editTransaction(null, refresh, preset);
}

export function editTransaction(t, refresh, preset = {}) {
  if (t?.kind === 'transferencia') return transferForm(refresh, t.transfer_id);
  const v = t || { kind: 'despesa', status: 'confirmada', date: today(), category: 'Outros', account_id: activeAccounts().find(a => !a.is_reserve)?.id, ...preset };
  const atts = t ? S.fin.attachments.filter(a => a.transaction_id === t.id) : [];
  const intro = atts.length ? `<div class="banner small">Anexos: ${atts.map(a => `<a href="/api/fin/attachments/${esc(a.id)}" target="_blank" rel="noopener">${esc(a.filename)}</a>`).join(' · ')}</div>` : '';
  openForm({
    title: t ? 'Editar lançamento' : 'Novo lançamento', intro,
    fields: [
      { name: 'kind', label: 'Tipo', type: 'select', options: t?.kind === 'ajuste' ? [['ajuste', 'Ajuste']] : [['despesa', 'Despesa'], ['receita', 'Receita']], value: v.kind },
      { name: 'amount', label: 'Valor', type: 'money', required: true, value: v.amount_cents ? Math.abs(v.amount_cents) : null, hint: t?.kind === 'ajuste' ? 'Ajustes mantêm o sinal original.' : '' },
      { name: 'account_id', label: 'Conta', type: 'select', options: accountOptions(), value: v.account_id },
      { name: 'date', label: 'Data', type: 'date', required: true, value: v.date },
      { name: 'description', label: 'Descrição', required: true, value: v.description, max: 200, full: true },
      { name: 'merchant', label: 'Estabelecimento', value: v.merchant, max: 120 },
      { name: 'category', label: 'Categoria', value: v.category, list: S.fin.categories },
      { name: 'status', label: 'Status', type: 'select', options: [['confirmada', 'Confirmada (entra no saldo)'], ['pendente', 'Pendente (não entra no saldo)']], value: v.status },
      { name: 'notes', label: 'Notas', type: 'textarea', value: v.notes },
    ],
    extra: t ? [{ label: 'Excluir', danger: true, onClick: async dlg => {
      if (!await confirmDialog('Excluir lançamento', 'O lançamento sai dos saldos. O histórico de auditoria guarda a versão anterior.', { confirmLabel: 'Excluir', danger: true })) return;
      await del('fin/transactions/' + t.id); dlg.close(); toast('Lançamento excluído.'); await refresh();
    } }] : [],
    onSubmit: async val => {
      const amount = t?.kind === 'ajuste' ? Math.sign(t.amount_cents || 1) * val.amount : val.amount;
      await withReserveConfirm(confirm_reserve => post('fin/transactions', { ...val, amount_cents: amount, id: t?.id, version: t?.version, confirm_reserve, attachment_ids: preset.attachment_ids }));
      toast(t ? 'Lançamento atualizado.' : 'Lançamento registrado.');
      await refresh();
    },
  });
}

export function transferForm(refresh, transferId) {
  if (needAccounts()) return;
  const legs = transferId ? S.fin.transactions.filter(x => x.transfer_id === transferId) : [];
  const out = legs.find(l => l.amount_cents < 0), inn = legs.find(l => l.amount_cents > 0);
  const opts = accountOptions();
  openForm({
    title: transferId ? 'Editar transferência' : 'Transferência entre contas',
    intro: '<div class="banner small">Transferências movem dinheiro entre suas contas: não contam como receita nem despesa.</div>',
    fields: [
      { name: 'from_account_id', label: 'De', type: 'select', options: opts, value: out?.account_id || opts[0]?.[0] },
      { name: 'to_account_id', label: 'Para', type: 'select', options: opts, value: inn?.account_id || opts[1]?.[0] },
      { name: 'amount', label: 'Valor enviado', type: 'money', required: true, value: out ? -out.amount_cents : null },
      { name: 'amount_to', label: 'Valor recebido (só se as moedas forem diferentes)', type: 'money', value: inn && out && inn.currency !== out.currency ? inn.amount_cents : null },
      { name: 'date', label: 'Data', type: 'date', required: true, value: out?.date || today() },
      { name: 'status', label: 'Status', type: 'select', options: [['confirmada', 'Confirmada'], ['pendente', 'Pendente']], value: out?.status || 'confirmada' },
      { name: 'description', label: 'Descrição', value: out?.description || '', full: true, hint: 'Opcional' },
    ],
    extra: transferId ? [{ label: 'Excluir transferência', danger: true, onClick: async dlg => {
      if (!await confirmDialog('Excluir transferência', 'As duas pernas (saída e entrada) serão excluídas.', { confirmLabel: 'Excluir', danger: true })) return;
      await del('fin/transactions/' + out.id); dlg.close(); toast('Transferência excluída.'); await refresh();
    } }] : [],
    onSubmit: async val => {
      await withReserveConfirm(confirm_reserve => post('fin/transfers', { ...val, amount_cents: val.amount, amount_to_cents: val.amount_to, transfer_id: transferId, confirm_reserve }));
      toast('Transferência registrada.'); await refresh();
    },
  });
}

// ───────────── Painel ─────────────
export async function painel(host, { refresh }) {
  const d = S.dash, f = S.fin;
  const hasBRL = f.accounts.some(a => a.currency === 'BRL' && !a.archived) || f.investments.some(i => i.currency === 'BRL');
  const kpi = (label, value, sub = '') => `<div class="kpi"><span class="eyebrow">${esc(label)}</span><span class="value">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
  const e = d.byCurrency.EUR, b = d.byCurrency.BRL;
  const pend = f.transactions.filter(t => t.status === 'pendente');
  const months = lastMonths(today(), 6);
  const reports = months.map(m => monthlyReport(f.transactions, m, 'EUR'));
  const unconfirmed = f.snapshots.filter(s => s.status === 'a_confirmar' && s.is_anchor).length;
  host.innerHTML = `
    <div class="page-head"><div><span class="eyebrow">${esc(fmtDate(today()))}</span><h1>Visão geral</h1><p>Saldos calculados a partir das fotografias de saldo e dos lançamentos confirmados.</p></div>
      <div class="actions"><button class="primary" data-act="add">+ Lançamento</button><button data-act="transfer">Transferência</button></div></div>
    ${!f.accounts.length ? `<div class="banner warn"><b>Comece aqui:</b> cadastre suas contas com o saldo de referência em <a href="#/contas">Contas e saldos</a>. Nenhum saldo bancário é lido automaticamente.</div>` : ''}
    ${unconfirmed ? `<div class="banner warn">${unconfirmed} saldo(s) de referência ainda “a confirmar”. São fotografias históricas: confira no app do banco e concilie em <a href="#/contas">Contas e saldos</a>.</div>` : ''}
    <div class="kpis">
      ${kpi('Patrimônio (R$)', d.netWorth.BRL === null ? '—' : money(d.netWorth.BRL, 'BRL'), d.rate ? `Taxa manual 1 € = R$ ${(d.rate / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} (${fmtDate(f.settings.eur_brl_date)})` : 'Informe a taxa EUR→BRL em Contas')}
      ${kpi('Disponível (EUR)', `<span class="${e.available < 0 ? 'neg' : ''}">${money(e.available, 'EUR')}</span>`, 'Livre de reservas e contas fora do orçamento')}
      ${kpi('Reservado (EUR)', money(e.reserve, 'EUR'), S.dash.reserves.filter(r => r.currency === 'EUR' && r.deficit).map(r => `${esc(r.name)}: faltam ${money(r.deficit, 'EUR')}`).join(' · ') || 'Reservas protegidas')}
      ${e.planned30 ? kpi('Planejado 30 dias (EUR)', money(e.planned30, 'EUR'), 'Ainda não lançado') : ''}
      ${kpi('Receitas do mês (EUR)', `<span class="pos">${money(e.month.income, 'EUR')}</span>`)}
      ${kpi('Despesas do mês (EUR)', `<span class="neg">${money(e.month.expense, 'EUR')}</span>`, `Resultado ${money(e.month.result, 'EUR', { sign: true })}`)}
      ${hasBRL ? kpi('Saldo em BRL', money(b.total, 'BRL'), `Mês: +${money(b.month.income, 'BRL')} / −${money(b.month.expense, 'BRL')}`) : ''}
    </div>
    <div class="grid-2">
      <section class="card"><div class="card-head"><h2>Contas</h2><a href="#/contas" class="small">Gerenciar</a></div>
        <div class="list">${d.accounts.length ? d.accounts.map(a => `<div class="row"><div class="grow"><div class="title">${esc(a.name)} ${a.is_reserve ? '<span class="tag ok">Reserva</span>' : ''}</div>
          <div class="meta">${a.anchor ? `Ref. ${fmtDate(a.anchor.date)} · ${a.anchor.status === 'confirmado' ? 'confirmado' : 'a confirmar'}` : 'Sem saldo de referência'}${a.pending ? ` · pendente ${money(a.pending, a.currency, { sign: true })}` : ''}</div></div>
          <span class="amount">${money(a.balance, a.currency)}</span></div>`).join('') : empty('Nenhuma conta cadastrada.')}</div></section>
      <section class="card"><div class="card-head"><h2>Entradas e saídas (EUR)</h2><a href="#/relatorios" class="small">Relatórios</a></div>
        ${groupedBars(months.map(m => monthLabel(m).slice(0, 3)), [{ name: 'Receitas', cls: 'c1', values: reports.map(r => r.income) }, { name: 'Despesas', cls: 'c2', values: reports.map(r => r.expense) }], 'EUR', { height: 200 })}</section>
    </div>
    <div class="grid-2">
      <section class="card"><div class="card-head"><h2>Orçamentos</h2><a href="#/orcamentos" class="small">Ver todos</a></div>${budgetList(d.budgets)}</section>
      <section class="card"><div class="card-head"><h2>Metas</h2><a href="#/metas" class="small">Ver todas</a></div>${goalList(d.goals)}</section>
    </div>
    ${pend.length ? `<section class="card"><div class="card-head"><h2>Pendentes de confirmação</h2><span class="tag warn">${pend.length}</span></div><div class="list">${pend.slice(0, 10).map(txRow).join('')}</div></section>` : ''}
    <section class="card"><div class="card-head"><h2>Últimos lançamentos</h2><a href="#/lancamentos" class="small">Ver todos</a></div>
      <div class="list">${f.transactions.length ? f.transactions.slice(0, 8).map(txRow).join('') : empty('Nenhum lançamento ainda.')}</div></section>`;
  host.querySelector('[data-act="add"]').onclick = () => quickAdd(refresh);
  host.querySelector('[data-act="transfer"]').onclick = () => transferForm(refresh);
  bindTxRows(host, refresh);
}

function budgetList(list) {
  if (!list.length) return empty('Nenhum orçamento ativo.', '<a href="#/orcamentos">Criar orçamento</a>');
  return `<div class="bars-h">${list.map(b => `<div class="item"><span>${esc(b.name)} · <span class="muted">${PERIOD_LABEL[b.period]}</span></span>
    <span class="money ${b.over ? 'neg' : ''}">${money(b.spent, b.currency)} / ${money(b.limit_cents, b.currency)}</span>
    <progress class="${b.over ? 'over' : b.spent > b.limit_cents * 0.8 ? 'near' : ''}" max="${b.limit_cents}" value="${Math.min(b.spent, b.limit_cents)}" aria-label="${esc(b.name)}"></progress>
    ${b.limitedByAvailability ? `<span class="hint neg">Só ${money(b.usable, b.currency)} livres de reservas.</span>` : ''}</div>`).join('')}</div>`;
}

function goalList(list) {
  if (!list.length) return empty('Nenhuma meta cadastrada.', '<a href="#/metas">Criar meta</a>');
  return `<div class="bars-h">${list.map(g => `<div class="item"><span>${esc(g.name)}${g.due_date ? ` · <span class="muted">até ${fmtDate(g.due_date)}</span>` : ''}</span>
    <span class="money">${g.current === null ? '—' : money(g.current, g.currency)} / ${money(g.target_cents, g.currency)}</span>
    <progress max="100" value="${g.pct ?? 0}" aria-label="${esc(g.name)}: ${g.pct ?? 0}%"></progress><span class="hint">${esc(g.note)}${g.pct !== null ? ` · ${g.pct.toLocaleString('pt-BR')}%` : ''}</span></div>`).join('')}</div>`;
}

// ───────────── Lançamentos ─────────────
const filters = { month: undefined, account: '', kind: '', status: '', q: '' };
let selecting = false;
export async function lancamentos(host, { refresh }) {
  filters.month ??= today().slice(0, 7);
  const f = S.fin;
  const months = [...new Set([today().slice(0, 7), ...f.transactions.map(t => t.date.slice(0, 7))])].sort().reverse();
  const q = filters.q.toLowerCase();
  const list = f.transactions.filter(t => (!filters.month || t.date.startsWith(filters.month)) && (!filters.account || t.account_id === filters.account)
    && (!filters.kind || t.kind === filters.kind) && (!filters.status || t.status === filters.status)
    && (!q || [t.description, t.merchant, t.category, t.notes].some(x => String(x || '').toLowerCase().includes(q))));
  host.innerHTML = `
    <div class="page-head"><div><h1>Lançamentos</h1><p>Toque em um lançamento para editar ou excluir. Toda alteração fica no histórico de auditoria.</p></div>
      <div class="actions"><button class="primary" data-act="add">+ Lançamento</button><button data-act="transfer">Transferência</button><a class="btn" href="/api/fin/export.csv" download>Exportar CSV</a></div></div>
    <form class="card filters" id="filters">
      <label>Mês<select name="month"><option value="">Todos</option>${months.map(m => `<option value="${m}"${m === filters.month ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}</select></label>
      <label>Conta<select name="account"><option value="">Todas</option>${f.accounts.map(a => `<option value="${esc(a.id)}"${a.id === filters.account ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label>Tipo<select name="kind"><option value="">Todos</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}"${k === filters.kind ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Status<select name="status"><option value="">Todos</option><option value="confirmada"${filters.status === 'confirmada' ? ' selected' : ''}>Confirmada</option><option value="pendente"${filters.status === 'pendente' ? ' selected' : ''}>Pendente</option></select></label>
      <label>Buscar<input name="q" type="search" value="${esc(filters.q)}" placeholder="Descrição, categoria…"></label>
    </form>
    <section class="card"><div class="card-head"><h2>${list.length} lançamento(s)</h2><button class="small" data-act="select">${selecting ? 'Cancelar seleção' : 'Selecionar vários'}</button></div>
      ${selecting ? `<div class="actions" id="bulk"><label class="check"><input type="checkbox" id="sel-all"> Todos</label><button class="small primary" data-bulk="confirmar">Confirmar</button><button class="small" data-bulk="pendente">Marcar pendente</button><button class="small" data-bulk="categoria">Classificar…</button><button class="small danger" data-bulk="excluir">Excluir</button></div>` : ''}
      <div class="list">${list.length ? list.map(t => selecting ? `<label class="row check"><input type="checkbox" data-sel="${esc(t.id)}"><span class="grow"><span class="title">${esc(t.description)}</span><br><span class="meta">${fmtDate(t.date)} · ${esc(t.category)} · ${t.status}</span></span><span class="amount ${sign(t)}">${money(t.amount_cents, t.currency, { sign: true })}</span></label>` : txRow(t)).join('') : empty('Nada encontrado com esses filtros.')}</div></section>`;
  host.querySelector('[data-act="select"]').onclick = () => { selecting = !selecting; lancamentos(host, { refresh }); };
  host.querySelector('#sel-all')?.addEventListener('change', e => host.querySelectorAll('[data-sel]').forEach(c => { c.checked = e.target.checked; }));
  host.querySelectorAll('[data-bulk]').forEach(b => b.addEventListener('click', async () => {
    const ids = [...host.querySelectorAll('[data-sel]:checked')].map(c => c.dataset.sel);
    if (!ids.length) return toast('Selecione ao menos um lançamento.', 'error');
    const action = b.dataset.bulk;
    const run = async extra => {
      const r = await withReserveConfirm(confirm_reserve => post('fin/transactions/bulk', { ids, action, confirm_reserve, ...extra }));
      selecting = false; toast(`${r.changed} lançamento(s) atualizados.`); await refresh();
    };
    if (action === 'categoria') return openForm({ title: `Classificar ${ids.length} lançamento(s)`, fields: [{ name: 'category', label: 'Categoria', required: true, list: S.fin.categories }], onSubmit: v => run({ category: v.category }) });
    if (action === 'excluir' && !await confirmDialog('Excluir lançamentos', `Excluir ${ids.length} lançamento(s)? A exclusão é lógica e fica na auditoria.`, { danger: true, confirmLabel: 'Excluir' })) return;
    try { await run({}); } catch (e) { toast(e.message, 'error'); }
  }));
  host.querySelector('[data-act="add"]').onclick = () => quickAdd(refresh);
  host.querySelector('[data-act="transfer"]').onclick = () => transferForm(refresh);
  const form = host.querySelector('#filters');
  form.addEventListener('change', () => { Object.assign(filters, Object.fromEntries(new FormData(form))); lancamentos(host, { refresh }); });
  form.q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); filters.q = form.q.value; lancamentos(host, { refresh }); } });
  bindTxRows(host, refresh);
}

// ───────────── Contas, saldos e conciliação ─────────────
export async function contas(host, { refresh }) {
  const d = S.dash, f = S.fin;
  const archived = f.accounts.filter(a => a.archived);
  host.innerHTML = `
    <div class="page-head"><div><h1>Contas e saldos</h1><p>Cada conta parte de uma <b>fotografia de saldo</b> (valor, data e fonte). Depois disso, só lançamentos confirmados alteram o saldo calculado.</p></div>
      <div class="actions"><button class="primary" data-act="new">+ Nova conta</button><button data-act="rate">Taxa EUR→BRL</button></div></div>
    <div class="banner">Sem integração bancária: os saldos são informados por você. Use <b>Conciliar</b> para comparar o saldo do app do banco com o calculado.</div>
    <section class="card"><div class="card-head"><div><h2>Reservas protegidas</h2><p class="muted small">Separam parte do saldo de uma conta. Não são despesa: o dinheiro continua na conta, mas sai do disponível e gastar dele pede confirmação.</p></div>
      <button class="small primary" data-act="reserve">+ Nova reserva</button></div>
      ${S.dash.reserves.length ? `<div class="bars-h">${S.dash.reserves.map(r => `<div class="item"><span><b>${esc(r.name)}</b> · <span class="muted">${esc(r.account_name)}</span>${r.overAllocated ? ' <span class="tag bad">maior que o saldo</span>' : ''}</span>
        <span class="money">${money(r.allocated_cents, r.currency)} / ${money(r.target_cents, r.currency)}</span>
        <progress max="${r.target_cents}" value="${Math.min(r.allocated_cents, r.target_cents)}" aria-label="${esc(r.name)}"></progress>
        <span class="hint">${r.deficit ? `Déficit: ${money(r.deficit, r.currency)}` : 'Reserva completa'} · <button class="small ghost" data-reserve="${esc(r.id)}">Ajustar</button></span></div>`).join('')}</div>` : empty('Nenhuma reserva. Ex.: “Moradia”, meta € 1.200, dentro da conta onde o dinheiro está.')}
    </section>
    <div class="grid">${d.accounts.map(a => `<section class="card"><div class="card-head"><div><h2>${esc(a.name)}</h2><span class="muted small">${esc(ACCOUNT_KINDS.find(k => k[0] === a.kind)?.[1] || a.kind)}${a.institution ? ' · ' + esc(a.institution) : ''} · ${a.currency}</span></div>${a.is_reserve ? '<span class="tag ok">Reserva protegida</span>' : ''}</div>
      <div><span class="eyebrow">Saldo calculado</span><p class="kpi-value">${money(a.balance, a.currency)}</p></div>
      ${a.pending ? `<p class="small muted">Pendentes (fora do saldo): ${money(a.pending, a.currency, { sign: true })}</p>` : ''}
      ${a.exclude_from_budget ? '<span class="tag">Fora do orçamento</span>' : ''}${a.notes ? `<p class="small muted">${esc(a.notes)}</p>` : ''}
      ${a.is_reserve && a.reserve_target_cents ? `<progress max="${a.reserve_target_cents}" value="${Math.max(0, Math.min(a.balance, a.reserve_target_cents))}" aria-label="Progresso da reserva"></progress><p class="small muted">Meta da reserva: ${money(a.reserve_target_cents, a.currency)}</p>` : ''}
      <p class="small">${a.anchor ? `Referência: ${money(a.anchor.amount_cents, a.currency)} em ${fmtDate(a.anchor.date)} · ${esc(a.anchor.source)} · ${a.anchor.status === 'confirmado' ? '<span class="tag ok">confirmado</span>' : '<span class="tag warn">a confirmar</span>'}` : '<span class="tag warn">Sem saldo de referência</span>'}</p>
      <div class="actions"><button class="small" data-recon="${esc(a.id)}">Conciliar</button><button class="small" data-snap="${esc(a.id)}">Registrar saldo</button><button class="small" data-hist="${esc(a.id)}">Histórico</button><button class="small ghost" data-edit="${esc(a.id)}">Editar</button></div>
    </section>`).join('') || empty('Nenhuma conta ainda. Crie a primeira para começar.')}</div>
    ${archived.length ? `<section class="card"><h2>Arquivadas</h2><div class="list">${archived.map(a => `<div class="row"><div class="grow">${esc(a.name)} (${a.currency})</div><button class="small" data-edit="${esc(a.id)}">Editar</button></div>`).join('')}</div></section>` : ''}`;
  host.querySelector('[data-act="new"]').onclick = () => accountForm(null, refresh);
  host.querySelector('[data-act="rate"]').onclick = () => rateForm(refresh);
  host.querySelector('[data-act="reserve"]').onclick = () => reserveForm(null, refresh);
  host.querySelectorAll('[data-reserve]').forEach(b => b.onclick = () => reserveForm(S.fin.reserves.find(r => r.id === b.dataset.reserve), refresh));
  host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => accountForm(accountById(b.dataset.edit), refresh));
  host.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => snapshotForm(accountById(b.dataset.snap), refresh));
  host.querySelectorAll('[data-recon]').forEach(b => b.onclick = () => reconcileForm(accountById(b.dataset.recon), refresh));
  host.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => snapshotHistory(accountById(b.dataset.hist), refresh));
}

function accountForm(a, refresh) {
  const fields = [
    { name: 'name', label: 'Nome da conta', required: true, value: a?.name, max: 80, hint: 'Ex.: Revolut EUR' },
    { name: 'institution', label: 'Instituição', value: a?.institution, max: 80 },
    { name: 'kind', label: 'Tipo', type: 'select', options: ACCOUNT_KINDS, value: a?.kind || 'banco' },
    ...(a ? [] : [{ name: 'currency', label: 'Moeda', type: 'select', options: [['EUR', 'Euro (EUR)'], ['BRL', 'Real (BRL)']], value: 'EUR' }]),
    { name: 'is_reserve', label: 'Reserva protegida (retiradas exigem confirmação)', type: 'checkbox', value: a?.is_reserve, full: true },
    { name: 'reserve_target', label: 'Meta da reserva (opcional)', type: 'money', value: a?.reserve_target_cents },
    { name: 'exclude_from_budget', label: 'Fora do orçamento (ex.: moedas separadas para o ônibus)', type: 'checkbox', value: a?.exclude_from_budget, full: true },
    { name: 'notes', label: 'Observações', type: 'textarea', value: a?.notes, max: 1000 },
    ...(a ? [{ name: 'archived', label: 'Arquivar conta (some do painel)', type: 'checkbox', value: a.archived }] : [
      { type: 'info', html: '<b>Saldo de referência</b> — fotografia do saldo numa data. Não gera lançamentos nem débitos retroativos.' },
      { name: 'snap_amount', label: 'Saldo informado', type: 'money', hint: 'Deixe vazio para começar em zero' },
      { name: 'snap_date', label: 'Data do saldo', type: 'date', value: today() },
      { name: 'snap_source', label: 'Fonte', value: 'Último registro informado pelo titular', full: true },
      { name: 'snap_status', label: 'Status', type: 'select', options: [['a_confirmar', 'A confirmar (fotografia histórica)'], ['confirmado', 'Confirmado no app do banco']], value: 'a_confirmar' }]),
  ];
  openForm({
    title: a ? 'Editar conta' : 'Nova conta', fields,
    onSubmit: async v => {
      const saved = await post('fin/accounts', { id: a?.id, version: a?.version, name: v.name, institution: v.institution, kind: v.kind, currency: v.currency, is_reserve: v.is_reserve, reserve_target_cents: v.reserve_target, archived: v.archived, exclude_from_budget: v.exclude_from_budget, notes: v.notes });
      if (!a && v.snap_amount !== null && v.snap_amount !== undefined) {
        await post('fin/snapshots', { account_id: saved.id, amount_cents: v.snap_amount, date: v.snap_date, source: v.snap_source || 'Informado pelo titular', status: v.snap_status, is_anchor: true });
      }
      toast(a ? 'Conta atualizada.' : 'Conta criada.'); await refresh();
    },
  });
}

function reserveForm(r, refresh) {
  if (needAccounts()) return;
  openForm({
    title: r ? `Reserva · ${r.name}` : 'Nova reserva protegida',
    intro: '<div class="banner small">Informe quanto do saldo da conta já está guardado para esta reserva. Ajustar o valor reservado não cria lançamento nem mexe no saldo da conta.</div>',
    fields: [
      { name: 'name', label: 'Nome', required: true, value: r?.name, hint: 'Ex.: Moradia' },
      { name: 'account_id', label: 'Conta onde o dinheiro está', type: 'select', options: accountOptions(), value: r?.account_id },
      { name: 'target', label: 'Meta da reserva', type: 'money', required: true, value: r?.target_cents },
      { name: 'allocated', label: 'Valor já reservado', type: 'money', required: true, value: r?.allocated_cents ?? 0 },
      { name: 'notes', label: 'Observações', type: 'textarea', value: r?.notes },
      ...(r ? [{ name: 'archived', label: 'Encerrar reserva (libera o valor)', type: 'checkbox', value: r.archived }] : []),
    ],
    onSubmit: async v => { await post('fin/reserves', { id: r?.id, version: r?.version, name: v.name, account_id: v.account_id, target_cents: v.target, allocated_cents: v.allocated, notes: v.notes, archived: v.archived }); toast('Reserva salva.'); await refresh(); },
  });
}

function snapshotForm(a, refresh) {
  openForm({
    title: `Registrar saldo · ${a.name}`,
    intro: '<div class="banner small">Uma fotografia marcada como <b>novo ponto de partida</b> passa a ser a base do saldo calculado; lançamentos anteriores a ela deixam de somar. Nenhum lançamento é criado.</div>',
    fields: [
      { name: 'amount', label: `Saldo (${a.currency})`, type: 'money', required: true },
      { name: 'date', label: 'Data', type: 'date', required: true, value: today() },
      { name: 'source', label: 'Fonte', required: true, value: 'App do banco', full: true },
      { name: 'status', label: 'Status', type: 'select', options: [['confirmado', 'Confirmado'], ['a_confirmar', 'A confirmar']], value: 'confirmado' },
      { name: 'is_anchor', label: 'Usar como novo ponto de partida', type: 'checkbox', value: !a.anchor },
      { name: 'note', label: 'Observação', type: 'textarea' },
    ],
    onSubmit: async v => { await post('fin/snapshots', { account_id: a.id, amount_cents: v.amount, date: v.date, source: v.source, status: v.status, is_anchor: v.is_anchor, note: v.note }); toast('Saldo registrado.'); await refresh(); },
  });
}

function reconcileForm(a, refresh) {
  openForm({
    title: `Conciliar · ${a.name}`, submitLabel: 'Comparar',
    intro: '<div class="banner small">Informe o saldo que aparece agora no app do banco. O sistema compara com o saldo calculado na mesma data e você decide o que fazer.</div>',
    fields: [
      { name: 'reported', label: `Saldo no banco (${a.currency})`, type: 'money', required: true },
      { name: 'date', label: 'Data', type: 'date', required: true, value: today() },
      { name: 'source', label: 'Fonte', value: 'App do banco', full: true },
      { type: 'info', html: '<span id="recon-result">Toque em <b>Comparar</b> para ver a diferença.</span>' },
    ],
    extra: [
      { label: 'Registrar conferência', onClick: d => act('registrar', d) },
      { label: 'Lançar ajuste da diferença', onClick: d => act('ajustar', d) },
      { label: 'Usar como ponto de partida', onClick: d => act('ancorar', d) },
    ],
    onSubmit: async (v, d) => {
      const r = await post('fin/reconcile', { account_id: a.id, reported_cents: v.reported, date: v.date, mode: 'verificar' });
      d.querySelector('#recon-result').innerHTML = r.matches
        ? `<span class="pos"><b>Confere.</b> Saldo calculado: ${money(r.computed, a.currency)}.</span>`
        : `<b>Diferença de ${money(r.difference, a.currency, { sign: true })}</b> (calculado ${money(r.computed, a.currency)}). Possíveis causas: lançamentos não registrados${r.pending ? ` ou pendentes de ${money(r.pending, a.currency, { sign: true })}` : ''}. Escolha uma ação abaixo.`;
      return false;
    },
  });
  async function act(mode, d) {
    const form = d.querySelector('form');
    const reported = parseAmount(form.reported.value);
    if (reported === null) throw new Error('Informe o saldo do banco.');
    const labels = { registrar: 'Registrar a conferência sem alterar saldos?', ajustar: 'Criar um lançamento de ajuste com a diferença? Ele altera o saldo calculado.', ancorar: 'Usar este valor como novo ponto de partida? Lançamentos anteriores deixam de somar no saldo.' };
    if (!await confirmDialog('Confirmar conciliação', labels[mode])) return;
    const date = brToIso(form.date.value);
    if (!date) throw new Error('Data inválida. Use dd/mm/aaaa.');
    await withReserveConfirm(confirm_reserve => post('fin/reconcile', { account_id: a.id, reported_cents: reported, date, source: form.source.value, mode, confirm_reserve }));
    d.close(); toast('Conciliação registrada.'); await refresh();
  }
}

function snapshotHistory(a, refresh) {
  const list = S.fin.snapshots.filter(s => s.account_id === a.id);
  const dlg = document.getElementById('dialog');
  dlg.innerHTML = `<form class="modal" method="dialog"><div class="modal-head"><h2>Histórico de saldos · ${esc(a.name)}</h2><button class="ghost small" aria-label="Fechar">${icon('close')}</button></div>
    <div class="modal-body"><div class="list">${list.map(s => `<div class="row"><div class="grow"><div class="title">${money(s.amount_cents, a.currency)} · ${fmtDate(s.date)}</div>
      <div class="meta">${esc(s.source)}${s.note ? ' · ' + esc(s.note) : ''}</div></div>${s.is_anchor ? '<span class="tag">Ponto de partida</span>' : ''}
      ${s.status === 'confirmado' ? '<span class="tag ok">Confirmado</span>' : `<button type="button" class="small" data-confirm="${esc(s.id)}">Confirmar</button>`}
      <button type="button" class="small ghost danger" data-del="${esc(s.id)}" aria-label="Excluir fotografia">${icon('close')}</button></div>`).join('') || empty('Sem registros.')}</div></div></form>`;
  dlg.querySelectorAll('[data-confirm]').forEach(b => b.onclick = async () => { await post(`fin/snapshots/${b.dataset.confirm}/confirm`); dlg.close(); toast('Saldo confirmado.'); await refresh(); });
  dlg.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog('Excluir fotografia de saldo', 'Se for o ponto de partida, o saldo passa a usar a fotografia anterior.', { danger: true, confirmLabel: 'Excluir' })) return;
    await del('fin/snapshots/' + b.dataset.del); dlg.close(); toast('Fotografia excluída.'); await refresh();
  });
  dlg.showModal();
}

function rateForm(refresh) {
  const cur = Number(S.fin.settings.eur_brl_milli) || null;
  openForm({
    title: 'Taxa EUR → BRL (manual)',
    intro: '<div class="banner small">Usada só para somar o patrimônio em uma moeda. Não há cotação automática: informe a taxa e a data em que você a consultou.</div>',
    fields: [
      { name: 'rate', label: 'Quanto vale 1 € em reais', type: 'decimal', required: true, value: cur ? String(cur / 1000).replace('.', ',') : '', hint: 'Ex.: 6,25' },
      { name: 'date', label: 'Data da consulta', type: 'date', required: true, value: S.fin.settings.eur_brl_date || today() },
    ],
    onSubmit: async v => {
      const milli = parseRateMilli(v.rate);
      if (!milli) throw new Error('Taxa inválida. Use até 4 casas decimais, ex.: 6,2534.');
      await post('fin/settings', { eur_brl_milli: milli, eur_brl_date: v.date }); toast('Taxa salva.'); await refresh();
    },
  });
}

// ───────────── Recibos e screenshots ─────────────
export async function recibos(host, { refresh }) {
  const inbox = S.fin.attachments.filter(a => !a.transaction_id);
  host.innerHTML = `
    <div class="page-head"><div><h1>Recibos e comprovantes</h1><p>Envie uma foto ou screenshot. O texto é lido <b>no seu aparelho</b>, os dados são sugeridos e nada é lançado sem a sua confirmação.</p></div></div>
    <section class="card">
      <div class="actions"><label class="btn primary file-btn">${icon('camera')} Escolher foto, screenshot ou PDF<input type="file" id="receipt-file" class="visually-hidden" accept="image/*,application/pdf"></label></div>
      <p class="hint">No celular, você pode tirar a foto na hora. Imagens são reduzidas para até ~1,3 MB antes de salvar.</p>
      <div id="receipt-work"></div>
    </section>
    <section class="card"><h2>Ler texto colado</h2><p class="muted small">Também funciona com o texto de uma notificação ou e-mail do banco.</p>
      <textarea id="receipt-text" placeholder="Cole aqui o texto do comprovante"></textarea><div class="actions"><button id="parse-text">Extrair dados</button></div></section>
    <section class="card"><div class="card-head"><h2>Comprovantes sem lançamento</h2><span class="tag">${inbox.length}</span></div>
      <div class="list">${inbox.map(a => `<div class="row"><div class="grow"><div class="title"><a href="/api/fin/attachments/${esc(a.id)}" target="_blank" rel="noopener">${esc(a.filename)}</a></div>
        <div class="meta">${new Date(a.created_at).toLocaleString('pt-BR')} · ${Math.round(a.size / 1024)} KB</div></div>
        <button class="small" data-launch="${esc(a.id)}">Lançar</button><button class="small ghost danger" data-del="${esc(a.id)}" aria-label="Excluir anexo">${icon('close')}</button></div>`).join('') || empty('Nenhum comprovante aguardando.')}</div></section>`;
  const work = host.querySelector('#receipt-work');
  host.querySelector('#receipt-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    work.innerHTML = '<p class="muted">Preparando arquivo…</p>';
    try {
      const prepared = await prepareFile(file);
      work.innerHTML = `${prepared.preview ? `<img class="receipt-preview" src="${prepared.preview}" alt="Comprovante selecionado">` : '<p>PDF selecionado.</p>'}
        <p class="small muted" id="ocr-status">${prepared.preview ? 'Lendo texto no aparelho…' : 'PDF: preencha os dados manualmente.'}</p>`;
      const status = () => host.querySelector('#ocr-status');
      let parsed = { date: null, merchant: null, amount_cents: null, currency: null, found: [] }, text = '';
      if (prepared.preview) {
        try { text = await readText(prepared.blob, p => { if (status()) status().textContent = `Lendo texto no aparelho… ${p}%`; }); parsed = parseReceipt(text); }
        catch (err) { status().textContent = `${err.message} Preencha manualmente.`; }
      }
      // O comprovante é guardado já com os dados extraídos, para ficar auditável mesmo se você não lançar agora.
      const att = await post('fin/attachments', { filename: file.name.slice(0, 100) || 'recibo', mime: prepared.mime, data_b64: prepared.b64, extracted: { ...parsed, text: text.slice(0, 2500) } });
      S.fin.attachments.unshift(att); // aparece na caixa de comprovantes mesmo se você cancelar o lançamento
      if (text) status().innerHTML = `Campos encontrados: ${parsed.found.length ? parsed.found.map(k => ({ date: 'data', merchant: 'estabelecimento', amount_cents: 'valor', currency: 'moeda' }[k])).join(', ') : 'nenhum'}. Comprovante salvo. <details><summary>Texto lido</summary><div class="ocr-text">${esc(text)}</div></details>`;
      else status().textContent = 'Comprovante salvo.';
      await confirmReceipt(parsed, [att.id], refresh, text);
    } catch (err) { work.innerHTML = `<div class="banner error">${esc(err.message)}</div>`; }
    e.target.value = '';
  });
  host.querySelector('#parse-text').onclick = () => { const t = host.querySelector('#receipt-text').value; confirmReceipt(parseReceipt(t), [], refresh, t); };
  host.querySelectorAll('[data-launch]').forEach(b => b.onclick = () => {
    const a = inbox.find(x => x.id === b.dataset.launch);
    let ex = {}; try { ex = JSON.parse(a.extracted_json || '{}'); } catch { /* sem dados extraídos */ }
    confirmReceipt({ date: null, merchant: null, amount_cents: null, currency: null, ...ex }, [a.id], refresh, ex.text || '');
  });
  host.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog('Excluir comprovante', 'O arquivo será removido do banco. A exclusão fica registrada na auditoria.', { danger: true, confirmLabel: 'Excluir' })) return;
    await del('fin/attachments/' + b.dataset.del); toast('Comprovante excluído.'); await refresh();
  });
}

// Formulário de confirmação do recibo, com alerta de duplicidade.
async function confirmReceipt(parsed, attachmentIds, refresh, text = '') {
  if (needAccounts()) return;
  const currency = parsed.currency || 'EUR';
  let duplicates = [], suggestion = null;
  if (parsed.amount_cents && parsed.date) {
    try { ({ duplicates, suggestion } = await post('fin/receipts/check', { amount_cents: parsed.amount_cents, date: parsed.date, currency, merchant: parsed.merchant, text })); }
    catch { /* verificação é auxiliar */ }
  }
  // Passo 4: conta de origem sugerida (moeda, nome do banco no comprovante, histórico do estabelecimento).
  const acc = (suggestion && accountById(suggestion.id)) || activeAccounts().find(a => a.currency === currency && !a.is_reserve && !a.exclude_from_budget) || activeAccounts()[0];
  editTransaction(null, refresh, {
    kind: 'despesa', amount_cents: parsed.amount_cents, date: parsed.date || today(), description: parsed.merchant ? `Compra ${parsed.merchant}` : '',
    merchant: parsed.merchant, account_id: acc?.id, status: 'confirmada', attachment_ids: attachmentIds,
  });
  const body = document.querySelector('#dialog .modal-body');
  if (!body) return;
  const dupHtml = duplicates.length ? `<div class="banner warn"><b>Possível duplicidade.</b> Se o gasto já está registrado, concilie em vez de lançar de novo:
    <div class="list">${duplicates.slice(0, 3).map(d => `<div class="row"><div class="grow small">${esc(d.description)} · ${fmtDate(d.date)} · ${money(d.amount_cents, currency)} (${esc(accountName(d.account_id))})</div>
    <button type="button" class="small" data-reconcile="${esc(d.id)}">Conciliar com este</button></div>`).join('')}</div></div>` : '';
  body.insertAdjacentHTML('afterbegin', `<div class="banner small">Dados sugeridos a partir do comprovante. Nada foi descontado: só será registrado quando você tocar em <b>Salvar</b>.
    ${suggestion ? `<br>Conta sugerida: <b>${esc(suggestion.name)}</b> (${esc(suggestion.why.join(', '))}).` : ''}${parsed.currency && parsed.currency !== acc?.currency ? ` Moeda detectada: ${parsed.currency}.` : ''}</div>${dupHtml}`);
  body.querySelectorAll('[data-reconcile]').forEach(b => b.addEventListener('click', async () => {
    await post(`fin/transactions/${b.dataset.reconcile}/reconcile`, { attachment_ids: attachmentIds });
    document.getElementById('dialog').close(); toast('Comprovante conciliado com o lançamento existente. Nenhum valor novo foi lançado.'); await refresh();
  }));
}

// ───────────── Orçamentos ─────────────
export async function orcamentos(host, { refresh }) {
  const list = S.fin.budgets.map(b => budgetStatus(b, S.fin.transactions, today()));
  host.innerHTML = `
    <div class="page-head"><div><h1>Orçamentos</h1><p>Limites diários, semanais (segunda a domingo) ou mensais, por categoria ou gerais. Contam só despesas; transferências ficam de fora.</p></div>
      <div class="actions"><button class="primary" data-act="new">+ Novo orçamento</button></div></div>
    <section class="card">${list.length ? `<div class="list">${list.map(b => `<div class="row"><div class="grow"><div class="title">${esc(b.name)} ${b.active ? '' : '<span class="tag">Inativo</span>'}</div>
      <div class="meta">${PERIOD_LABEL[b.period]} · ${b.category ? esc(b.category) : 'Todas as categorias'} · ${fmtDate(b.from)} a ${fmtDate(b.to)}${b.pending ? ` · pendente ${money(b.pending, b.currency)}` : ''}</div>
      <progress class="${b.over ? 'over' : b.spent > b.limit_cents * 0.8 ? 'near' : ''}" max="${b.limit_cents}" value="${Math.min(b.spent, b.limit_cents)}" aria-label="${esc(b.name)}"></progress></div>
      <div class="r"><div class="amount ${b.over ? 'neg' : ''}">${money(b.spent, b.currency)}</div><div class="meta">de ${money(b.limit_cents, b.currency)}</div></div>
      <button class="small ghost" data-edit="${esc(b.id)}">Editar</button></div>`).join('')}</div>` : empty('Nenhum orçamento ainda.')}</section>`;
  host.querySelector('[data-act="new"]').onclick = () => budgetForm(null, refresh);
  host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => budgetForm(S.fin.budgets.find(x => x.id === b.dataset.edit), refresh));
}

function budgetForm(b, refresh) {
  openForm({
    title: b ? 'Editar orçamento' : 'Novo orçamento',
    fields: [
      { name: 'name', label: 'Nome', required: true, value: b?.name, hint: 'Ex.: Alimentação do dia' },
      { name: 'category', label: 'Categoria (vazio = todas)', value: b?.category, list: S.fin.categories },
      { name: 'period', label: 'Período', type: 'select', options: Object.entries(PERIOD_LABEL), value: b?.period || 'mensal' },
      { name: 'limit', label: 'Limite', type: 'money', required: true, value: b?.limit_cents },
      { name: 'currency', label: 'Moeda', type: 'select', options: ['EUR', 'BRL'], value: b?.currency || 'EUR' },
      { name: 'active', label: 'Ativo', type: 'checkbox', value: b ? b.active : true },
    ],
    extra: b ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir orçamento', `Excluir “${b.name}”?`, { danger: true, confirmLabel: 'Excluir' })) { await del('fin/budgets/' + b.id); d.close(); await refresh(); } } }] : [],
    onSubmit: async v => { await post('fin/budgets', { id: b?.id, version: b?.version, name: v.name, category: v.category, period: v.period, limit_cents: v.limit, currency: v.currency, active: v.active }); toast('Orçamento salvo.'); await refresh(); },
  });
}

// ───────────── Fixas e recorrentes ─────────────
export async function recorrentes(host, { refresh }) {
  const list = S.fin.recurring;
  const monthTotal = cur => list.filter(r => r.active && r.kind === 'despesa' && accountById(r.account_id)?.currency === cur)
    .reduce((s, r) => s + (r.frequency === 'mensal' ? r.amount_cents : r.frequency === 'semanal' ? Math.round(r.amount_cents * 52 / 12) : Math.round(r.amount_cents / 12)), 0);
  host.innerHTML = `
    <div class="page-head"><div><h1>Fixas, recorrentes e planejadas</h1><p>Nada aqui mexe no saldo. O sistema avisa as datas, mas <b>não lança sozinho</b>: toque em “Lançar” quando o pagamento acontecer.</p></div>
      <div class="actions"><button class="primary" data-act="new">+ Recorrência</button><button data-act="plan">+ Planejada</button></div></div>
    <div class="kpis"><div class="kpi"><span class="eyebrow">Compromisso mensal (EUR)</span><span class="value">${money(monthTotal('EUR'), 'EUR')}</span></div>
      <div class="kpi"><span class="eyebrow">Compromisso mensal (BRL)</span><span class="value">${money(monthTotal('BRL'), 'BRL')}</span></div></div>
    <section class="card">${list.length ? `<div class="list">${list.map(r => { const acc = accountById(r.account_id); const late = r.active && r.next_date < today(); return `<div class="row"><div class="grow">
      <div class="title">${esc(r.description)} ${r.is_fixed ? '<span class="tag">Fixa</span>' : '<span class="tag">Variável</span>'} ${r.active ? '' : '<span class="tag">Inativa</span>'}</div>
      <div class="meta">${FREQ_LABEL[r.frequency]} · próxima ${fmtDate(r.next_date)} ${late ? '<span class="tag warn">vencida</span>' : ''} · ${esc(acc?.name || '')}</div></div>
      <span class="amount ${r.kind === 'despesa' ? 'neg' : 'pos'}">${money(r.kind === 'despesa' ? -r.amount_cents : r.amount_cents, acc?.currency || 'EUR', { sign: true })}</span>
      ${r.active ? `<button class="small" data-launch="${esc(r.id)}">Lançar</button><button class="small ghost" data-skip="${esc(r.id)}">Pular</button>` : ''}<button class="small ghost" data-edit="${esc(r.id)}">Editar</button></div>`; }).join('')}</div>` : empty('Nenhuma recorrência cadastrada.')}</section>`;
  host.insertAdjacentHTML('beforeend', plannedSection());
  host.querySelector('[data-act="new"]').onclick = () => recurringForm(null, refresh);
  host.querySelector('[data-act="plan"]').onclick = () => plannedForm(null, refresh);
  host.querySelectorAll('[data-plan-edit]').forEach(b => b.onclick = () => plannedForm(S.fin.planned.find(p => p.id === b.dataset.planEdit), refresh));
  host.querySelectorAll('[data-plan-launch]').forEach(b => b.onclick = () => {
    const p = S.fin.planned.find(x => x.id === b.dataset.planLaunch);
    openForm({
      title: `Lançar · ${p.description}`, submitLabel: 'Lançar',
      fields: [{ name: 'account_id', label: 'Conta', type: 'select', options: accountOptions(), value: p.account_id }, { name: 'amount', label: 'Valor', type: 'money', required: true, value: p.amount_cents },
        { name: 'date', label: 'Data', type: 'date', required: true, value: p.due_date || today() }, { name: 'status', label: 'Status', type: 'select', options: [['confirmada', 'Confirmada'], ['pendente', 'Pendente']], value: 'confirmada' }],
      onSubmit: async v => { await withReserveConfirm(confirm_reserve => post(`fin/planned/${p.id}/launch`, { account_id: v.account_id, amount_cents: v.amount, date: v.date, status: v.status, confirm_reserve })); toast('Lançado.'); await refresh(); },
    });
  });
  host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => recurringForm(list.find(x => x.id === b.dataset.edit), refresh));
  host.querySelectorAll('[data-skip]').forEach(b => b.onclick = async () => { if (await confirmDialog('Pular ocorrência', 'Avançar para a próxima data sem lançar nada?')) { await post(`fin/recurring/${b.dataset.skip}/skip`); await refresh(); } });
  host.querySelectorAll('[data-launch]').forEach(b => b.onclick = () => {
    const r = list.find(x => x.id === b.dataset.launch);
    openForm({
      title: `Lançar · ${r.description}`, submitLabel: 'Lançar',
      fields: [{ name: 'amount', label: 'Valor desta vez', type: 'money', required: true, value: r.amount_cents }, { name: 'date', label: 'Data', type: 'date', required: true, value: r.next_date },
        { name: 'status', label: 'Status', type: 'select', options: [['confirmada', 'Confirmada'], ['pendente', 'Pendente']], value: 'confirmada' }],
      onSubmit: async v => { await withReserveConfirm(confirm_reserve => post(`fin/recurring/${r.id}/launch`, { amount_cents: v.amount, date: v.date, status: v.status, confirm_reserve })); toast('Lançado.'); await refresh(); },
    });
  });
}

function plannedSection() {
  const list = (S.fin.planned || []).filter(p => p.status === 'planejada');
  const done = (S.fin.planned || []).filter(p => p.status !== 'planejada').slice(0, 10);
  const row = p => `<div class="row"><div class="grow"><div class="title">${esc(p.description)} <span class="tag">${p.status === 'planejada' ? 'Planejada' : p.status === 'lancada' ? 'Lançada' : 'Cancelada'}</span></div>
    <div class="meta">${p.due_date ? fmtDate(p.due_date) : 'Sem data'} · ${esc(p.category)}${p.account_id ? ' · ' + esc(accountName(p.account_id)) : ''}${p.due_date && p.due_date < today() && p.status === 'planejada' ? ' · <span class="neg">data passou</span>' : ''}</div></div>
    <span class="amount ${p.kind === 'despesa' ? 'neg' : 'pos'}">${money(p.kind === 'despesa' ? -p.amount_cents : p.amount_cents, p.currency, { sign: true })}</span>
    ${p.status === 'planejada' ? `<button class="small" data-plan-launch="${esc(p.id)}">Lançar</button>` : ''}<button class="small ghost" data-plan-edit="${esc(p.id)}">Editar</button></div>`;
  return `<section class="card"><div class="card-head"><div><h2>Planejadas</h2><p class="muted small">Gastos ou receitas previstos uma vez (ex.: passagem, curso). Ficam fora do saldo e aparecem como “planejado” no painel.</p></div></div>
    <div class="list">${list.map(row).join('') || empty('Nada planejado.')}</div>${done.length ? `<details><summary>Lançadas e canceladas</summary><div class="list">${done.map(row).join('')}</div></details>` : ''}</section>`;
}

function plannedForm(p, refresh) {
  openForm({
    title: p ? 'Editar planejada' : 'Nova despesa/receita planejada',
    fields: [
      { name: 'description', label: 'Descrição', required: true, value: p?.description, full: true },
      { name: 'kind', label: 'Tipo', type: 'select', options: [['despesa', 'Despesa'], ['receita', 'Receita']], value: p?.kind || 'despesa' },
      { name: 'amount', label: 'Valor previsto', type: 'money', required: true, value: p?.amount_cents },
      { name: 'account_id', label: 'Conta prevista', type: 'select', options: [['', '— definir depois —'], ...accountOptions()], value: p?.account_id || '' },
      { name: 'currency', label: 'Moeda (se sem conta)', type: 'select', options: ['EUR', 'BRL'], value: p?.currency || 'EUR' },
      { name: 'due_date', label: 'Data prevista', type: 'date', value: p?.due_date || '' },
      { name: 'category', label: 'Categoria', value: p?.category || 'Outros', list: S.fin.categories },
      ...(p ? [{ name: 'status', label: 'Situação', type: 'select', options: [['planejada', 'Planejada'], ['cancelada', 'Cancelada']], value: p.status === 'lancada' ? 'planejada' : p.status }] : []),
      { name: 'notes', label: 'Notas', type: 'textarea', value: p?.notes },
    ],
    extra: p ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir planejada', `Excluir “${p.description}”?`, { danger: true, confirmLabel: 'Excluir' })) { await del('fin/planned/' + p.id); d.close(); await refresh(); } } }] : [],
    onSubmit: async v => { await post('fin/planned', { id: p?.id, version: p?.version, description: v.description, kind: v.kind, amount_cents: v.amount, account_id: v.account_id || null, currency: v.currency, due_date: v.due_date || null, category: v.category, status: p?.status === 'lancada' ? 'lancada' : v.status, notes: v.notes }); toast('Salvo.'); await refresh(); },
  });
}

function recurringForm(r, refresh) {
  if (needAccounts()) return;
  openForm({
    title: r ? 'Editar recorrência' : 'Nova recorrência',
    fields: [
      { name: 'description', label: 'Descrição', required: true, value: r?.description, full: true, hint: 'Ex.: Aluguel, Internet, Seguro' },
      { name: 'kind', label: 'Tipo', type: 'select', options: [['despesa', 'Despesa'], ['receita', 'Receita']], value: r?.kind || 'despesa' },
      { name: 'amount', label: 'Valor', type: 'money', required: true, value: r?.amount_cents },
      { name: 'account_id', label: 'Conta', type: 'select', options: accountOptions(), value: r?.account_id },
      { name: 'category', label: 'Categoria', value: r?.category || 'Contas', list: S.fin.categories },
      { name: 'frequency', label: 'Frequência', type: 'select', options: Object.entries(FREQ_LABEL), value: r?.frequency || 'mensal' },
      { name: 'next_date', label: 'Próxima data', type: 'date', required: true, value: r?.next_date || today() },
      { name: 'is_fixed', label: 'Valor fixo', type: 'checkbox', value: r ? r.is_fixed : true },
      { name: 'active', label: 'Ativa', type: 'checkbox', value: r ? r.active : true },
    ],
    extra: r ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir recorrência', 'Lançamentos já feitos continuam no extrato.', { danger: true, confirmLabel: 'Excluir' })) { await del('fin/recurring/' + r.id); d.close(); await refresh(); } } }] : [],
    onSubmit: async v => { await post('fin/recurring', { ...v, id: r?.id, version: r?.version, amount_cents: v.amount }); toast('Recorrência salva.'); await refresh(); },
  });
}

// ───────────── Delivery ─────────────
export async function delivery(host, { refresh }) {
  const shifts = S.fin.shifts;
  const month = today().slice(0, 7);
  const stats = deliveryStats(shifts.filter(s => s.date.startsWith(month)));
  const all30 = deliveryStats(shifts.filter(s => s.date >= addMonths(today(), -1)));
  const kpis = (list, label) => list.map(s => `<div class="kpi"><span class="eyebrow">${label} · ${s.currency}</span><span class="value">${money(s.net, s.currency)}</span>
    <span class="sub">${s.shifts} turno(s) · ${(s.hours_x100 / 100).toLocaleString('pt-BR')} h · ${s.per_hour !== null ? money(s.per_hour, s.currency) + '/h' : '—'} · ${s.per_km !== null ? money(s.per_km, s.currency) + '/km' : '—'}</span></div>`).join('');
  host.innerHTML = `
    <div class="page-head"><div><h1>Controle do delivery</h1><p>Registre cada turno: horas, km, pedidos, ganhos, gorjetas e custos. Opcionalmente lance o resultado no extrato da conta.</p></div>
      <div class="actions"><button class="primary" data-act="new">+ Registrar turno</button></div></div>
    <div class="kpis">${kpis(stats, 'Líquido no mês') || '<div class="kpi"><span class="eyebrow">Líquido no mês</span><span class="value">—</span></div>'}${kpis(all30, 'Últimos 30 dias')}</div>
    <section class="card"><h2>Turnos</h2>${shifts.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Plataforma</th><th class="r">Horas</th><th class="r">Km</th><th class="r">Pedidos</th><th class="r">Ganhos + gorjetas</th><th class="r">Custos</th><th class="r">Líquido</th><th></th></tr></thead><tbody>
      ${shifts.map(s => `<tr><td>${fmtDate(s.date)}</td><td>${esc(s.platform)}</td><td class="r num">${(s.hours_x100 / 100).toLocaleString('pt-BR')}</td><td class="r num">${(s.km_x10 / 10).toLocaleString('pt-BR')}</td><td class="r num">${s.orders}</td>
        <td class="r money">${money(s.gross_cents + s.tips_cents, s.currency)}</td><td class="r money">${money(s.costs_cents, s.currency)}</td><td class="r money">${money(s.gross_cents + s.tips_cents - s.costs_cents, s.currency)}</td>
        <td><button class="small ghost" data-edit="${esc(s.id)}">Editar</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum turno registrado.')}</section>`;
  host.querySelector('[data-act="new"]').onclick = () => shiftForm(null, refresh);
  host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => shiftForm(shifts.find(x => x.id === b.dataset.edit), refresh));
}

function shiftForm(s, refresh) {
  const platforms = [...new Set(['Uber Eats', 'Deliveroo', 'Just Eat', 'Bolt Food', 'Glovo', ...S.fin.shifts.map(x => x.platform)])];
  openForm({
    title: s ? 'Editar turno' : 'Registrar turno',
    fields: [
      { name: 'date', label: 'Data', type: 'date', required: true, value: s?.date || today() },
      { name: 'platform', label: 'Plataforma', required: true, value: s?.platform, list: platforms },
      { name: 'hours', label: 'Horas trabalhadas', type: 'decimal', value: s ? String(s.hours_x100 / 100).replace('.', ',') : '', hint: 'Ex.: 4,5' },
      { name: 'km', label: 'Quilômetros', type: 'decimal', value: s ? String(s.km_x10 / 10).replace('.', ',') : '' },
      { name: 'orders', label: 'Pedidos', type: 'number', value: s?.orders ?? '' },
      { name: 'gross', label: 'Ganhos (sem gorjetas)', type: 'money', value: s?.gross_cents },
      { name: 'tips', label: 'Gorjetas', type: 'money', value: s?.tips_cents },
      { name: 'costs', label: 'Custos (combustível, manutenção…)', type: 'money', value: s?.costs_cents },
      { name: 'account_id', label: 'Conta que recebe', type: 'select', options: [['', '— nenhuma —'], ...accountOptions()], value: s?.account_id || '' },
      ...(s ? [] : [{ name: 'register', label: 'Lançar ganhos e custos no extrato desta conta', type: 'checkbox', value: false, full: true },
        { name: 'status', label: 'Status dos lançamentos', type: 'select', options: [['pendente', 'Pendente (até o repasse cair)'], ['confirmada', 'Confirmada']], value: 'pendente' }]),
      { name: 'notes', label: 'Notas', type: 'textarea', value: s?.notes },
    ],
    extra: s ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir turno', 'Lançamentos já criados no extrato não são removidos.', { danger: true, confirmLabel: 'Excluir' })) { await del('fin/shifts/' + s.id); d.close(); await refresh(); } } }] : [],
    onSubmit: async v => {
      const acc = v.account_id ? accountById(v.account_id) : null;
      await withReserveConfirm(confirm_reserve => post('fin/shifts', { id: s?.id, version: s?.version, date: v.date, platform: v.platform, hours_x100: decimalX(v.hours, 100), km_x10: decimalX(v.km, 10),
        orders: Number(v.orders || 0), gross_cents: v.gross || 0, tips_cents: v.tips || 0, costs_cents: v.costs || 0, account_id: v.account_id || null,
        currency: acc?.currency || 'EUR', notes: v.notes, register: v.register === true, status: v.status, confirm_reserve }));
      toast('Turno salvo.'); await refresh();
    },
  });
}

// ───────────── Metas e investimentos ─────────────
export async function metas(host, { refresh }) {
  host.innerHTML = `
    <div class="page-head"><div><h1>Metas financeiras</h1><p>Patrimônio e reserva são calculados pelos saldos e reservas; metas manuais usam o valor que você informa.</p></div>
      <div class="actions"><button class="primary" data-act="goal">+ Nova meta</button></div></div>
    <section class="card">${goalList(S.dash.goals)}<div class="actions">${S.dash.goals.map(g => `<button class="small ghost" data-goal="${esc(g.id)}">Editar “${esc(g.name)}”</button>`).join('')}</div></section>`;
  host.querySelector('[data-act="goal"]').onclick = () => goalForm(null, refresh);
  host.querySelectorAll('[data-goal]').forEach(b => b.onclick = () => goalForm(S.fin.goals.find(g => g.id === b.dataset.goal), refresh));
}

// ───────────── Investimentos: registro de operações e posições (nada é comprado automaticamente) ─────────────
const OP_LABEL = { compra: 'Compra', venda: 'Venda', aporte: 'Aporte', resgate: 'Resgate', rendimento: 'Rendimento', taxa: 'Taxa' };
export async function investimentos(host, { refresh }) {
  const pos = S.dash.positions;
  const total = c => pos.filter(p => p.currency === c).reduce((s, p) => s + p.value, 0);
  host.innerHTML = `
    <div class="page-head"><div><h1>Investimentos</h1><p>Registre compras, vendas, aportes, rendimentos e taxas. O app só acompanha: nenhuma ordem é enviada e nenhum dinheiro sai das contas automaticamente.</p></div>
      <div class="actions"><button class="primary" data-act="inv">+ Investimento</button></div></div>
    <div class="kpis"><div class="kpi"><span class="eyebrow">Posição EUR</span><span class="value">${money(total('EUR'), 'EUR')}</span></div><div class="kpi"><span class="eyebrow">Posição BRL</span><span class="value">${money(total('BRL'), 'BRL')}</span></div></div>
    ${pos.length ? pos.map(p => `<section class="card"><div class="card-head"><div><h2>${esc(p.name)}</h2><span class="muted small">${esc(p.kind)} · ${p.currency}${p.valued_at ? ' · avaliado em ' + fmtDate(p.valued_at) : ''}</span></div>
      <div class="actions"><button class="small" data-op="${esc(p.id)}">+ Operação</button><button class="small ghost" data-inv="${esc(p.id)}">Editar</button></div></div>
      <div class="kpis"><div class="kpi"><span class="eyebrow">Aplicado</span><span class="value">${money(p.invested, p.currency)}</span></div>
        <div class="kpi"><span class="eyebrow">Valor atual</span><span class="value">${money(p.value, p.currency)}</span><span class="sub">${p.current_cents === null ? 'Não informado: usando o aplicado' : 'Informado manualmente'}</span></div>
        <div class="kpi"><span class="eyebrow">Resultado</span><span class="value ${p.result < 0 ? 'neg' : 'pos'}">${money(p.result, p.currency, { sign: true })}</span><span class="sub">Rendimentos ${money(p.income, p.currency)} · taxas ${money(p.fees, p.currency)}</span></div>
        ${p.quantity_micro ? `<div class="kpi"><span class="eyebrow">Quantidade</span><span class="value">${(p.quantity_micro / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 6 })}</span></div>` : ''}</div>
      ${(S.fin.investmentOps || []).filter(o => o.investment_id === p.id).length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Operação</th><th class="r">Quantidade</th><th class="r">Valor</th><th></th></tr></thead><tbody>
        ${S.fin.investmentOps.filter(o => o.investment_id === p.id).map(o => `<tr><td>${fmtDate(o.date)}</td><td>${OP_LABEL[o.type]}</td><td class="r num">${o.quantity_micro ? (o.quantity_micro / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 6 }) : '—'}</td><td class="r money">${money(o.total_cents, p.currency)}</td><td><button class="small ghost" data-editop="${esc(o.id)}">Editar</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Nenhuma operação registrada.</p>'}
    </section>`).join('') : `<section class="card">${empty('Nenhum investimento registrado.')}</section>`}`;
  host.querySelector('[data-act="inv"]').onclick = () => investmentForm(null, refresh);
  host.querySelectorAll('[data-inv]').forEach(b => b.onclick = () => investmentForm(S.fin.investments.find(i => i.id === b.dataset.inv), refresh));
  host.querySelectorAll('[data-op]').forEach(b => b.onclick = () => opForm(S.fin.investments.find(i => i.id === b.dataset.op), null, refresh));
  host.querySelectorAll('[data-editop]').forEach(b => b.onclick = () => { const o = S.fin.investmentOps.find(x => x.id === b.dataset.editop); opForm(S.fin.investments.find(i => i.id === o.investment_id), o, refresh); });
}

function opForm(inv, o, refresh) {
  openForm({
    title: `${o ? 'Editar operação' : 'Nova operação'} · ${inv.name}`,
    intro: '<div class="banner small">Apenas registro. Para refletir o dinheiro saindo da conta, faça também uma transferência para uma conta de investimento.</div>',
    fields: [
      { name: 'type', label: 'Operação', type: 'select', options: Object.entries(OP_LABEL), value: o?.type || 'compra' },
      { name: 'date', label: 'Data', type: 'date', required: true, value: o?.date || today() },
      { name: 'total', label: `Valor total (${inv.currency})`, type: 'money', required: true, value: o?.total_cents },
      { name: 'quantity', label: 'Quantidade (cotas/ações, opcional)', type: 'decimal', value: o?.quantity_micro ? String(o.quantity_micro / 1e6).replace('.', ',') : '' },
      { name: 'notes', label: 'Notas', type: 'textarea', value: o?.notes },
    ],
    extra: o ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir operação', 'Excluir este registro?', { danger: true, confirmLabel: 'Excluir' })) { await del('fin/investment-ops/' + o.id); d.close(); await refresh(); } } }] : [],
    onSubmit: async v => { await post('fin/investment-ops', { id: o?.id, version: o?.version, investment_id: inv.id, type: v.type, date: v.date, total_cents: v.total, quantity_micro: decimalX(v.quantity, 1e6), notes: v.notes }); toast('Operação registrada.'); await refresh(); },
  });
}

// ───────────── Lista de desejos ─────────────
const PRIORITY = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
export async function desejos(host, { refresh }) {
  const list = S.fin.wishlist || [];
  const active = list.filter(w => w.status === 'desejo');
  const sum = c => active.filter(w => w.currency === c && w.price_cents).reduce((s, w) => s + w.price_cents, 0);
  const avail = S.dash.byCurrency.EUR.available;
  host.innerHTML = `
    <div class="page-head"><div><h1>Lista de desejos</h1><p>Coisas que você quer comprar, com prioridade. Nada é comprado nem reservado automaticamente.</p></div>
      <div class="actions"><button class="primary" data-act="new">+ Desejo</button></div></div>
    <div class="kpis"><div class="kpi"><span class="eyebrow">Total desejado (EUR)</span><span class="value">${money(sum('EUR'), 'EUR')}</span><span class="sub">Disponível agora: ${money(avail, 'EUR')}</span></div>
      ${sum('BRL') ? `<div class="kpi"><span class="eyebrow">Total desejado (BRL)</span><span class="value">${money(sum('BRL'), 'BRL')}</span></div>` : ''}</div>
    <section class="card"><div class="list" id="wish">${list.map((w, k) => `<div class="row"><div class="grow"><div class="title">${esc(w.name)} ${w.status !== 'desejo' ? `<span class="tag">${w.status === 'comprado' ? 'Comprado' : 'Descartado'}</span>` : `<span class="tag ${w.priority === 'alta' ? 'warn' : ''}">${PRIORITY[w.priority]}</span>`}</div>
      <div class="meta">${w.price_cents ? money(w.price_cents, w.currency) : 'Preço a definir'}${w.price_cents && w.status === 'desejo' && w.currency === 'EUR' ? (w.price_cents <= avail ? ' · cabe no disponível' : ' · ainda não cabe no disponível') : ''}${w.url ? ` · <a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">link</a>` : ''}</div></div>
      <button class="small ghost" data-up="${k}" aria-label="Subir ${esc(w.name)}"${k === 0 ? ' disabled' : ''}>${icon('up')}</button><button class="small ghost" data-down="${k}" aria-label="Descer ${esc(w.name)}"${k === list.length - 1 ? ' disabled' : ''}>${icon('down')}</button>
      <button class="small ghost" data-edit="${esc(w.id)}">Editar</button></div>`).join('') || empty('Lista vazia.')}</div></section>`;
  host.querySelector('[data-act="new"]').onclick = () => wishForm(null, refresh);
  host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => wishForm(list.find(w => w.id === b.dataset.edit), refresh));
  host.querySelectorAll('[data-up],[data-down]').forEach(b => b.onclick = () => reorderList('fin_wishlist', list, Number(b.dataset.up ?? b.dataset.down), b.dataset.up !== undefined ? -1 : 1, refresh));
}

function wishForm(w, refresh) {
  openForm({
    title: w ? 'Editar desejo' : 'Novo desejo',
    fields: [
      { name: 'name', label: 'O que você quer', required: true, value: w?.name, full: true },
      { name: 'price', label: 'Preço estimado', type: 'money', value: w?.price_cents },
      { name: 'currency', label: 'Moeda', type: 'select', options: ['EUR', 'BRL'], value: w?.currency || 'EUR' },
      { name: 'priority', label: 'Prioridade', type: 'select', options: Object.entries(PRIORITY), value: w?.priority || 'media' },
      { name: 'status', label: 'Situação', type: 'select', options: [['desejo', 'Desejo'], ['comprado', 'Comprado'], ['descartado', 'Descartado']], value: w?.status || 'desejo' },
      { name: 'url', label: 'Link (opcional)', value: w?.url, full: true },
      { name: 'notes', label: 'Notas', type: 'textarea', value: w?.notes },
    ],
    extra: w ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir desejo', `Excluir “${w.name}”?`, { danger: true, confirmLabel: 'Excluir' })) { await del('fin/wishlist/' + w.id); d.close(); await refresh(); } } }] : [],
    onSubmit: async v => { await post('fin/wishlist', { id: w?.id, version: w?.version, name: v.name, price_cents: v.price, currency: v.currency, priority: v.priority, status: v.status, url: v.url, notes: v.notes }); toast('Salvo.'); await refresh(); },
  });
}

// ───────────── Importar extrato CSV ─────────────
let csvState = null;
export async function extrato(host, { refresh }) {
  host.innerHTML = `
    <div class="page-head"><div><h1>Importar extrato (CSV)</h1><p>Baixe o extrato em CSV no app do banco (Revolut: Conta → Extrato → Excel/CSV; AstroPay ou outros: exportar movimentações) e envie aqui. Não há conexão direta com bancos.</p></div></div>
    <section class="card">
      <div class="actions"><label class="btn primary file-btn">${icon('upload')} Escolher arquivo CSV<input type="file" id="csv-file" class="visually-hidden" accept=".csv,text/csv,text/plain"></label></div>
      <p class="hint">O arquivo é lido no seu aparelho. Só as linhas que você marcar são enviadas ao banco de dados.</p>
      <div id="csv-work"></div></section>`;
  const work = host.querySelector('#csv-work');
  host.querySelector('#csv-file').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 3_000_000) { work.innerHTML = '<div class="banner error">Arquivo maior que 3 MB. Exporte um período menor.</div>'; return; }
    const parsed = parseCSV(await file.text());
    csvState = { parsed, cols: detectColumns(parsed.headers), name: file.name };
    renderCsv(work, refresh);
  });
  if (csvState) renderCsv(work, refresh);
}

function renderCsv(work, refresh) {
  const { parsed, cols } = csvState;
  const opts = (sel) => `<option value="-1">— nenhuma —</option>${parsed.headers.map((h, k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(h)}</option>`).join('')}`;
  const acc = accountById(csvState.account) || activeAccounts().find(a => !a.is_reserve) || activeAccounts()[0];
  if (!acc) { work.innerHTML = '<div class="banner warn">Cadastre a conta do extrato primeiro em Contas e reservas.</div>'; return; }
  csvState.account = acc.id;
  const { rows, errors } = toTransactions(parsed, cols, acc.currency);
  const anchor = S.dash.accounts.find(a => a.id === acc.id)?.anchor;
  const marked = rows.map(r => {
    const dups = findDuplicates({ amount_cents: r.amount_cents, date: r.date, currency: acc.currency, merchant: r.description }, S.fin.transactions.filter(t => t.account_id === acc.id), 1);
    const before = anchor && r.date <= anchor.date;
    return { ...r, dup: dups[0], before, include: !dups.length && !before };
  });
  csvState.rows = marked;
  work.innerHTML = `
    <div class="banner small">Formato detectado: <b>${esc(cols.preset)}</b> · ${parsed.rows.length} linha(s) em “${esc(csvState.name)}”. Confira as colunas.</div>
    <form id="csv-map" class="filters">
      <label>Conta do extrato<select name="account">${accountOptions().map(([v, l]) => `<option value="${esc(v)}"${v === acc.id ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${['date:Data', 'description:Descrição', 'amount:Valor (com sinal)', 'debit:Débito', 'credit:Crédito', 'fee:Taxa', 'state:Situação'].map(x => { const [k, l] = x.split(':'); return `<label>${l}<select name="${k}">${opts(cols[k])}</select></label>`; }).join('')}
      <label>Importar como<select name="status"><option value="pendente">Pendente (revisar depois)</option><option value="confirmada">Confirmada (entra no saldo)</option></select></label>
    </form>
    ${anchor ? `<div class="banner small">Linhas até ${fmtDate(anchor.date)} (data do saldo de referência de ${esc(acc.name)}) vêm desmarcadas: já estão contidas no saldo e importá-las não mudaria o saldo, só o histórico.</div>` : ''}
    ${errors.length ? `<details><summary>${errors.length} linha(s) ignorada(s)</summary><p class="small">${errors.slice(0, 50).map(e => `Linha ${e.line}: ${esc(e.reason)}`).join('<br>')}</p></details>` : ''}
    <div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="csv-all" aria-label="Marcar todas"></th><th>Data</th><th>Descrição</th><th class="r">Valor</th><th>Observação</th></tr></thead><tbody>
      ${marked.map((r, k) => `<tr><td><input type="checkbox" data-row="${k}"${r.include ? ' checked' : ''} aria-label="Importar linha ${r.line}"></td><td>${fmtDate(r.date)}</td><td>${esc(r.description)}</td>
        <td class="r money ${r.amount_cents < 0 ? 'neg' : 'pos'}">${money(r.amount_cents, acc.currency, { sign: true })}</td>
        <td class="small">${r.dup ? `<span class="tag warn">Possível duplicado</span> ${esc(r.dup.description)}` : ''}${r.before ? '<span class="tag">Antes do saldo de referência</span>' : ''}${r.pending ? '<span class="tag warn">Pendente no banco</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="actions"><button class="primary" id="csv-import">Importar linhas marcadas</button><button id="csv-cancel">Cancelar</button></div>`;
  const map = work.querySelector('#csv-map');
  map.addEventListener('change', () => {
    const f = Object.fromEntries(new FormData(map));
    csvState.account = f.account; csvState.status = f.status;
    for (const k of ['date', 'description', 'amount', 'debit', 'credit', 'fee', 'state']) cols[k] = Number(f[k]);
    renderCsv(work, refresh);
  });
  if (csvState.status) map.status.value = csvState.status;
  work.querySelector('#csv-all').addEventListener('change', e => work.querySelectorAll('[data-row]').forEach(c => { c.checked = e.target.checked; }));
  work.querySelector('#csv-cancel').onclick = () => { csvState = null; work.innerHTML = ''; };
  work.querySelector('#csv-import').onclick = async e => {
    const chosen = [...work.querySelectorAll('[data-row]:checked')].map(c => csvState.rows[Number(c.dataset.row)]);
    if (!chosen.length) return toast('Marque ao menos uma linha.', 'error');
    if (!await confirmDialog('Importar extrato', `Importar ${chosen.length} linha(s) em ${acc.name} como ${map.status.value === 'confirmada' ? 'confirmadas (alteram o saldo)' : 'pendentes (não alteram o saldo até você confirmar)'}?`)) return;
    e.target.disabled = true;
    try {
      const r = await post('fin/import/csv', { account_id: acc.id, status: map.status.value, rows: chosen.map(x => ({ line: x.line, date: x.date, description: x.description, amount_cents: x.amount_cents, pending: x.pending })) });
      csvState = null; toast(`${r.imported} importada(s); ${r.skipped} já existiam.`); await refresh();
    } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
  };
}

function goalForm(g, refresh) {
  openForm({
    title: g ? 'Editar meta' : 'Nova meta',
    fields: [
      { name: 'name', label: 'Nome', required: true, value: g?.name, full: true, hint: 'Ex.: Patrimônio de R$ 100 mil' },
      { name: 'kind', label: 'Como medir o progresso', type: 'select', options: [['patrimonio', 'Patrimônio total (contas + investimentos)'], ['reserva', 'Soma das contas de reserva'], ['conta', 'Saldo de uma conta'], ['manual', 'Valor informado manualmente']], value: g?.kind || 'patrimonio', full: true },
      { name: 'target', label: 'Valor da meta', type: 'money', required: true, value: g?.target_cents },
      { name: 'currency', label: 'Moeda', type: 'select', options: ['BRL', 'EUR'], value: g?.currency || 'EUR' },
      { name: 'due_date', label: 'Prazo', type: 'date', value: g?.due_date || '' },
      { name: 'account_id', label: 'Conta (se “saldo de uma conta”)', type: 'select', options: [['', '—'], ...accountOptions()], value: g?.account_id || '' },
      { name: 'saved', label: 'Valor guardado (se manual)', type: 'money', value: g?.saved_cents },
      { name: 'notes', label: 'Notas', type: 'textarea', value: g?.notes },
    ],
    extra: g ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir meta', `Excluir “${g.name}”?`, { danger: true, confirmLabel: 'Excluir' })) { await del('fin/goals/' + g.id); d.close(); await refresh(); } } }] : [],
    onSubmit: async v => { await post('fin/goals', { id: g?.id, version: g?.version, name: v.name, kind: v.kind, target_cents: v.target, currency: v.currency, due_date: v.due_date || null, account_id: v.account_id || null, saved_cents: v.saved || 0, notes: v.notes }); toast('Meta salva.'); await refresh(); },
  });
}

function investmentForm(i, refresh) {
  openForm({
    title: i ? 'Editar investimento' : 'Novo investimento',
    fields: [
      { name: 'name', label: 'Nome', required: true, value: i?.name },
      { name: 'kind', label: 'Classe', value: i?.kind || 'Renda fixa', list: ['Renda fixa', 'Ações', 'ETFs', 'Fundos', 'Cripto', 'Tesouro', 'Outro'] },
      { name: 'currency', label: 'Moeda', type: 'select', options: ['EUR', 'BRL'], value: i?.currency || 'EUR' },
      { name: 'invested', label: 'Valor aplicado', type: 'money', required: true, value: i?.invested_cents },
      { name: 'current', label: 'Valor atual (se souber)', type: 'money', value: i?.current_cents },
      { name: 'valued_at', label: 'Data da avaliação', type: 'date', value: i?.valued_at || today() },
      { name: 'notes', label: 'Notas', type: 'textarea', value: i?.notes },
    ],
    extra: i ? [{ label: 'Excluir', danger: true, onClick: async d => { if (await confirmDialog('Excluir investimento', `Excluir “${i.name}”?`, { danger: true, confirmLabel: 'Excluir' })) { await del('fin/investments/' + i.id); d.close(); await refresh(); } } }] : [],
    onSubmit: async v => { await post('fin/investments', { id: i?.id, version: i?.version, name: v.name, kind: v.kind, currency: v.currency, invested_cents: v.invested, current_cents: v.current, valued_at: v.valued_at, notes: v.notes }); toast('Investimento salvo.'); await refresh(); },
  });
}

// ───────────── Relatórios ─────────────
const rep = { month: '', currency: 'EUR' };
export async function relatorios(host, { refresh }) {
  rep.month ||= today().slice(0, 7);
  const tx = S.fin.transactions;
  const r = monthlyReport(tx, rep.month, rep.currency);
  const months = lastMonths(rep.month + '-15', 6);
  const series = months.map(m => monthlyReport(tx, m, rep.currency));
  const allMonths = [...new Set([today().slice(0, 7), ...tx.map(t => t.date.slice(0, 7))])].sort().reverse();
  const [from, to] = periodRange('mensal', rep.month + '-01');
  host.innerHTML = `
    <div class="page-head"><div><h1>Relatórios</h1><p>Somente lançamentos confirmados de receita e despesa. Transferências e ajustes não entram.</p></div>
      <div class="actions"><a class="btn" href="/api/fin/export.csv" download>Exportar CSV</a><button data-act="print">Imprimir / PDF</button></div></div>
    <form class="card filters" id="rep">
      <label>Mês<select name="month">${allMonths.map(m => `<option value="${m}"${m === rep.month ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}</select></label>
      <label>Moeda<select name="currency"><option${rep.currency === 'EUR' ? ' selected' : ''}>EUR</option><option${rep.currency === 'BRL' ? ' selected' : ''}>BRL</option></select></label></form>
    <div class="kpis"><div class="kpi"><span class="eyebrow">Receitas</span><span class="value pos">${money(r.income, rep.currency)}</span></div>
      <div class="kpi"><span class="eyebrow">Despesas</span><span class="value neg">${money(r.expense, rep.currency)}</span></div>
      <div class="kpi"><span class="eyebrow">Resultado</span><span class="value">${money(r.result, rep.currency, { sign: true })}</span><span class="sub">${fmtDate(from)} a ${fmtDate(to)}</span></div>
      <div class="kpi"><span class="eyebrow">Taxa de poupança</span><span class="value">${r.income ? Math.round(r.result * 100 / r.income) + '%' : '—'}</span></div></div>
    <div class="grid-2">
      <section class="card"><h2>Últimos 6 meses</h2>${groupedBars(months.map(m => monthLabel(m).slice(0, 3)), [{ name: 'Receitas', cls: 'c1', values: series.map(x => x.income) }, { name: 'Despesas', cls: 'c2', values: series.map(x => x.expense) }], rep.currency)}</section>
      <section class="card"><h2>Despesas por categoria</h2>${categoryBars(r.categories, rep.currency)}</section></div>
    <section class="card"><h2>Por dia</h2>${r.days.length ? `<div class="table-wrap"><table><thead><tr><th>Dia</th><th class="r">Receitas</th><th class="r">Despesas</th><th class="r">Resultado</th></tr></thead><tbody>
      ${r.days.map(d => `<tr><td>${fmtDate(d.date)}</td><td class="r money pos">${money(d.income, rep.currency)}</td><td class="r money neg">${money(d.expense, rep.currency)}</td><td class="r money">${money(d.income - d.expense, rep.currency, { sign: true })}</td></tr>`).join('')}</tbody></table></div>` : empty('Sem lançamentos confirmados neste mês.')}</section>`;
  const form = host.querySelector('#rep');
  form.addEventListener('change', () => { Object.assign(rep, Object.fromEntries(new FormData(form))); relatorios(host, { refresh }); });
  host.querySelector('[data-act="print"]').onclick = () => window.print();
}

export { formatMoney, centsToInput, api };

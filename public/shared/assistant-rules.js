// Assistente WALL por regras: responde perguntas comuns usando só os dados do próprio sistema.
// Gratuito, sem IA externa. Cada resposta diz de onde vem o número.
import { dashboard, periodRange, monthlyReport, deliveryStats, addMonths, addDays } from './finance.js';
import { formatMoney } from './money.js';

export const SUGGESTIONS = [
  'Quanto tenho disponível hoje?', 'Quanto ainda falta para completar minha reserva?', 'Quais contas vencem nesta semana?',
  'Quanto ganhei trabalhando com delivery?', 'Quanto economizei neste mês?', 'Quais tarefas ainda tenho hoje?', 'Qual é o progresso das minhas metas?',
];

const plain = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fmtDate = s => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const curList = (d, fn) => ['EUR', 'BRL'].map(c => fn(c, d.byCurrency[c])).filter(Boolean);

const INTENTS = [
  ['reserva', /reserva/],
  ['vencimentos', /venc|contas? (a pagar|da semana|nesta semana)|pagar (essa|nesta|esta) semana|compromissos? financeiros?/],
  ['delivery', /delivery|entrega|uber|bolt|deliveroo|glovo|turno/],
  ['economia', /econom|poup|sobrou|resultado do mes|guardei/],
  ['tarefas', /tarefa|checklist|fazer hoje|afazer|pendencias? de hoje/],
  ['metas', /meta|objetivo|progresso/],
  ['gastos', /gastei|gastos?|despesas?/],
  ['disponivel', /dispon|quanto tenho|posso gastar|saldo|livre/],
];

export function detectIntent(question) {
  const q = plain(question);
  return INTENTS.find(([, re]) => re.test(q))?.[0] || null;
}

export function answer(question, { fin, os = [], date }) {
  const intent = detectIntent(question);
  if (!intent) return null;
  const d = dashboard(fin, date);
  const lines = [];
  if (intent === 'disponivel') {
    for (const c of ['EUR', 'BRL']) {
      const b = d.byCurrency[c];
      if (!b.total && !b.reserve && c === 'BRL') continue;
      lines.push(`${c}: ${formatMoney(b.available, c)} livres (saldo ${formatMoney(b.total, c)} − reservas ${formatMoney(b.reserve, c)}${b.excluded ? ` − fora do orçamento ${formatMoney(b.excluded, c)}` : ''}).`);
      if (b.planned30) lines.push(`Há ${formatMoney(b.planned30, c)} em despesas planejadas para os próximos 30 dias.`);
    }
    for (const bu of d.budgets.filter(x => x.period === 'diario')) {
      lines.push(`Orçamento diário “${bu.name}”: gasto ${formatMoney(bu.spent, bu.currency)} de ${formatMoney(bu.limit_cents, bu.currency)}; pode usar ${formatMoney(bu.usable, bu.currency)} hoje${bu.limitedByAvailability ? ' (limitado ao dinheiro livre de reservas)' : ''}.`);
    }
    if (d.byCurrency.EUR.available <= 0) lines.push('Todo o saldo em EUR está comprometido com reservas: qualquer gasto avança sobre a reserva.');
  }
  if (intent === 'reserva') {
    if (!d.reserves.length && !d.accounts.some(a => a.is_reserve)) lines.push('Nenhuma reserva cadastrada. Crie uma em Contas e reservas.');
    for (const r of d.reserves) lines.push(r.deficit ? `“${r.name}”: reservado ${formatMoney(r.allocated_cents, r.currency)} de ${formatMoney(r.target_cents, r.currency)}. Faltam ${formatMoney(r.deficit, r.currency)}.` : `“${r.name}” está completa (${formatMoney(r.allocated_cents, r.currency)}).`);
    for (const a of d.accounts.filter(x => x.is_reserve && x.reserve_target_cents)) lines.push(`Conta-reserva “${a.name}”: ${formatMoney(a.balance, a.currency)} de ${formatMoney(a.reserve_target_cents, a.currency)}; faltam ${formatMoney(Math.max(0, a.reserve_target_cents - a.balance), a.currency)}.`);
  }
  if (intent === 'vencimentos') {
    const [ws, we] = periodRange('semanal', date);
    const cur = id => fin.accounts.find(a => a.id === id)?.currency || 'EUR';
    const rec = fin.recurring.filter(r => r.active && r.next_date <= we).sort((a, b) => a.next_date.localeCompare(b.next_date));
    const plan = (fin.planned || []).filter(p => p.status === 'planejada' && p.due_date && p.due_date <= we);
    for (const r of rec) lines.push(`${fmtDate(r.next_date)}${r.next_date < ws ? ' (atrasada)' : ''} · ${r.description}: ${formatMoney(r.amount_cents, cur(r.account_id))} (${r.kind === 'despesa' ? 'recorrente' : 'receita recorrente'}).`);
    for (const p of plan) lines.push(`${fmtDate(p.due_date)} · ${p.description}: ${formatMoney(p.amount_cents, p.currency)} (planejada).`);
    if (!lines.length) lines.push(`Nada vence entre ${fmtDate(ws)} e ${fmtDate(we)}.`);
  }
  if (intent === 'delivery') {
    const month = date.slice(0, 7);
    for (const [label, list] of [['Neste mês', fin.shifts.filter(s => s.date.startsWith(month))], ['Últimos 30 dias', fin.shifts.filter(s => s.date >= addDays(date, -30))], ['Total registrado', fin.shifts]]) {
      for (const s of deliveryStats(list)) lines.push(`${label} (${s.currency}): bruto ${formatMoney(s.gross + s.tips, s.currency)}, custos ${formatMoney(s.costs, s.currency)}, líquido ${formatMoney(s.net, s.currency)} em ${s.shifts} turno(s)${s.per_hour !== null ? `, ${formatMoney(s.per_hour, s.currency)}/hora` : ''}.`);
    }
    if (!lines.length) lines.push('Nenhum turno de delivery registrado ainda.');
  }
  if (intent === 'economia') {
    for (const c of ['EUR', 'BRL']) {
      const r = monthlyReport(fin.transactions, date.slice(0, 7), c);
      if (!r.income && !r.expense) continue;
      lines.push(`${c}: receitas ${formatMoney(r.income, c)}, despesas ${formatMoney(r.expense, c)} → ${r.result >= 0 ? 'economizou' : 'gastou além do que entrou'} ${formatMoney(Math.abs(r.result), c)}${r.income ? ` (${Math.round(r.result * 100 / r.income)}% das receitas)` : ''}.`);
    }
    if (!lines.length) lines.push('Sem receitas ou despesas confirmadas neste mês. Transferências e reservas não contam como gasto.');
  }
  if (intent === 'gastos') {
    for (const c of ['EUR', 'BRL']) {
      const r = monthlyReport(fin.transactions, date.slice(0, 7), c);
      if (!r.expense) continue;
      const todaySpent = fin.transactions.filter(t => !t.deleted_at && t.status === 'confirmada' && t.kind === 'despesa' && t.currency === c && t.date === date).reduce((s, t) => s - t.amount_cents, 0);
      lines.push(`${c}: hoje ${formatMoney(todaySpent, c)}; no mês ${formatMoney(r.expense, c)}. Maiores categorias: ${r.categories.slice(0, 3).map(x => `${x.name} ${formatMoney(x.amount, c)}`).join(', ')}.`);
    }
    if (!lines.length) lines.push('Nenhuma despesa confirmada neste mês.');
  }
  if (intent === 'tarefas') {
    const open = os.filter(i => i.module === 'checklist' && !i.done && !i.archived && (!i.date || i.date <= date));
    const events = os.filter(i => i.module === 'evento' && i.date === date && !i.archived);
    lines.push(open.length ? `${open.length} tarefa(s) em aberto: ${open.map(i => i.title + (i.date && i.date < date ? ' (atrasada)' : '')).join('; ')}.` : 'Nenhuma tarefa em aberto para hoje.');
    if (events.length) lines.push(`Compromissos hoje: ${events.map(e => (e.time ? e.time + ' ' : '') + e.title).join('; ')}.`);
  }
  if (intent === 'metas') {
    for (const g of d.goals) lines.push(g.current === null ? `“${g.name}”: ${g.note}.` : `“${g.name}”: ${formatMoney(g.current, g.currency)} de ${formatMoney(g.target_cents, g.currency)} (${String(g.pct).replace('.', ',')}%)${g.due_date ? `, prazo ${fmtDate(g.due_date)}/${g.due_date.slice(0, 4)}` : ''}.`);
    const goals = os.filter(i => i.module === 'objetivo' && !i.archived && i.status !== 'cancelado');
    if (goals.length) lines.push(`Objetivos pessoais: ${goals.filter(i => i.status === 'concluido').length} de ${goals.length} concluídos.`);
    if (!lines.length) lines.push('Nenhuma meta cadastrada.');
  }
  return { intent, texto: lines.join('\n'), fonte: 'Regras sobre os seus registros (sem IA externa)' };
}

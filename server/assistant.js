// Assistente financeiro.
// 1) Sempre disponível, custo zero: análise por regras sobre os dados reais do titular.
// 2) IA externa OPCIONAL: só funciona se o titular colocar ANTHROPIC_API_KEY como segredo no
//    servidor E ligar a opção nas configurações. A chave nunca vai para o navegador nem para o GitHub.
import { json, readJson, fail } from './http.js';
import { loadFinance } from './fin.js';
import { dashboard, monthlyReport, deliveryStats, today, addMonths } from '../public/shared/finance.js';
import { formatMoney } from '../public/shared/money.js';
import { answer, SUGGESTIONS } from '../public/shared/assistant-rules.js';

export function insights(data, date = today()) {
  const d = dashboard(data, date);
  const out = [];
  const month = date.slice(0, 7);
  for (const c of ['EUR', 'BRL']) {
    const r = monthlyReport(data.transactions, month, c);
    if (r.income || r.expense) {
      out.push({ tipo: r.result < 0 ? 'alerta' : 'info', texto: `${c}: no mês, receitas ${formatMoney(r.income, c)} e despesas ${formatMoney(r.expense, c)} (resultado ${formatMoney(r.result, c)}).` });
      if (r.categories[0]) out.push({ tipo: 'info', texto: `Maior categoria de despesa em ${c}: ${r.categories[0].name} (${formatMoney(r.categories[0].amount, c)}).` });
    }
  }
  for (const b of d.budgets) if (b.over) out.push({ tipo: 'alerta', texto: `Orçamento “${b.name}” (${b.period}) ultrapassado: ${formatMoney(b.spent, b.currency)} de ${formatMoney(b.limit_cents, b.currency)}.` });
    else if (b.spent > b.limit_cents * 0.8) out.push({ tipo: 'atencao', texto: `Orçamento “${b.name}” acima de 80%: restam ${formatMoney(b.remaining, b.currency)}.` });
  for (const r of d.reserves) out.push(r.deficit ? { tipo: 'atencao', texto: `Reserva “${r.name}”: faltam ${formatMoney(r.deficit, r.currency)} para ${formatMoney(r.target_cents, r.currency)}.` } : { tipo: 'info', texto: `Reserva “${r.name}” completa.` });
  for (const r of d.reserves.filter(x => x.overAllocated)) out.push({ tipo: 'alerta', texto: `Reserva “${r.name}” é maior que o saldo calculado de ${r.account_name}. Concilie a conta.` });
  for (const b of d.budgets.filter(x => x.limitedByAvailability)) out.push({ tipo: 'atencao', texto: `Orçamento “${b.name}”: só ${formatMoney(b.usable, b.currency)} estão livres de reservas.` });
  if (d.pendingCount) out.push({ tipo: 'atencao', texto: `${d.pendingCount} lançamento(s) pendente(s) aguardam sua confirmação.` });
  const unconfirmed = data.snapshots.filter(s => s.status === 'a_confirmar');
  if (unconfirmed.length) out.push({ tipo: 'atencao', texto: `${unconfirmed.length} fotografia(s) de saldo ainda “a confirmar”. Confira no app do banco e concilie.` });
  for (const a of d.accounts.filter(a => a.is_reserve && a.reserve_target_cents)) {
    const gap = a.reserve_target_cents - a.balance;
    out.push(gap > 0 ? { tipo: 'atencao', texto: `Reserva “${a.name}”: faltam ${formatMoney(gap, a.currency)} para a meta de ${formatMoney(a.reserve_target_cents, a.currency)}.` }
      : { tipo: 'info', texto: `Reserva “${a.name}” atingiu a meta.` });
  }
  for (const g of d.goals) {
    if (g.current === null) { out.push({ tipo: 'atencao', texto: `Meta “${g.name}”: ${g.note}.` }); continue; }
    if (g.due_date && g.missing > 0) {
      const months = Math.max(1, monthsBetween(date, g.due_date));
      out.push({ tipo: 'info', texto: `Meta “${g.name}”: ${g.pct}% concluída; para chegar no prazo seriam ${formatMoney(Math.ceil(g.missing / months), g.currency)} por mês durante ${months} mês(es).` });
    }
  }
  const due = data.recurring.filter(r => r.active && r.next_date <= addDaysStr(date, 7));
  if (due.length) out.push({ tipo: 'atencao', texto: `Recorrências nos próximos 7 dias: ${due.map(r => `${r.description} (${r.next_date})`).join(', ')}. Lance apenas quando ocorrerem.` });
  for (const s of deliveryStats(data.shifts.filter(s => s.date >= addMonths(date, -1)))) {
    if (s.per_hour !== null) out.push({ tipo: 'info', texto: `Delivery (30 dias, ${s.currency}): líquido ${formatMoney(s.net, s.currency)}, ${formatMoney(s.per_hour, s.currency)}/hora em ${s.shifts} turno(s).` });
  }
  if (!d.rate) out.push({ tipo: 'atencao', texto: 'Sem taxa EUR→BRL informada: o patrimônio total em uma única moeda não pode ser calculado.' });
  if (!out.length) out.push({ tipo: 'info', texto: 'Sem dados suficientes ainda. Registre contas, saldos e lançamentos para receber análises.' });
  return { gerado_em: new Date().toISOString(), fonte: 'Regras locais sobre seus registros (sem IA externa, sem custo)', itens: out, dashboard: d };
}

function monthsBetween(a, b) { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); }
function addDaysStr(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

export async function assistantRoutes(request, env, parts) {
  const data = await loadFinance(env.DB);
  const aiConfigured = Boolean(env.ANTHROPIC_API_KEY);
  const aiEnabled = aiConfigured && data.settings.ai_enabled === '1';
  if (parts[0] === 'status') return json({ aiConfigured, aiEnabled, model: aiEnabled ? (env.AI_MODEL || 'claude-haiku-5-5') : null, suggestions: SUGGESTIONS });
  if (parts[0] === 'insights' && request.method === 'GET') return json(insights(data));
  if (parts[0] === 'ask' && request.method === 'POST') {
    const { question } = await readJson(request, 8000);
    const q = String(question || '').trim().slice(0, 2000);
    if (!q) fail(400, 'Escreva sua pergunta.');
    const report = insights(data);
    // 1º: regras gratuitas sobre os dados do sistema.
    const os = (await env.DB.prepare('SELECT * FROM os_items WHERE deleted_at IS NULL').all()).results;
    const ruled = answer(q, { fin: data, os, date: today() });
    if (ruled) return json({ resposta: ruled.texto, modo: 'regras', intent: ruled.intent, fonte: ruled.fonte });
    if (!aiEnabled) return json({ resposta: null, modo: 'regras', sugestoes: SUGGESTIONS, aviso: 'Não entendi essa pergunta pelas regras. Tente uma destas, ou veja a análise geral abaixo.', analise: report.itens });
    // Envia apenas agregados (sem anexos, sem notas livres) para reduzir exposição de dados.
    const context = { data: report.dashboard.date, porMoeda: report.dashboard.byCurrency, patrimonio: report.dashboard.netWorth, metas: report.dashboard.goals.map(g => ({ nome: g.name, alvo: g.target_cents, atual: g.current, moeda: g.currency, prazo: g.due_date })), orcamentos: report.dashboard.budgets.map(b => ({ nome: b.name, periodo: b.period, gasto: b.spent, limite: b.limit_cents, moeda: b.currency })), alertas: report.itens.map(i => i.texto) };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.AI_MODEL || 'claude-haiku-5-5', max_tokens: 900,
        system: 'Você é o assistente do WALL Finance. Responda em português do Brasil, de forma objetiva. Use somente os dados fornecidos (valores em centavos). Nunca invente saldos, nunca execute nem prometa movimentações; apenas sugira ações que o titular decide. Diga quando faltar informação.',
        messages: [{ role: 'user', content: `Dados autorizados (JSON):\n${JSON.stringify(context)}\n\nPergunta: ${q}` }] }),
    });
    if (!res.ok) return json({ resposta: null, modo: 'regras', aviso: `IA externa indisponível (HTTP ${res.status}). Mostrando análise por regras.`, analise: report.itens });
    const out = await res.json();
    return json({ resposta: (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), modo: 'ia', analise: report.itens });
  }
  fail(404, 'Operação não encontrada.');
}

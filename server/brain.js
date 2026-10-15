// WALL Brain (Wall Bot): memória, tarefas e comando pelo Telegram (/api/brain/* e /api/telegram/webhook).
// Regras: só o proprietário comanda; cada atualização do Telegram é processada uma vez; ação com efeito
// nasce como proposta e só vale com /confirmar <código do conteúdo exato>; sem executor conectado a
// tarefa de agente fica bloqueada (nunca há sucesso fictício). Lançamento contábil não movimenta dinheiro.
import { fail, json, readJson } from './http.js';
import { v, newId, nowIso, getRow, create, update, remove, auditStmt, bump, isRevisionConflict } from './store.js';
import { loadFinance } from './fin.js';
import { sha256 } from './auth.js';
import { dashboard, today, findDuplicates, suggestAccount } from '../public/shared/finance.js';
import { parseAmount, formatMoney } from '../public/shared/money.js';

export const TASK_STATUSES = ['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled'];
export const AGENTS = ['wallacy', 'claude_code', 'codex', 'criativos'];
export const AGENT_LABEL = { wallacy: 'Wallacy', claude_code: 'Claude Code', codex: 'Codex', criativos: 'Criativos' };
export const MEMORY_KINDS = ['fato', 'decisao', 'hipotese', 'pendencia', 'evidencia'];
const PROPOSAL_MINUTES = 30;

// Agentes com executor cloud comprovado (variável BRAIN_EXECUTORS, ex.: "codex"). Hoje: nenhum.
export const executors = env => String(env.BRAIN_EXECUTORS || '').split(',').map(s => s.trim()).filter(s => AGENTS.includes(s) && s !== 'wallacy');
export const telegramConfigured = env => Boolean(env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_OWNER_ID);

const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const randomCode = (n = 5) => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => a[x % a.length]).join(''); };

// ───── regras puras (testadas em tests/unit/brain.test.mjs) ─────
export function parseCommand(text) {
  const m = String(text || '').trim().match(/^\/([a-zA-Zçã]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return m ? { cmd: norm(m[1]), arg: (m[2] || '').trim() } : null;
}

// "/tarefa Revisar PDF #ofertas @codex" → título, projeto e agente.
export function parseTask(arg) {
  let project = 'geral', agent = 'wallacy';
  const title = String(arg || '').replace(/(^|\s)#([\p{L}\d_-]{1,40})/gu, (_, s, p) => { project = norm(p); return s; })
    .replace(/(^|\s)@([\p{L}_]{2,20})/gu, (_, s, a) => { const k = norm(a).replace(/\s/g, ''); agent = k === 'claude' || k === 'claudecode' || k === 'claude_code' ? 'claude_code' : AGENTS.includes(k) ? k : agent; return s; })
    .replace(/\s+/g, ' ').trim();
  return { title, project, agent };
}

// "/despesa 12,50 Mercado Lidl @revolut" → valor em centavos, descrição e conta pedida.
export function parseMoneyCommand(arg) {
  const parts = String(arg || '').trim().split(/\s+/);
  const amount = parseAmount(parts[0] || '');
  let account = null;
  const rest = parts.slice(1).filter(p => { if (/^@\S+/.test(p)) { account = norm(p.slice(1)); return false; } return true; });
  return { amount_cents: amount && amount > 0 ? amount : null, description: rest.join(' ').trim(), account };
}

// O código de confirmação depende do conteúdo exato: outro valor, conta ou descrição gera outro código.
export const confirmCode = async (id, payloadHash) => (await sha256(`${id}:${payloadHash}`)).slice(0, 6).toUpperCase();

// Regras de mudança de estado de uma tarefa.
export function applyTaskRules(task, env) {
  const t = { ...task, blocked_reason: task.status === 'blocked' ? task.blocked_reason || 'Bloqueada manualmente.' : null };
  if (t.status === 'done' && !String(t.evidence || '').trim()) fail(400, 'Para concluir, registre a evidência (link, commit, arquivo ou resultado verificável).');
  if (['ready', 'running'].includes(t.status) && t.agent !== 'wallacy' && !executors(env).includes(t.agent)) {
    t.status = 'blocked';
    t.blocked_reason = `Sem executor cloud conectado para ${AGENT_LABEL[t.agent]}. A tarefa espera até existir integração testada.`;
  }
  return t;
}

// ───── painel (sessão do proprietário) ─────
export async function brainRoutes(request, env, parts) {
  const db = env.DB, [resource, id, action] = parts, method = request.method;

  if (resource === 'state' && method === 'GET') {
    const [tasks, memory, proposals, events] = await Promise.all([
      all(db, "SELECT * FROM brain_tasks ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'running' THEN 1 WHEN 'ready' THEN 2 WHEN 'review' THEN 3 WHEN 'backlog' THEN 4 ELSE 5 END, updated_at DESC"),
      all(db, 'SELECT * FROM brain_memory WHERE archived = 0 ORDER BY updated_at DESC'),
      all(db, 'SELECT id, code, kind, payload_json, status, expires_at, decided_at, result_ref, created_at FROM brain_proposals ORDER BY created_at DESC LIMIT 30'),
      all(db, 'SELECT id, received_at, command, outcome FROM brain_events ORDER BY received_at DESC LIMIT 20'),
    ]);
    return json({ tasks, memory, proposals, events, telegram: { configured: telegramConfigured(env) }, executors: executors(env), agents: AGENTS, statuses: TASK_STATUSES });
  }

  if (resource === 'tasks' && method === 'POST') {
    const i = await readJson(request);
    const f = applyTaskRules({
      title: v.text(i.title, 'Título', { max: 200 }),
      project: norm(v.text(i.project || 'geral', 'Projeto', { max: 40 })),
      agent: v.oneOf(i.agent || 'wallacy', 'Responsável', AGENTS),
      status: v.oneOf(i.status || 'backlog', 'Estado', TASK_STATUSES),
      scope: v.text(i.scope, 'Escopo autorizado', { required: false, max: 2000 }),
      acceptance: v.text(i.acceptance, 'Critério de aceite', { required: false, max: 2000 }),
      evidence: v.text(i.evidence, 'Evidência', { required: false, max: 2000 }),
      blocked_reason: v.text(i.blocked_reason, 'Motivo do bloqueio', { required: false, max: 500 }),
    }, env);
    if (i.id) return json(await update(db, 'brain_tasks', v.id(i.id), i.version, f, 'tarefa'));
    return json(await create(db, 'brain_tasks', { ...f, code: 'T-' + randomCode(), source: 'painel' }, 'tarefa'), 201);
  }

  if (resource === 'memory' && method === 'POST') {
    const i = await readJson(request);
    const f = {
      kind: v.oneOf(i.kind, 'Tipo', MEMORY_KINDS), text: v.text(i.text, 'Texto', { max: 2000 }),
      source: v.text(i.source || 'Painel', 'Origem', { max: 200 }), valid_until: v.date(i.valid_until, 'Válido até', { required: false }),
      archived: v.bool(i.archived),
    };
    return i.id ? json(await update(db, 'brain_memory', v.id(i.id), i.version, f, 'memória')) : json(await create(db, 'brain_memory', f, 'memória'), 201);
  }
  if (resource === 'memory' && method === 'DELETE') return json(await remove(db, 'brain_memory', v.id(id), 'memória'));

  if (resource === 'proposals' && action === 'cancel' && method === 'POST') {
    const p = await getRow(db, 'brain_proposals', v.id(id));
    if (!p) fail(404, 'Proposta não encontrada.');
    if (p.status !== 'aguardando') fail(409, `Esta proposta já está ${p.status}.`);
    return json(await update(db, 'brain_proposals', p.id, p.version, { status: 'cancelada', decided_at: nowIso() }, 'proposta'));
  }
  fail(404, 'Operação não encontrada.');
}

// ───── Telegram ─────
async function sameSecret(a, b) { return (await sha256(String(a || ''))) === (await sha256(String(b || ''))); }
const reply = (chatId, text) => json({ method: 'sendMessage', chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true });
const eventStmt = (db, eventId, fromId, command, outcome) =>
  db.prepare('INSERT INTO brain_events (id, received_at, from_id, command, outcome) VALUES (?, ?, ?, ?, ?)').bind(eventId, nowIso(), fromId, command, outcome);
const isDuplicateEvent = e => /UNIQUE constraint failed: brain_events/.test(String(e?.message) + String(e?.cause?.message));

const HELP = `WALL Brain — comandos
/status — tarefas, bloqueios e próxima ação
/projetos — projetos e tarefas por projeto
/tarefa texto #projeto @agente — cria tarefa (agentes: claude, codex, criativos)
/nota texto — guarda uma pendência na memória
/financeiro — saldos calculados no WALL Finance
/despesa 12,50 descrição @conta — prepara um lançamento (não grava)
/receita 50 descrição @conta — idem, entrada
/confirmar CÓDIGO — grava o lançamento proposto como PENDENTE
/cancelar CÓDIGO — cancela proposta ou tarefa ainda não executada
Nada movimenta dinheiro real. Lançamentos entram pendentes; você confirma no app.`;

export async function telegramWebhook(request, env) {
  if (!telegramConfigured(env)) fail(503, 'Telegram não configurado.');
  if (!await sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) fail(401, 'Não autorizado.');
  const update0 = await readJson(request, 32 * 1024);
  const msg = update0.message || update0.edited_message;
  if (!Number.isSafeInteger(update0.update_id) || !msg?.chat) return json({ ok: true });
  const db = env.DB, eventId = `tg:${update0.update_id}`, fromId = String(msg.from?.id ?? ''), chatId = msg.chat.id;
  if (await getRow(db, 'brain_events', eventId)) return json({ ok: true, duplicate: true });

  // Só o proprietário, em conversa privada. A recusa não revela nada sobre o sistema.
  if (fromId !== String(env.TELEGRAM_OWNER_ID) || msg.chat.type !== 'private') {
    await db.prepare('INSERT OR IGNORE INTO brain_events (id, received_at, from_id, command, outcome) VALUES (?, ?, ?, NULL, ?)').bind(eventId, nowIso(), fromId, 'recusado').run();
    return reply(chatId, 'Este bot é privado.');
  }
  if (update0.edited_message) { await eventStmt(db, eventId, fromId, null, 'ignorado: mensagem editada').run(); return reply(chatId, 'Mensagens editadas não são processadas. Envie de novo.'); }

  const c = parseCommand(msg.text);
  const ctx = { db, env, eventId, fromId, chatId };
  try {
    const out = await runCommand(c, msg.text, ctx);
    return reply(chatId, out);
  } catch (e) {
    if (isDuplicateEvent(e)) return json({ ok: true, duplicate: true });
    if (isRevisionConflict(e)) return reply(chatId, 'Esta proposta já foi processada. Nada foi gravado de novo.');
    const text = e?.status && e.status < 500 ? e.message : 'Falha ao processar. Nada foi gravado; tente de novo.';
    await eventStmt(db, eventId, fromId, c?.cmd || null, `erro: ${text}`.slice(0, 300)).run().catch(() => {});
    if (!(e?.status && e.status < 500)) console.error(e);
    return reply(chatId, text);
  }
}

async function readOnly(ctx, cmd, text) {
  await eventStmt(ctx.db, ctx.eventId, ctx.fromId, cmd, 'consulta').run();
  return text;
}

async function runCommand(c, raw, ctx) {
  const { db, env } = ctx;
  if (!c) return readOnly(ctx, null, 'Envie um comando. /ajuda mostra a lista.');
  switch (c.cmd) {
    case 'start': case 'ajuda': case 'help': return readOnly(ctx, c.cmd, HELP);
    case 'status': return readOnly(ctx, c.cmd, await statusText(db, env));
    case 'projetos': return readOnly(ctx, c.cmd, await projectsText(db));
    case 'financeiro': return readOnly(ctx, c.cmd, await financeText(db));
    case 'tarefa': return createTask(ctx, c.arg);
    case 'nota': {
      const text = v.text(c.arg, 'Nota', { max: 2000 });
      const row = { id: newId(), kind: 'pendencia', text, source: `Telegram ${today()}` };
      await create(db, 'brain_memory', row, 'memória', [eventStmt(db, ctx.eventId, ctx.fromId, c.cmd, `memória ${row.id}`)]);
      return 'Guardado na memória como pendência.';
    }
    case 'despesa': case 'receita': return propose(ctx, c.cmd, c.arg);
    case 'confirmar': return confirm(ctx, c.arg);
    case 'cancelar': return cancel(ctx, c.arg);
    default: return readOnly(ctx, c.cmd, `Comando /${c.cmd} não existe. /ajuda mostra a lista.`);
  }
}

async function statusText(db, env) {
  const tasks = await all(db, 'SELECT code, title, status, agent, blocked_reason, updated_at FROM brain_tasks');
  const count = s => tasks.filter(t => t.status === s).length;
  const waiting = (await db.prepare("SELECT count(*) n FROM brain_proposals WHERE status = 'aguardando' AND expires_at > ?").bind(nowIso()).first()).n;
  const blocked = tasks.filter(t => t.status === 'blocked').slice(0, 5);
  const byAge = (a, b) => a.updated_at.localeCompare(b.updated_at);
  const next = tasks.filter(t => t.status === 'ready').sort(byAge)[0] || tasks.filter(t => t.status === 'backlog').sort(byAge)[0];
  const last = tasks.map(t => t.updated_at).sort().pop();
  const ex = executors(env);
  return [
    'WALL Brain — status',
    `Tarefas: ${count('backlog')} backlog · ${count('ready')} prontas · ${count('running')} em execução · ${count('blocked')} bloqueadas · ${count('review')} em revisão · ${count('done')} concluídas`,
    ...(blocked.length ? ['Bloqueadas:', ...blocked.map(t => `• ${t.code} ${t.title} — ${t.blocked_reason || 'sem motivo registrado'}`)] : []),
    next ? `Próxima: ${next.code} ${next.title} (${AGENT_LABEL[next.agent] || next.agent})` : 'Próxima: nenhuma tarefa aberta.',
    `Propostas aguardando confirmação: ${waiting}`,
    ex.length ? `Executores cloud: ${ex.map(a => AGENT_LABEL[a]).join(', ')}` : 'Executor cloud: nenhum conectado. Tarefas de agentes ficam bloqueadas.',
    `Última alteração de tarefa: ${last ? last.slice(0, 16).replace('T', ' ') + ' UTC' : '—'}`,
  ].join('\n');
}

async function projectsText(db) {
  const [projects, tasks] = await Promise.all([
    all(db, "SELECT title, status FROM os_items WHERE module = 'projeto' AND deleted_at IS NULL AND archived = 0 ORDER BY sort"),
    all(db, "SELECT project, count(*) n FROM brain_tasks WHERE status NOT IN ('done','cancelled') GROUP BY project ORDER BY n DESC"),
  ]);
  return ['Projetos (WALL OS):', ...(projects.length ? projects.map(p => `• ${p.title} — ${p.status.replace('_', ' ')}`) : ['• nenhum cadastrado no WALL OS']),
    'Tarefas abertas por projeto:', ...(tasks.length ? tasks.map(t => `• #${t.project}: ${t.n}`) : ['• nenhuma'])].join('\n');
}

async function financeText(db) {
  const data = await loadFinance(db);
  const d = dashboard(data, today());
  const lines = ['WALL Finance — saldos CALCULADOS pelo app (não é extrato do banco)'];
  for (const a of d.accounts) {
    const ref = a.anchor ? ` · referência ${a.anchor.date.split('-').reverse().join('/')}${a.anchor.status === 'confirmado' ? '' : ' (a confirmar)'}` : ' · sem saldo de referência';
    lines.push(`• ${a.name}: ${formatMoney(a.balance, a.currency)}${ref}${a.pending ? ` · pendente ${formatMoney(a.pending, a.currency, { sign: true })}` : ''}`);
  }
  for (const [cur, b] of Object.entries(d.byCurrency)) if (b.total || b.reserve) lines.push(`Livre de reservas em ${cur}: ${formatMoney(b.available, cur)}`);
  for (const r of d.reserves) lines.push(`Reserva ${r.name}: ${formatMoney(r.allocated_cents, r.currency)} de ${formatMoney(r.target_cents, r.currency)} — faltam ${formatMoney(r.deficit, r.currency)}`);
  if (d.pendingCount) lines.push(`${d.pendingCount} lançamento(s) pendente(s) aguardando sua confirmação no app.`);
  return lines.join('\n');
}

async function createTask(ctx, arg) {
  const { db, env } = ctx;
  const p = parseTask(arg);
  const f = applyTaskRules({ title: v.text(p.title, 'Título da tarefa', { max: 200 }), project: p.project, agent: p.agent, status: p.agent === 'wallacy' ? 'backlog' : 'ready' }, env);
  const row = { ...f, code: 'T-' + randomCode(), source: 'telegram', source_ref: ctx.eventId };
  await create(db, 'brain_tasks', row, 'tarefa', [eventStmt(db, ctx.eventId, ctx.fromId, 'tarefa', `tarefa ${row.code}`)]);
  return `Tarefa ${row.code} criada (#${row.project}, ${AGENT_LABEL[row.agent]}).${row.status === 'blocked' ? `\nBloqueada: ${row.blocked_reason}` : ''}`;
}

async function propose(ctx, kind, arg) {
  const { db } = ctx;
  const m = parseMoneyCommand(arg);
  if (!m.amount_cents) fail(400, `Valor não reconhecido. Exemplo: /${kind} 12,50 Mercado @revolut`);
  const description = v.text(m.description, 'Descrição', { max: 200 });
  const fin = await loadFinance(db);
  const active = fin.accounts.filter(a => !a.archived);
  let acc = null;
  if (m.account) {
    const hits = active.filter(a => norm(a.name).replace(/\s/g, '').includes(m.account.replace(/\s/g, '')));
    if (hits.length !== 1) fail(400, hits.length ? `Mais de uma conta combina com “@${m.account}”: ${hits.map(a => a.name).join(', ')}.` : `Nenhuma conta combina com “@${m.account}”.`);
    acc = hits[0];
  } else {
    const s = suggestAccount({ currency: 'EUR', merchant: description }, active, fin.transactions);
    acc = active.find(a => a.id === s?.id) || active.find(a => a.currency === 'EUR' && !a.is_reserve && !a.exclude_from_budget);
  }
  if (!acc) fail(400, 'Nenhuma conta ativa no WALL Finance.');
  const payload = { kind, account_id: acc.id, account_name: acc.name, currency: acc.currency, amount_cents: kind === 'despesa' ? -m.amount_cents : m.amount_cents, description, date: today() };
  const payload_json = JSON.stringify(payload), payload_hash = await sha256(payload_json), id = newId();
  const code = await confirmCode(id, payload_hash);
  const dups = findDuplicates({ amount_cents: payload.amount_cents, date: payload.date, currency: acc.currency, merchant: description }, fin.transactions, 2);
  const expires_at = new Date(Date.now() + PROPOSAL_MINUTES * 60000).toISOString();
  await create(db, 'brain_proposals', { id, code, kind, payload_json, payload_hash, from_id: ctx.fromId, status: 'aguardando', expires_at }, 'proposta',
    [eventStmt(db, ctx.eventId, ctx.fromId, kind, `proposta ${code}`)]);
  return [`Proposta de ${kind}: ${formatMoney(payload.amount_cents, acc.currency, { sign: true })} — ${description}`,
    `Conta: ${acc.name} · data ${payload.date.split('-').reverse().join('/')}`,
    ...(dups.length ? [`Atenção: parecido com “${dups[0].description}” de ${dups[0].date.split('-').reverse().join('/')} (${formatMoney(dups[0].amount_cents, acc.currency)}). Confira se não é o mesmo gasto.`] : []),
    `Para gravar como PENDENTE: /confirmar ${code}`, `Vale por ${PROPOSAL_MINUTES} minutos. Nada foi gravado ainda.`].join('\n');
}

async function confirm(ctx, arg) {
  const { db } = ctx;
  const code = String(arg || '').trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(code)) fail(400, 'Use: /confirmar CÓDIGO (6 caracteres, recebido na proposta).');
  const p = await db.prepare('SELECT * FROM brain_proposals WHERE code = ?').bind(code).first();
  if (!p || p.from_id !== ctx.fromId) fail(404, 'Código não encontrado.');
  if (p.status !== 'aguardando') fail(409, `Esta proposta já está ${p.status}. Nada foi gravado de novo.`);
  if (p.expires_at <= nowIso()) {
    await update(db, 'brain_proposals', p.id, p.version, { status: 'expirada', decided_at: nowIso() }, 'proposta', [eventStmt(db, ctx.eventId, ctx.fromId, 'confirmar', `expirada ${code}`)]);
    fail(410, 'Proposta vencida. Envie a despesa de novo para gerar outro código.');
  }
  // O código precisa corresponder ao conteúdo guardado: qualquer alteração invalida a confirmação.
  if (await sha256(p.payload_json) !== p.payload_hash || await confirmCode(p.id, p.payload_hash) !== code) fail(409, 'O conteúdo da proposta não corresponde ao código. Envie de novo.');
  const x = JSON.parse(p.payload_json);
  const acc = await getRow(db, 'fin_accounts', x.account_id);
  if (!acc || acc.archived) fail(409, 'A conta da proposta não está mais ativa.');
  const at = nowIso(), txId = newId();
  const tx = { id: txId, account_id: acc.id, kind: x.kind, amount_cents: x.amount_cents, currency: acc.currency, date: x.date, description: x.description,
    merchant: x.description.slice(0, 120), category: 'Outros', status: 'pendente', import_hash: `brain:${p.id}`,
    notes: `Proposto pelo Telegram e confirmado com /confirmar ${code}. Confira e confirme no app para entrar no saldo.`, created_at: at, updated_at: at, version: 1 };
  const keys = Object.keys(tx);
  await db.batch([
    db.prepare("UPDATE brain_proposals SET status = 'confirmada', decided_at = ?, result_ref = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'aguardando'").bind(at, txId, at, p.id),
    // Se a proposta já tinha sido usada (dois /confirmar ao mesmo tempo), falha e desfaz tudo.
    db.prepare('INSERT INTO sys_revision (id, value) SELECT 1, 0 WHERE changes() = 0'),
    db.prepare(`INSERT INTO fin_transactions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => tx[k])),
    auditStmt(db, 'fin_audit', 'criar', 'transação', txId, null, { ...tx, origem: 'telegram', proposta: p.id }),
    eventStmt(db, ctx.eventId, ctx.fromId, 'confirmar', `lançamento ${txId}`),
    bump(db),
  ]);
  return `Gravado como PENDENTE em ${acc.name}: ${formatMoney(x.amount_cents, acc.currency, { sign: true })} — ${x.description}.\nNão mexe no saldo até você confirmar no app. Nenhum dinheiro foi movimentado.`;
}

async function cancel(ctx, arg) {
  const { db } = ctx;
  const code = String(arg || '').trim().toUpperCase();
  if (/^T-[A-Z0-9]{5}$/.test(code)) {
    const t = await db.prepare('SELECT * FROM brain_tasks WHERE code = ?').bind(code).first();
    if (!t) fail(404, 'Tarefa não encontrada.');
    if (!['backlog', 'ready', 'blocked'].includes(t.status)) fail(409, `A tarefa ${code} está ${t.status} e não pode ser cancelada por aqui.`);
    await update(db, 'brain_tasks', t.id, t.version, { status: 'cancelled', blocked_reason: null }, 'tarefa', [eventStmt(db, ctx.eventId, ctx.fromId, 'cancelar', `tarefa ${code}`)]);
    return `Tarefa ${code} cancelada.`;
  }
  const p = await db.prepare('SELECT * FROM brain_proposals WHERE code = ?').bind(code).first();
  if (!p || p.from_id !== ctx.fromId) fail(404, 'Código não encontrado.');
  if (p.status !== 'aguardando') fail(409, `Esta proposta já está ${p.status}.`);
  await update(db, 'brain_proposals', p.id, p.version, { status: 'cancelada', decided_at: nowIso() }, 'proposta', [eventStmt(db, ctx.eventId, ctx.fromId, 'cancelar', `proposta ${code}`)]);
  return `Proposta ${code} cancelada. Nada foi gravado.`;
}

// Backup completo, restauração e importação do piloto (wall-finance-pilot).
import { fail, json, readJson } from './http.js';
import { v, newId, nowIso, revision, auditStmt, bump } from './store.js';
import { today } from '../public/shared/finance.js';
import { parseAmount } from '../public/shared/money.js';

const TABLES = ['fin_accounts', 'fin_snapshots', 'fin_transactions', 'fin_attachments', 'fin_budgets', 'fin_recurring',
  'fin_delivery_shifts', 'fin_goals', 'fin_investments', 'fin_settings', 'fin_audit', 'os_items', 'os_audit'];

export async function backup(env, withAttachments) {
  const out = { format: 'wall-finance-backup', version: 1, exported_at: nowIso(), revision: await revision(env.DB), tables: {} };
  for (const t of TABLES) {
    const sql = t === 'fin_attachments' && !withAttachments
      ? 'SELECT id, transaction_id, filename, mime, size, extracted_json, created_at FROM fin_attachments' : `SELECT * FROM ${t}`;
    out.tables[t] = (await env.DB.prepare(sql).all()).results;
  }
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="wall-finance-backup-${today()}${withAttachments ? '-completo' : ''}.json"` } });
}

const COLUMN_RE = /^[a-z_0-9]+$/;
function insert(db, table, row, allowed) {
  const keys = Object.keys(row).filter(k => COLUMN_RE.test(k) && (!allowed || allowed.has(k)));
  return db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => row[k] ?? null));
}

// Restauração substitui TODOS os dados atuais pelos do arquivo. Exige confirmação digitada.
export async function restore(request, env) {
  const i = await readJson(request, 50_000_000);
  if (i.confirm !== 'RESTAURAR') fail(400, 'Digite RESTAURAR para confirmar a substituição dos dados.');
  const b = i.backup;
  if (b?.format !== 'wall-finance-backup' || typeof b.tables !== 'object') fail(400, 'Arquivo não é um backup do WALL Finance.');
  const db = env.DB;
  // Anexos sem conteúdo (backup "leve") são mantidos se já existirem no banco.
  const keepAttachments = (b.tables.fin_attachments || []).some(a => !a.data_b64);
  const stmts = [];
  for (const t of [...TABLES].reverse()) if (!(t === 'fin_attachments' && keepAttachments)) stmts.push(db.prepare(`DELETE FROM ${t}`));
  for (const t of TABLES) {
    if (t === 'fin_attachments' && keepAttachments) continue;
    const cols = new Set((await db.prepare(`PRAGMA table_info(${t})`).all()).results.map(c => c.name));
    for (const row of b.tables[t] || []) stmts.push(insert(db, t, row, cols));
  }
  stmts.push(auditStmt(db, 'fin_audit', 'restaurar', 'backup', 'all', null, { exported_at: b.exported_at, revision: b.revision }), bump(db));
  // D1 executa cada lote numa transação; lotes grandes são divididos.
  for (let k = 0; k < stmts.length; k += 500) await db.batch(stmts.slice(k, k + 500));
  return json({ ok: true, restored: Object.fromEntries(TABLES.map(t => [t, (b.tables[t] || []).length])) });
}

// Importa o JSON exportado pelo piloto (/api/export). Não apaga nada; roda uma única vez.
export async function importPilot(request, env) {
  const i = await readJson(request, 10_000_000);
  const p = i.data;
  if (!p || !Array.isArray(p.entries)) fail(400, 'Arquivo não parece um backup do piloto (wall-backup.json).');
  const db = env.DB;
  const done = await db.prepare("SELECT value FROM fin_settings WHERE key = 'pilot_import_at'").first();
  if (done && i.force !== true) fail(409, `O piloto já foi importado em ${done.value}.`);
  const at = nowIso(), stmts = [], report = { contas: 0, transacoes: 0, ignoradas: 0, metas: 0, investimentos: 0, orcamentos: 0, wall_os: 0 };
  const accounts = new Map((await db.prepare('SELECT id, name FROM fin_accounts').all()).results.map(a => [a.name.toLowerCase(), a.id]));
  const accountFor = name => {
    const key = (name || 'Conta do piloto').trim().toLowerCase();
    if (!accounts.has(key)) {
      const id = newId(); accounts.set(key, id); report.contas++;
      stmts.push(insert(db, 'fin_accounts', { id, name: (name || 'Conta do piloto').trim().slice(0, 80), institution: 'Importada do piloto', currency: 'EUR', kind: 'outro', is_reserve: 0, archived: 0, sort: 99, created_at: at, updated_at: at, version: 1 }));
    }
    return accounts.get(key);
  };
  const cents = s => parseAmount(String(s ?? '').replace(/^(\d+)\.(\d{1,2})$/, '$1,$2'));
  for (const e of p.entries) {
    const amount = cents(e.amount);
    if (e.status === 'cancelled' || !amount || !/^\d{4}-\d{2}-\d{2}$/.test(e.day || '')) { report.ignoradas++; continue; }
    stmts.push(insert(db, 'fin_transactions', { id: newId(), account_id: accountFor(e.account), kind: e.type === 'income' ? 'receita' : 'despesa',
      amount_cents: e.type === 'income' ? amount : -amount, currency: 'EUR', date: e.day, description: String(e.description || 'Importado').slice(0, 200),
      category: String(e.category || 'Outros').slice(0, 60), status: e.status === 'confirmed' ? 'confirmada' : 'pendente',
      notes: 'Importado do piloto', created_at: e.at || at, updated_at: at, version: 1 }));
    report.transacoes++;
  }
  for (const g of p.goals || []) { const t = cents(g.amount); if (!t) continue; report.metas++;
    stmts.push(insert(db, 'fin_goals', { id: newId(), name: String(g.name).slice(0, 120), kind: 'manual', target_cents: t, currency: 'EUR', due_date: g.due || null, saved_cents: cents(g.saved) || 0, notes: 'Importado do piloto', created_at: at, updated_at: at, version: 1 })); }
  for (const x of p.investments || []) { const c = cents(x.cost); if (!c) continue; report.investimentos++;
    stmts.push(insert(db, 'fin_investments', { id: newId(), name: String(x.name).slice(0, 120), kind: String(x.kind || 'Outro').slice(0, 60), currency: 'EUR', invested_cents: c, current_cents: x.value ? cents(x.value) : null, valued_at: x.day || null, notes: 'Importado do piloto', created_at: at, updated_at: at, version: 1 })); }
  for (const b of p.budgets || []) { const l = cents(b.daily); if (!l) continue; report.orcamentos++;
    stmts.push(insert(db, 'fin_budgets', { id: newId(), name: String(b.category).slice(0, 80), category: String(b.category).slice(0, 60), period: 'diario', limit_cents: l, currency: 'EUR', active: 1, created_at: at, updated_at: at, version: 1 })); }
  const os = (module, title, extra) => { report.wall_os++; stmts.push(insert(db, 'os_items', { id: newId(), module, title: String(title || 'Sem título').slice(0, 200), status: 'aberto', done: 0, created_at: at, updated_at: at, version: 1, ...extra })); };
  for (const j of p.journal || []) os('diario', j.title, { date: j.day, body: [j.text, j.mood && `Humor: ${j.mood}`].filter(Boolean).join('\n\n') });
  for (const c of p.checklist || []) os('checklist', c.title, { date: c.day, done: c.done ? 1 : 0 });
  for (const t of p.tasks || []) os('checklist', t.title, { done: t.done ? 1 : 0 });
  for (const ev of p.events || []) os('evento', ev.title, { date: ev.day, time: ev.time || null, body: ev.notes || null });
  for (const pl of p.plans || []) os('plano', pl.title, { date: pl.due || null, body: pl.notes || null, status: pl.status === 'done' ? 'concluido' : pl.status === 'cancelled' ? 'cancelado' : 'aberto' });
  stmts.push(db.prepare("INSERT INTO fin_settings (key, value, updated_at) VALUES ('pilot_import_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(at, at),
    auditStmt(db, 'fin_audit', 'importar', 'piloto', 'pilot', null, report), bump(db));
  for (let k = 0; k < stmts.length; k += 500) await db.batch(stmts.slice(k, k + 500));
  return json({ ok: true, report });
}

export const backupTables = TABLES;
export { v };

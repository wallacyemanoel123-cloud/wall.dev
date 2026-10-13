// Camada de dados: validação, gravação versionada (concorrência otimista) e auditoria.
import { fail } from './http.js';
import { isDate } from '../public/shared/finance.js';

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

// ───── validação ─────
export const v = {
  text(val, label, { max = 200, required = true } = {}) {
    const s = val === null || val === undefined ? '' : String(val).trim();
    if (!s) { if (required) fail(400, `${label}: campo obrigatório.`); return null; }
    if (s.length > max) fail(400, `${label}: máximo de ${max} caracteres.`);
    return s;
  },
  cents(val, label, { allowZero = false, allowNegative = false, required = true } = {}) {
    if (val === null || val === undefined || val === '') { if (required) fail(400, `${label}: informe o valor.`); return null; }
    if (!Number.isSafeInteger(val) || Math.abs(val) > 1e13) fail(400, `${label}: valor inválido.`);
    if (!allowNegative && val < 0) fail(400, `${label}: valor não pode ser negativo.`);
    if (!allowZero && val === 0) fail(400, `${label}: valor deve ser maior que zero.`);
    return val;
  },
  int(val, label, { min = 0, max = 1e9 } = {}) {
    const n = val === '' || val === null || val === undefined ? 0 : val;
    if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, `${label}: número inválido.`);
    return n;
  },
  date(val, label, { required = true } = {}) {
    if (!val) { if (required) fail(400, `${label}: informe a data.`); return null; }
    if (!isDate(val)) fail(400, `${label}: data inválida.`);
    return val;
  },
  time(val, label) {
    if (!val) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) fail(400, `${label}: hora inválida.`);
    return val;
  },
  oneOf(val, label, list) { if (!list.includes(val)) fail(400, `${label}: opção inválida.`); return val; },
  bool: val => (val === true || val === 1 || val === '1' ? 1 : 0),
  currency(val) { if (!['EUR', 'BRL'].includes(val)) fail(400, 'Moeda deve ser EUR ou BRL.'); return val; },
  id(val, label = 'Identificador') { if (typeof val !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(val)) fail(400, `${label} inválido.`); return val; },
};

// ───── gravação ─────
const bump = db => db.prepare('UPDATE sys_revision SET value = value + 1 WHERE id = 1');
const auditStmt = (db, table, action, entity, entityId, before, after, onlyIfChanged = false) => {
  const sql = table === 'os_audit'
    ? `INSERT INTO os_audit (id, at, action, entity_id, before_json, after_json) SELECT ?, ?, ?, ?, ?, ?${onlyIfChanged ? ' WHERE changes() > 0' : ''}`
    : `INSERT INTO fin_audit (id, at, action, entity, entity_id, before_json, after_json, origin) SELECT ?, ?, ?, ?, ?, ?, ?, ?${onlyIfChanged ? ' WHERE changes() > 0' : ''}`;
  const args = table === 'os_audit'
    ? [newId(), nowIso(), action, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    : [newId(), nowIso(), action, entity, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, 'titular'];
  return db.prepare(sql).bind(...args);
};
const auditTable = table => (table.startsWith('os_') ? 'os_audit' : 'fin_audit');

export async function getRow(db, table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
}

export async function revision(db) {
  return (await db.prepare('SELECT value FROM sys_revision WHERE id = 1').first()).value;
}

function insertStmt(db, table, row) {
  const keys = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => row[k]));
}

// Cria vários registros numa única transação (ex.: duas pernas de transferência).
export async function createMany(db, table, rows, entity, extra = []) {
  const at = nowIso();
  const full = rows.map(r => ({ id: newId(), created_at: at, ...(hasUpdated(table) ? { updated_at: at } : {}), ...r }));
  await db.batch([
    ...full.flatMap(r => [insertStmt(db, table, r), auditStmt(db, auditTable(table), 'criar', entity, r.id, null, r)]),
    ...extra, bump(db),
  ]);
  return full;
}
const hasUpdated = table => !['fin_snapshots', 'fin_attachments'].includes(table);

export async function create(db, table, row, entity, extra = []) {
  return (await createMany(db, table, [row], entity, extra))[0];
}

// Atualização com controle de versão: se outro aparelho alterou antes, devolve 409.
export async function update(db, table, id, version, changes, entity, extra = []) {
  const before = await getRow(db, table, id);
  if (!before || before.deleted_at) fail(404, 'Registro não encontrado.');
  if (version !== undefined && version !== before.version) fail(409, 'Este registro foi alterado em outro aparelho. Atualize a tela e tente de novo.', { current: before });
  const keys = Object.keys(changes);
  const after = { ...before, ...changes, version: before.version + 1, updated_at: nowIso() };
  const res = await db.batch([
    db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
      .bind(...keys.map(k => changes[k]), after.updated_at, id, before.version),
    auditStmt(db, auditTable(table), 'editar', entity, id, before, after, true),
    ...extra, bump(db),
  ]);
  if (res[0].meta.changes !== 1) fail(409, 'Este registro foi alterado em outro aparelho. Atualize a tela e tente de novo.');
  return after;
}

// Exclusão lógica (deleted_at) quando a tabela suporta; senão, remoção física auditada.
export async function remove(db, table, id, entity, { soft = false, extra = [] } = {}) {
  const before = await getRow(db, table, id);
  if (!before || before.deleted_at) fail(404, 'Registro não encontrado.');
  const stmt = soft
    ? db.prepare(`UPDATE ${table} SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), id)
    : db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id);
  await db.batch([stmt, auditStmt(db, auditTable(table), 'excluir', entity, id, before, null), ...extra, bump(db)]);
  return before;
}

export { auditStmt, bump };

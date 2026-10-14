// WALL OS (/api/os/*): hoje, planejamento, metas, projetos, diário, checklist, calendário,
// hábitos e estudos. Tabelas próprias (os_*), separadas do financeiro (fin_*).
import { fail, json, readJson } from './http.js';
import { v, create, update, remove, newId, nowIso, auditStmt, bump } from './store.js';

export const MODULES = ['objetivo', 'plano', 'diario', 'checklist', 'evento', 'projeto', 'habito', 'estudo'];
const HORIZONS = ['curto', 'medio', 'longo'];

export async function osRoutes(request, env, parts) {
  const db = env.DB, [resource, id] = parts;

  if (resource === 'items') {
    if (request.method === 'GET') {
      const { results } = await db.prepare('SELECT * FROM os_items WHERE deleted_at IS NULL ORDER BY sort, COALESCE(date, created_at) DESC').all();
      return json(results);
    }
    if (request.method === 'POST') {
      const i = await readJson(request);
      const module = v.oneOf(i.module, 'Módulo', MODULES);
      const f = {
        module, title: v.text(i.title, 'Título', { max: 200 }),
        body: v.text(i.body, 'Texto', { required: false, max: 10000 }),
        date: v.date(i.date, 'Data', { required: ['diario', 'evento', 'estudo'].includes(module) }),
        time: v.time(i.time, 'Hora'),
        status: v.oneOf(i.status || 'aberto', 'Situação', ['aberto', 'em_andamento', 'concluido', 'cancelado']),
        done: v.bool(i.done),
        horizon: i.horizon ? v.oneOf(i.horizon, 'Prazo', HORIZONS) : null,
        archived: v.bool(i.archived),
        data_json: i.data ? JSON.stringify(i.data).slice(0, 4000) : null,
      };
      return i.id ? json(await update(db, 'os_items', v.id(i.id), i.version, f, module)) : json(await create(db, 'os_items', f, module), 201);
    }
    if (request.method === 'DELETE') return json(await remove(db, 'os_items', v.id(id), 'item', { soft: true }));
  }

  // Hábitos: um registro por hábito e por dia (sono em horas, água em copos, exercício em minutos…).
  if (resource === 'habit-logs') {
    if (request.method === 'GET') {
      const { results } = await db.prepare('SELECT * FROM os_habit_logs WHERE date >= ? ORDER BY date DESC').bind(v.date(new URL(request.url).searchParams.get('from') || '2000-01-01', 'Data inicial')).all();
      return json(results);
    }
    if (request.method === 'POST') {
      const i = await readJson(request);
      const habit = await db.prepare("SELECT id FROM os_items WHERE id = ? AND module = 'habito' AND deleted_at IS NULL").bind(v.id(i.habit_id, 'Hábito')).first();
      if (!habit) fail(404, 'Hábito não encontrado.');
      const date = v.date(i.date, 'Data'), value = v.int(i.value, 'Valor', { max: 100000 }), note = v.text(i.note, 'Nota', { required: false, max: 500 });
      const before = await db.prepare('SELECT * FROM os_habit_logs WHERE habit_id = ? AND date = ?').bind(habit.id, date).first();
      const at = nowIso(), rowId = before?.id || newId();
      await db.batch([
        db.prepare('INSERT INTO os_habit_logs (id, habit_id, date, value, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(habit_id, date) DO UPDATE SET value = excluded.value, note = excluded.note, updated_at = excluded.updated_at, version = version + 1')
          .bind(rowId, habit.id, date, value, note, at, at),
        auditStmt(db, 'os_audit', before ? 'editar' : 'criar', 'hábito', rowId, before, { habit_id: habit.id, date, value, note }), bump(db),
      ]);
      return json({ ok: true, id: rowId });
    }
  }
  fail(404, 'Operação não encontrada.');
}

// Reordenar listas (WALL OS e lista de desejos): grava a nova posição de cada item.
const SORTABLE = { os_items: 'os_audit', fin_wishlist: 'fin_audit' };
export async function reorder(request, env) {
  const i = await readJson(request);
  if (!SORTABLE[i.table]) fail(400, 'Lista não pode ser reordenada.');
  const ids = Array.isArray(i.ids) ? i.ids.slice(0, 500).map(x => v.id(x)) : [];
  if (!ids.length) fail(400, 'Nada para reordenar.');
  const at = nowIso();
  await env.DB.batch([...ids.map((x, k) => env.DB.prepare(`UPDATE ${i.table} SET sort = ?, updated_at = ? WHERE id = ?`).bind(k, at, x)),
    auditStmt(env.DB, SORTABLE[i.table], 'reordenar', i.table, 'lista', null, { ids }), bump(env.DB)]);
  return json({ ok: true });
}

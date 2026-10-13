// WALL OS (/api/os/*): objetivos, planejamento, diário, checklist, calendário e projetos.
// Tabelas próprias (os_*), separadas do financeiro para permitir vender o WALL Finance sozinho.
import { fail, json, readJson } from './http.js';
import { v, create, update, remove } from './store.js';

export const MODULES = ['objetivo', 'plano', 'diario', 'checklist', 'evento', 'projeto'];

export async function osRoutes(request, env, parts) {
  const db = env.DB, [resource, id] = parts;
  if (resource !== 'items') fail(404, 'Operação não encontrada.');
  if (request.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM os_items WHERE deleted_at IS NULL ORDER BY COALESCE(date, created_at) DESC').all();
    return json(results);
  }
  if (request.method === 'POST') {
    const i = await readJson(request);
    const module = v.oneOf(i.module, 'Módulo', MODULES);
    const f = {
      module, title: v.text(i.title, 'Título', { max: 200 }),
      body: v.text(i.body, 'Texto', { required: false, max: 10000 }),
      date: v.date(i.date, 'Data', { required: ['diario', 'evento'].includes(module) }),
      time: v.time(i.time, 'Hora'),
      status: v.oneOf(i.status || 'aberto', 'Situação', ['aberto', 'em_andamento', 'concluido', 'cancelado']),
      done: v.bool(i.done),
      data_json: i.data ? JSON.stringify(i.data).slice(0, 4000) : null,
    };
    return i.id ? json(await update(db, 'os_items', v.id(i.id), i.version, f, module)) : json(await create(db, 'os_items', f, module), 201);
  }
  if (request.method === 'DELETE') return json(await remove(db, 'os_items', v.id(id), 'item', { soft: true }));
  fail(405, 'Método não permitido.');
}

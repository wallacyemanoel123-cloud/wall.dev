// Rotas do WALL Finance (/api/fin/*). Toda movimentação nasce de uma ação explícita do titular.
import { fail, json, readJson } from './http.js';
import { v, newId, nowIso, getRow, create, createMany, update, remove, revision, auditStmt, bump } from './store.js';
import { CATEGORIES, today, nextOccurrence, reconcile, findDuplicates, toCSV, accountBalance, suggestAccount } from '../public/shared/finance.js';
import { sha256 } from './auth.js';

const KINDS = ['banco', 'carteira_digital', 'especie', 'reserva', 'investimento', 'outro'];
const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;

export async function loadFinance(db) {
  const [accounts, snapshots, transactions, budgets, recurring, shifts, goals, investments, settingsRows, attachments, reserves, planned, wishlist, investmentOps] = await Promise.all([
    all(db, 'SELECT * FROM fin_accounts ORDER BY archived, sort, created_at'),
    all(db, 'SELECT * FROM fin_snapshots ORDER BY date DESC, created_at DESC'),
    all(db, 'SELECT * FROM fin_transactions WHERE deleted_at IS NULL ORDER BY date DESC, created_at DESC'),
    all(db, 'SELECT * FROM fin_budgets ORDER BY created_at'),
    all(db, 'SELECT * FROM fin_recurring ORDER BY next_date'),
    all(db, 'SELECT * FROM fin_delivery_shifts ORDER BY date DESC, created_at DESC'),
    all(db, 'SELECT * FROM fin_goals ORDER BY created_at'),
    all(db, 'SELECT * FROM fin_investments ORDER BY created_at'),
    all(db, 'SELECT key, value FROM fin_settings'),
    all(db, 'SELECT id, transaction_id, filename, mime, size, extracted_json, created_at FROM fin_attachments ORDER BY created_at DESC'),
    all(db, 'SELECT * FROM fin_reserves ORDER BY archived, created_at'),
    all(db, 'SELECT * FROM fin_planned ORDER BY status, due_date'),
    all(db, 'SELECT * FROM fin_wishlist ORDER BY status, sort, created_at'),
    all(db, 'SELECT * FROM fin_investment_ops ORDER BY date DESC, created_at DESC'),
  ]);
  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
  return { accounts, snapshots, transactions, budgets, recurring, shifts, goals, investments, settings, attachments, reserves, planned, wishlist, investmentOps, categories: CATEGORIES };
}

async function account(db, id) {
  const a = await getRow(db, 'fin_accounts', v.id(id, 'Conta'));
  if (!a) fail(404, 'Conta não encontrada.');
  return a;
}

// Saída de dinheiro protegido exige confirmação explícita: contas-reserva inteiras ou a parte
// do saldo reservada dentro de uma conta (fin_reserves). Reservar nunca cria despesa.
async function guardReserve(db, acc, amount, input) {
  if (amount >= 0 || input.confirm_reserve === true) return;
  if (acc.is_reserve) fail(428, `“${acc.name}” é uma reserva protegida. Confirme que deseja retirar dinheiro dela.`, { code: 'reserva' });
  const reserves = await all(db, 'SELECT name, allocated_cents FROM fin_reserves WHERE account_id = ? AND archived = 0 AND allocated_cents > 0', acc.id);
  if (!reserves.length) return;
  const allocated = reserves.reduce((s, r) => s + r.allocated_cents, 0);
  const [snaps, txs] = await Promise.all([all(db, 'SELECT * FROM fin_snapshots WHERE account_id = ?', acc.id), all(db, 'SELECT * FROM fin_transactions WHERE account_id = ? AND deleted_at IS NULL', acc.id)]);
  const { balance } = accountBalance(acc, snaps, txs);
  if (balance + amount < allocated) {
    fail(428, `Este valor usaria dinheiro reservado em “${acc.name}” (${reserves.map(r => r.name).join(', ')}). Confirme se deseja mesmo usar a reserva.`, { code: 'reserva' });
  }
}

function txFields(input, acc) {
  const kind = v.oneOf(input.kind, 'Tipo', ['receita', 'despesa', 'ajuste']);
  const raw = v.cents(input.amount_cents, 'Valor', { allowNegative: kind === 'ajuste' });
  const amount = kind === 'despesa' ? -raw : raw;
  return {
    account_id: acc.id, kind, amount_cents: amount, currency: acc.currency,
    date: v.date(input.date, 'Data'),
    description: v.text(input.description, 'Descrição'),
    merchant: v.text(input.merchant, 'Estabelecimento', { required: false, max: 120 }),
    category: v.text(input.category || 'Outros', 'Categoria', { max: 60 }),
    status: v.oneOf(input.status || 'confirmada', 'Status', ['confirmada', 'pendente']),
    notes: v.text(input.notes, 'Notas', { required: false, max: 2000 }),
  };
}

const linkAttachments = (db, ids, txId) => (Array.isArray(ids) ? ids.slice(0, 10) : []).map(id =>
  db.prepare('UPDATE fin_attachments SET transaction_id = ? WHERE id = ? AND transaction_id IS NULL').bind(txId, v.id(id, 'Anexo')));

const setting = (db, key, value) => db.prepare('INSERT INTO fin_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(key, String(value), nowIso());

export async function finRoutes(request, env, parts, url) {
  const db = env.DB, method = request.method;
  const [resource, id, action] = parts;
  const body = () => readJson(request);

  if (resource === 'state' && method === 'GET') return json({ ...(await loadFinance(db)), revision: await revision(db), today: today() });

  // ───── contas ─────
  if (resource === 'accounts' && method === 'POST' && !id) {
    const i = await body();
    const fields = {
      name: v.text(i.name, 'Nome', { max: 80 }),
      institution: v.text(i.institution, 'Instituição', { required: false, max: 80 }),
      kind: v.oneOf(i.kind, 'Tipo de conta', KINDS),
      is_reserve: v.bool(i.is_reserve),
      reserve_target_cents: i.reserve_target_cents ? v.cents(i.reserve_target_cents, 'Meta da reserva') : null,
      sort: v.int(i.sort ?? 0, 'Ordem'),
      exclude_from_budget: v.bool(i.exclude_from_budget),
      notes: v.text(i.notes, 'Notas', { required: false, max: 1000 }),
    };
    if (i.id) return json(await update(db, 'fin_accounts', v.id(i.id), i.version, { ...fields, archived: v.bool(i.archived) }, 'conta'));
    return json(await create(db, 'fin_accounts', { ...fields, currency: v.currency(i.currency) }, 'conta'), 201);
  }

  // ───── fotografias de saldo ─────
  if (resource === 'snapshots' && method === 'POST' && !id) {
    const i = await body();
    const acc = await account(db, i.account_id);
    return json(await create(db, 'fin_snapshots', {
      account_id: acc.id,
      amount_cents: v.cents(i.amount_cents, 'Saldo', { allowZero: true, allowNegative: true }),
      date: v.date(i.date, 'Data'),
      source: v.text(i.source, 'Fonte', { max: 200 }),
      status: v.oneOf(i.status || 'a_confirmar', 'Status', ['a_confirmar', 'confirmado']),
      is_anchor: v.bool(i.is_anchor),
      note: v.text(i.note, 'Observação', { required: false, max: 500 }),
    }, 'fotografia'), 201);
  }
  if (resource === 'snapshots' && action === 'confirm' && method === 'POST') {
    const s = await getRow(db, 'fin_snapshots', v.id(id));
    if (!s) fail(404, 'Fotografia não encontrada.');
    await db.batch([db.prepare("UPDATE fin_snapshots SET status = 'confirmado' WHERE id = ?").bind(s.id),
      auditStmt(db, 'fin_audit', 'confirmar', 'fotografia', s.id, s, { ...s, status: 'confirmado' }), bump(db)]);
    return json({ ok: true });
  }
  if (resource === 'snapshots' && method === 'DELETE') return json(await remove(db, 'fin_snapshots', v.id(id), 'fotografia'));

  // ───── transações ─────
  if (resource === 'transactions' && method === 'POST' && !id) {
    const i = await body();
    const acc = await account(db, i.account_id);
    if (i.id) {
      const current = await getRow(db, 'fin_transactions', v.id(i.id));
      if (!current || current.deleted_at) fail(404, 'Transação não encontrada.');
      if (current.kind === 'transferencia') fail(400, 'Edite transferências pela tela de transferência.');
      const f = txFields(i, acc);
      // Só a diferença em relação ao valor atual pode avançar sobre dinheiro reservado.
      const delta = acc.id === current.account_id && current.status === 'confirmada' ? f.amount_cents - current.amount_cents : f.amount_cents;
      if (delta < 0) await guardReserve(db, acc, delta, i);
      return json(await update(db, 'fin_transactions', current.id, i.version, f, 'transação', linkAttachments(db, i.attachment_ids, current.id)));
    }
    const f = txFields(i, acc);
    await guardReserve(db, acc, f.amount_cents, i);
    const txId = newId();
    return json(await create(db, 'fin_transactions', { id: txId, ...f }, 'transação', linkAttachments(db, i.attachment_ids, txId)), 201);
  }
  if (resource === 'transactions' && method === 'DELETE') {
    const t = await getRow(db, 'fin_transactions', v.id(id));
    if (!t || t.deleted_at) fail(404, 'Transação não encontrada.');
    if (t.transfer_id) {
      const legs = await all(db, 'SELECT * FROM fin_transactions WHERE transfer_id = ? AND deleted_at IS NULL', t.transfer_id);
      const at = nowIso();
      await db.batch([...legs.flatMap(l => [
        db.prepare('UPDATE fin_transactions SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').bind(at, at, l.id),
        auditStmt(db, 'fin_audit', 'excluir', 'transferência', l.id, l, null)]), bump(db)]);
      return json({ ok: true, removed: legs.length });
    }
    return json(await remove(db, 'fin_transactions', t.id, 'transação', { soft: true }));
  }

  // ───── transferências: duas pernas ligadas, fora de receitas/despesas ─────
  if (resource === 'transfers' && method === 'POST') {
    const i = await body();
    const from = await account(db, i.from_account_id), to = await account(db, i.to_account_id);
    if (from.id === to.id) fail(400, 'Escolha contas diferentes.');
    const out = v.cents(i.amount_cents, 'Valor enviado');
    const inn = from.currency === to.currency ? out : v.cents(i.amount_to_cents, `Valor recebido em ${to.currency}`);
    await guardReserve(db, from, -out, i);
    const common = {
      kind: 'transferencia', date: v.date(i.date, 'Data'), category: 'Transferência',
      description: v.text(i.description || `Transferência ${from.name} → ${to.name}`, 'Descrição'),
      status: v.oneOf(i.status || 'confirmada', 'Status', ['confirmada', 'pendente']),
      notes: v.text(i.notes, 'Notas', { required: false, max: 2000 }),
    };
    if (i.transfer_id) {
      const legs = await all(db, 'SELECT * FROM fin_transactions WHERE transfer_id = ? AND deleted_at IS NULL', v.id(i.transfer_id));
      if (legs.length !== 2) fail(404, 'Transferência não encontrada.');
      const at = nowIso(), stmts = [];
      for (const l of legs) {
        const isOut = l.amount_cents < 0;
        const after = { ...common, account_id: isOut ? from.id : to.id, currency: isOut ? from.currency : to.currency, amount_cents: isOut ? -out : inn };
        stmts.push(db.prepare('UPDATE fin_transactions SET account_id=?, currency=?, amount_cents=?, date=?, description=?, status=?, notes=?, updated_at=?, version=version+1 WHERE id=?')
          .bind(after.account_id, after.currency, after.amount_cents, after.date, after.description, after.status, after.notes, at, l.id),
        auditStmt(db, 'fin_audit', 'editar', 'transferência', l.id, l, { ...l, ...after }));
      }
      await db.batch([...stmts, bump(db)]);
      return json({ ok: true, transfer_id: i.transfer_id });
    }
    const transfer_id = newId();
    const legs = await createMany(db, 'fin_transactions', [
      { ...common, transfer_id, account_id: from.id, currency: from.currency, amount_cents: -out },
      { ...common, transfer_id, account_id: to.id, currency: to.currency, amount_cents: inn },
    ], 'transferência');
    return json({ transfer_id, legs }, 201);
  }

  // ───── conciliação ─────
  if (resource === 'reconcile' && method === 'POST') {
    const i = await body();
    const acc = await account(db, i.account_id);
    const reported = v.cents(i.reported_cents, 'Saldo informado pelo banco', { allowZero: true, allowNegative: true });
    const date = v.date(i.date || today(), 'Data');
    const data = await loadFinance(db);
    const result = reconcile(acc, data.snapshots, data.transactions, reported, date);
    const mode = v.oneOf(i.mode || 'verificar', 'Ação', ['verificar', 'registrar', 'ajustar', 'ancorar']);
    if (mode === 'verificar') return json(result);
    const source = v.text(i.source || 'Saldo conferido no app do banco', 'Fonte');
    const snap = { account_id: acc.id, amount_cents: reported, date, source, status: 'confirmado', is_anchor: mode === 'ancorar' ? 1 : 0,
      note: `Conciliação: calculado ${result.computed}, diferença ${result.difference} (centavos)` };
    if (mode === 'ajustar' && result.difference !== 0) {
      await guardReserve(db, acc, result.difference, i);
      await createMany(db, 'fin_transactions', [{ account_id: acc.id, kind: 'ajuste', amount_cents: result.difference, currency: acc.currency, date,
        description: 'Ajuste de conciliação', category: 'Ajuste', status: 'confirmada', notes: 'Diferença entre saldo informado e calculado, autorizada pelo titular.' }], 'ajuste');
    }
    await create(db, 'fin_snapshots', snap, 'conciliação');
    return json({ ...result, mode });
  }

  // ───── orçamentos ─────
  if (resource === 'budgets' && method === 'POST') {
    const i = await body();
    const f = {
      name: v.text(i.name || i.category || 'Geral', 'Nome', { max: 80 }),
      category: v.text(i.category, 'Categoria', { required: false, max: 60 }),
      period: v.oneOf(i.period, 'Período', ['diario', 'semanal', 'mensal']),
      limit_cents: v.cents(i.limit_cents, 'Limite'),
      currency: v.currency(i.currency), active: i.active === undefined ? 1 : v.bool(i.active),
    };
    return i.id ? json(await update(db, 'fin_budgets', v.id(i.id), i.version, f, 'orçamento')) : json(await create(db, 'fin_budgets', f, 'orçamento'), 201);
  }
  if (resource === 'budgets' && method === 'DELETE') return json(await remove(db, 'fin_budgets', v.id(id), 'orçamento'));

  // ───── despesas fixas e recorrentes ─────
  if (resource === 'recurring' && method === 'POST' && !action) {
    const i = await body();
    const acc = await account(db, i.account_id);
    const f = {
      account_id: acc.id, kind: v.oneOf(i.kind, 'Tipo', ['receita', 'despesa']),
      amount_cents: v.cents(i.amount_cents, 'Valor'), description: v.text(i.description, 'Descrição'),
      category: v.text(i.category || 'Outros', 'Categoria', { max: 60 }),
      frequency: v.oneOf(i.frequency, 'Frequência', ['semanal', 'mensal', 'anual']),
      next_date: v.date(i.next_date, 'Próxima data'), is_fixed: v.bool(i.is_fixed ?? true), active: i.active === undefined ? 1 : v.bool(i.active),
    };
    return i.id ? json(await update(db, 'fin_recurring', v.id(i.id), i.version, f, 'recorrência')) : json(await create(db, 'fin_recurring', f, 'recorrência'), 201);
  }
  if (resource === 'recurring' && method === 'POST' && (action === 'launch' || action === 'skip')) {
    const r = await getRow(db, 'fin_recurring', v.id(id));
    if (!r) fail(404, 'Recorrência não encontrada.');
    const i = await body();
    const next = nextOccurrence(r.next_date, r.frequency);
    const advance = db.prepare('UPDATE fin_recurring SET next_date = ?, version = version + 1, updated_at = ? WHERE id = ? AND next_date = ?').bind(next, nowIso(), r.id, r.next_date);
    if (action === 'skip') {
      await db.batch([advance, auditStmt(db, 'fin_audit', 'pular', 'recorrência', r.id, r, { ...r, next_date: next }), bump(db)]);
      return json({ next_date: next });
    }
    const acc = await account(db, r.account_id);
    const amount = r.kind === 'despesa' ? -(i.amount_cents ? v.cents(i.amount_cents, 'Valor') : r.amount_cents) : (i.amount_cents ? v.cents(i.amount_cents, 'Valor') : r.amount_cents);
    await guardReserve(db, acc, amount, i);
    const tx = await create(db, 'fin_transactions', {
      account_id: acc.id, kind: r.kind, amount_cents: amount, currency: acc.currency, date: v.date(i.date || r.next_date, 'Data'),
      description: r.description, category: r.category, status: v.oneOf(i.status || 'confirmada', 'Status', ['confirmada', 'pendente']), recurring_id: r.id,
    }, 'transação', [advance]);
    return json({ transaction: tx, next_date: next }, 201);
  }
  if (resource === 'recurring' && method === 'DELETE') return json(await remove(db, 'fin_recurring', v.id(id), 'recorrência'));

  // ───── delivery ─────
  if (resource === 'shifts' && method === 'POST') {
    const i = await body();
    const acc = i.account_id ? await account(db, i.account_id) : null;
    const f = {
      date: v.date(i.date, 'Data'), platform: v.text(i.platform, 'Plataforma', { max: 60 }),
      hours_x100: v.int(i.hours_x100, 'Horas', { max: 2400 }), km_x10: v.int(i.km_x10, 'Quilômetros', { max: 100000 }),
      orders: v.int(i.orders, 'Pedidos', { max: 1000 }),
      gross_cents: v.cents(i.gross_cents || 0, 'Ganhos', { allowZero: true }), tips_cents: v.cents(i.tips_cents || 0, 'Gorjetas', { allowZero: true }),
      costs_cents: v.cents(i.costs_cents || 0, 'Custos', { allowZero: true }),
      currency: acc ? acc.currency : v.currency(i.currency), account_id: acc?.id || null,
      notes: v.text(i.notes, 'Notas', { required: false, max: 2000 }),
    };
    if (i.id) return json(await update(db, 'fin_delivery_shifts', v.id(i.id), i.version, f, 'turno'));
    const shiftId = newId();
    const shift = await create(db, 'fin_delivery_shifts', { id: shiftId, ...f }, 'turno');
    // Lançar no extrato só quando o titular marca a opção.
    if (i.register === true) {
      if (!acc) fail(400, 'Escolha a conta onde o dinheiro entrou.');
      const status = v.oneOf(i.status || 'confirmada', 'Status', ['confirmada', 'pendente']);
      const rows = [];
      if (f.gross_cents + f.tips_cents > 0) rows.push({ account_id: acc.id, kind: 'receita', amount_cents: f.gross_cents + f.tips_cents, currency: acc.currency, date: f.date, description: `Delivery ${f.platform}`, category: 'Delivery', status, shift_id: shiftId });
      if (f.costs_cents > 0) { await guardReserve(db, acc, -f.costs_cents, i); rows.push({ account_id: acc.id, kind: 'despesa', amount_cents: -f.costs_cents, currency: acc.currency, date: f.date, description: `Custos delivery ${f.platform}`, category: 'Combustível', status, shift_id: shiftId }); }
      if (rows.length) await createMany(db, 'fin_transactions', rows, 'transação');
    }
    return json(shift, 201);
  }
  if (resource === 'shifts' && method === 'DELETE') return json(await remove(db, 'fin_delivery_shifts', v.id(id), 'turno'));

  // ───── metas e investimentos ─────
  if (resource === 'goals' && method === 'POST') {
    const i = await body();
    const kind = v.oneOf(i.kind, 'Tipo de meta', ['patrimonio', 'reserva', 'conta', 'manual']);
    const f = {
      name: v.text(i.name, 'Nome', { max: 120 }), kind, target_cents: v.cents(i.target_cents, 'Valor da meta'), currency: v.currency(i.currency),
      due_date: v.date(i.due_date, 'Prazo', { required: false }), account_id: kind === 'conta' ? (await account(db, i.account_id)).id : null,
      saved_cents: kind === 'manual' ? v.cents(i.saved_cents || 0, 'Valor guardado', { allowZero: true }) : 0,
      notes: v.text(i.notes, 'Notas', { required: false, max: 2000 }),
    };
    return i.id ? json(await update(db, 'fin_goals', v.id(i.id), i.version, f, 'meta')) : json(await create(db, 'fin_goals', f, 'meta'), 201);
  }
  if (resource === 'goals' && method === 'DELETE') return json(await remove(db, 'fin_goals', v.id(id), 'meta'));
  if (resource === 'investments' && method === 'POST') {
    const i = await body();
    const f = {
      name: v.text(i.name, 'Nome', { max: 120 }), kind: v.text(i.kind || 'Outro', 'Classe', { max: 60 }), currency: v.currency(i.currency),
      invested_cents: v.cents(i.invested_cents, 'Valor aplicado', { allowZero: true }),
      current_cents: i.current_cents === null || i.current_cents === undefined || i.current_cents === '' ? null : v.cents(i.current_cents, 'Valor atual', { allowZero: true }),
      valued_at: v.date(i.valued_at, 'Data da avaliação', { required: false }), notes: v.text(i.notes, 'Notas', { required: false, max: 2000 }),
    };
    return i.id ? json(await update(db, 'fin_investments', v.id(i.id), i.version, f, 'investimento')) : json(await create(db, 'fin_investments', f, 'investimento'), 201);
  }
  if (resource === 'investments' && method === 'DELETE') return json(await remove(db, 'fin_investments', v.id(id), 'investimento'));

  // ───── configurações ─────
  if (resource === 'settings' && method === 'POST') {
    const i = await body();
    const stmts = [];
    if ('eur_brl_milli' in i) {
      const rate = i.eur_brl_milli === null ? '' : v.int(i.eur_brl_milli, 'Taxa EUR→BRL', { min: 1, max: 1e6 });
      stmts.push(setting(db, 'eur_brl_milli', rate), setting(db, 'eur_brl_date', v.date(i.eur_brl_date || today(), 'Data da taxa')));
    }
    if ('ai_enabled' in i) stmts.push(setting(db, 'ai_enabled', v.bool(i.ai_enabled)));
    if (!stmts.length) fail(400, 'Nada para salvar.');
    await db.batch([...stmts, auditStmt(db, 'fin_audit', 'editar', 'configuração', 'settings', null, i), bump(db)]);
    return json({ ok: true });
  }

  // ───── anexos e recibos ─────
  if (resource === 'attachments' && method === 'POST' && !id) {
    const i = await readJson(request, 2_200_000);
    const mime = v.oneOf(i.mime, 'Tipo de arquivo', ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    if (typeof i.data_b64 !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(i.data_b64) || i.data_b64.length > 1_900_000) fail(413, 'Arquivo inválido ou maior que 1,4 MB.');
    const txId = i.transaction_id ? v.id(i.transaction_id) : null;
    const row = await create(db, 'fin_attachments', {
      transaction_id: txId, filename: v.text(i.filename || 'recibo', 'Nome do arquivo', { max: 120 }), mime,
      size: Math.floor(i.data_b64.length * 3 / 4), data_b64: i.data_b64,
      extracted_json: i.extracted ? JSON.stringify(i.extracted).slice(0, 4000) : null,
    }, 'anexo');
    delete row.data_b64;
    return json(row, 201);
  }
  if (resource === 'attachments' && id && method === 'GET') {
    const a = await db.prepare('SELECT mime, filename, data_b64 FROM fin_attachments WHERE id = ?').bind(v.id(id)).first();
    if (!a) fail(404, 'Anexo não encontrado.');
    return new Response(Uint8Array.from(atob(a.data_b64), c => c.charCodeAt(0)), { headers: {
      'Content-Type': a.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': `inline; filename="${a.filename.replace(/[^\w.-]/g, '_')}"` } });
  }
  if (resource === 'attachments' && method === 'DELETE') {
    const a = await db.prepare('SELECT id, transaction_id, filename, mime, size, created_at FROM fin_attachments WHERE id = ?').bind(v.id(id)).first();
    if (!a) fail(404, 'Anexo não encontrado.');
    await db.batch([db.prepare('DELETE FROM fin_attachments WHERE id = ?').bind(a.id), auditStmt(db, 'fin_audit', 'excluir', 'anexo', a.id, a, null), bump(db)]);
    return json({ ok: true });
  }
  if (resource === 'receipts' && id === 'check' && method === 'POST') {
    const i = await body();
    const candidate = { amount_cents: v.cents(i.amount_cents, 'Valor'), date: v.date(i.date, 'Data'), currency: v.currency(i.currency), merchant: i.merchant || '' };
    const txs = await all(db, 'SELECT * FROM fin_transactions WHERE deleted_at IS NULL AND date BETWEEN ? AND ?', addDaysIso(candidate.date, -3), addDaysIso(candidate.date, 3));
    const data = await loadFinance(db);
    return json({ duplicates: findDuplicates(candidate, txs), suggestion: suggestAccount({ ...candidate, text: String(i.text || '').slice(0, 5000) }, data.accounts, data.transactions) });
  }

  // ───── reservas dentro das contas ─────
  if (resource === 'reserves' && method === 'POST') {
    const i = await body();
    const acc = await account(db, i.account_id);
    const f = {
      name: v.text(i.name, 'Nome da reserva', { max: 80 }), account_id: acc.id,
      target_cents: v.cents(i.target_cents, 'Meta da reserva'),
      allocated_cents: v.cents(i.allocated_cents ?? 0, 'Valor reservado', { allowZero: true }),
      notes: v.text(i.notes, 'Notas', { required: false, max: 1000 }), archived: v.bool(i.archived),
    };
    const [snaps, txs] = await Promise.all([all(db, 'SELECT * FROM fin_snapshots WHERE account_id = ?', acc.id), all(db, 'SELECT * FROM fin_transactions WHERE account_id = ? AND deleted_at IS NULL', acc.id)]);
    const others = (await all(db, 'SELECT id, allocated_cents FROM fin_reserves WHERE account_id = ? AND archived = 0', acc.id)).filter(r => r.id !== i.id).reduce((s, r) => s + r.allocated_cents, 0);
    const { balance } = accountBalance(acc, snaps, txs);
    if (!f.archived && f.allocated_cents + others > Math.max(0, balance)) fail(400, `Valor reservado maior que o saldo calculado de “${acc.name}”. Reserve no máximo o que existe na conta.`);
    return i.id ? json(await update(db, 'fin_reserves', v.id(i.id), i.version, f, 'reserva')) : json(await create(db, 'fin_reserves', f, 'reserva'), 201);
  }

  // ───── planejadas: não mexem no saldo até virarem lançamento ─────
  if (resource === 'planned' && method === 'POST' && !action) {
    const i = await body();
    const acc = i.account_id ? await account(db, i.account_id) : null;
    const f = {
      account_id: acc?.id || null, kind: v.oneOf(i.kind || 'despesa', 'Tipo', ['receita', 'despesa']),
      amount_cents: v.cents(i.amount_cents, 'Valor'), currency: acc ? acc.currency : v.currency(i.currency),
      description: v.text(i.description, 'Descrição'), category: v.text(i.category || 'Outros', 'Categoria', { max: 60 }),
      due_date: v.date(i.due_date, 'Data prevista', { required: false }), notes: v.text(i.notes, 'Notas', { required: false, max: 2000 }),
      status: v.oneOf(i.status || 'planejada', 'Situação', ['planejada', 'cancelada', 'lancada']),
    };
    return i.id ? json(await update(db, 'fin_planned', v.id(i.id), i.version, f, 'planejada')) : json(await create(db, 'fin_planned', f, 'planejada'), 201);
  }
  if (resource === 'planned' && action === 'launch' && method === 'POST') {
    const p = await getRow(db, 'fin_planned', v.id(id));
    if (!p || p.status !== 'planejada') fail(404, 'Item planejado não encontrado ou já lançado.');
    const i = await body();
    const acc = await account(db, i.account_id || p.account_id);
    const raw = i.amount_cents ? v.cents(i.amount_cents, 'Valor') : p.amount_cents;
    const amount = p.kind === 'despesa' ? -raw : raw;
    await guardReserve(db, acc, amount, i);
    const txId = newId();
    const tx = await create(db, 'fin_transactions', { id: txId, account_id: acc.id, kind: p.kind, amount_cents: amount, currency: acc.currency,
      date: v.date(i.date || p.due_date || today(), 'Data'), description: p.description, category: p.category,
      status: v.oneOf(i.status || 'confirmada', 'Status', ['confirmada', 'pendente']), notes: p.notes }, 'transação',
      [db.prepare("UPDATE fin_planned SET status = 'lancada', transaction_id = ?, updated_at = ?, version = version + 1 WHERE id = ?").bind(txId, nowIso(), p.id)]);
    return json(tx, 201);
  }

  // ───── lista de desejos ─────
  if (resource === 'wishlist' && method === 'POST') {
    const i = await body();
    const url0 = v.text(i.url, 'Link', { required: false, max: 500 });
    if (url0 && !/^https?:\/\//i.test(url0)) fail(400, 'Link deve começar com http:// ou https://');
    const f = {
      name: v.text(i.name, 'Nome', { max: 120 }), price_cents: i.price_cents ? v.cents(i.price_cents, 'Preço') : null,
      currency: v.currency(i.currency || 'EUR'), priority: v.oneOf(i.priority || 'media', 'Prioridade', ['alta', 'media', 'baixa']),
      url: url0, status: v.oneOf(i.status || 'desejo', 'Situação', ['desejo', 'comprado', 'descartado']),
      notes: v.text(i.notes, 'Notas', { required: false, max: 2000 }),
    };
    return i.id ? json(await update(db, 'fin_wishlist', v.id(i.id), i.version, f, 'desejo')) : json(await create(db, 'fin_wishlist', f, 'desejo'), 201);
  }

  // ───── operações de investimento (registro; nada é comprado automaticamente) ─────
  if (resource === 'investment-ops' && method === 'POST') {
    const i = await body();
    const inv = await getRow(db, 'fin_investments', v.id(i.investment_id, 'Investimento'));
    if (!inv) fail(404, 'Investimento não encontrado.');
    const f = {
      investment_id: inv.id, date: v.date(i.date, 'Data'),
      type: v.oneOf(i.type, 'Tipo de operação', ['compra', 'venda', 'aporte', 'resgate', 'rendimento', 'taxa']),
      quantity_micro: v.int(i.quantity_micro ?? 0, 'Quantidade', { max: 1e15 }), total_cents: v.cents(i.total_cents, 'Valor total'),
      notes: v.text(i.notes, 'Notas', { required: false, max: 1000 }),
    };
    return i.id ? json(await update(db, 'fin_investment_ops', v.id(i.id), i.version, f, 'operação')) : json(await create(db, 'fin_investment_ops', f, 'operação'), 201);
  }

  // ───── ações em lote e conciliação com comprovante ─────
  if (resource === 'transactions' && id === 'bulk' && method === 'POST') {
    const i = await body();
    const ids = Array.isArray(i.ids) ? i.ids.slice(0, 500).map(x => v.id(x)) : [];
    if (!ids.length) fail(400, 'Selecione ao menos um lançamento.');
    const op = v.oneOf(i.action, 'Ação', ['confirmar', 'pendente', 'excluir', 'categoria']);
    const category = op === 'categoria' ? v.text(i.category, 'Categoria', { max: 60 }) : null;
    const rows = await all(db, `SELECT * FROM fin_transactions WHERE deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
    if (op === 'confirmar') for (const t of rows) if (t.status === 'pendente') await guardReserve(db, await account(db, t.account_id), t.amount_cents, i);
    const at = nowIso(), stmts = [];
    for (const t of rows) {
      const after = op === 'excluir' ? null : { ...t, status: op === 'confirmar' ? 'confirmada' : op === 'pendente' ? 'pendente' : t.status, category: category || t.category };
      stmts.push(op === 'excluir'
        ? db.prepare('UPDATE fin_transactions SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').bind(at, at, t.id)
        : db.prepare('UPDATE fin_transactions SET status = ?, category = ?, updated_at = ?, version = version + 1 WHERE id = ?').bind(after.status, after.category, at, t.id),
      auditStmt(db, 'fin_audit', op === 'excluir' ? 'excluir' : 'editar', 'transação', t.id, t, after));
    }
    await db.batch([...stmts, bump(db)]);
    return json({ ok: true, changed: rows.length });
  }
  if (resource === 'transactions' && action === 'reconcile' && method === 'POST') {
    const t = await getRow(db, 'fin_transactions', v.id(id));
    if (!t || t.deleted_at) fail(404, 'Transação não encontrada.');
    const i = await body();
    const at = nowIso();
    await db.batch([db.prepare('UPDATE fin_transactions SET reconciled_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').bind(at, at, t.id),
      ...linkAttachments(db, i.attachment_ids, t.id), auditStmt(db, 'fin_audit', 'conciliar', 'transação', t.id, t, { ...t, reconciled_at: at }), bump(db)]);
    return json({ ok: true, reconciled_at: at });
  }

  // ───── importação de extrato CSV ─────
  if (resource === 'import' && id === 'csv' && method === 'POST') {
    const i = await readJson(request, 1_500_000);
    const acc = await account(db, i.account_id);
    const status = v.oneOf(i.status || 'pendente', 'Status', ['pendente', 'confirmada']);
    if (!Array.isArray(i.rows) || !i.rows.length || i.rows.length > 2000) fail(400, 'Envie entre 1 e 2000 linhas.');
    const rows = [];
    for (const r of i.rows) {
      const amount = v.cents(r.amount_cents, `Linha ${r.line}: valor`, { allowNegative: true });
      const date = v.date(r.date, `Linha ${r.line}: data`);
      const description = v.text(r.description, `Linha ${r.line}: descrição`);
      const hash = await sha256([acc.id, date, amount, description.toLowerCase()].join('|'));
      rows.push({ account_id: acc.id, kind: amount > 0 ? 'receita' : 'despesa', amount_cents: amount, currency: acc.currency, date, description,
        merchant: description.slice(0, 120), category: v.text(r.category || 'Outros', 'Categoria', { max: 60 }),
        status: r.pending ? 'pendente' : status, import_hash: hash, notes: 'Importado de extrato CSV' });
    }
    const existing = new Set();
    for (let k = 0; k < rows.length; k += 90) {
      const chunk = rows.slice(k, k + 90).map(r => r.import_hash);
      for (const r of await all(db, `SELECT import_hash FROM fin_transactions WHERE deleted_at IS NULL AND import_hash IN (${chunk.map(() => '?').join(',')})`, ...chunk)) existing.add(r.import_hash);
    }
    const seen = new Set();
    const fresh = rows.filter(r => !existing.has(r.import_hash) && !seen.has(r.import_hash) && seen.add(r.import_hash));
    for (let k = 0; k < fresh.length; k += 200) await createMany(db, 'fin_transactions', fresh.slice(k, k + 200), 'importação CSV');
    return json({ imported: fresh.length, skipped: rows.length - fresh.length }, 201);
  }

  // ───── exclusões simples ─────
  const SIMPLE_DELETE = { reserves: ['fin_reserves', 'reserva'], planned: ['fin_planned', 'planejada'], wishlist: ['fin_wishlist', 'desejo'], 'investment-ops': ['fin_investment_ops', 'operação'] };
  if (method === 'DELETE' && SIMPLE_DELETE[resource]) return json(await remove(db, SIMPLE_DELETE[resource][0], v.id(id), SIMPLE_DELETE[resource][1]));

  // ───── exportação e auditoria ─────
  if (resource === 'export.csv' && method === 'GET') {
    const data = await loadFinance(db);
    const names = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
    const csv = toCSV(data.transactions.slice().reverse(), [
      ['date', 'Data'], [r => names[r.account_id], 'Conta'], ['kind', 'Tipo'], ['description', 'Descrição'], ['merchant', 'Estabelecimento'],
      ['category', 'Categoria'], [r => (r.amount_cents / 100).toFixed(2).replace('.', ','), 'Valor'], ['currency', 'Moeda'], ['status', 'Status'],
      ['transfer_id', 'Transferência'], ['notes', 'Notas'], ['id', 'ID']]);
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="wall-finance-transacoes-${today()}.csv"` } });
  }
  if (resource === 'audit' && method === 'GET') {
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    return json(await all(db, "SELECT id, at, action, entity, entity_id, before_json, after_json FROM fin_audit UNION ALL SELECT id, at, action, 'wall os', entity_id, before_json, after_json FROM os_audit ORDER BY at DESC LIMIT ?", limit));
  }

  fail(404, 'Operação não encontrada.');
}

function addDaysIso(date, n) { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

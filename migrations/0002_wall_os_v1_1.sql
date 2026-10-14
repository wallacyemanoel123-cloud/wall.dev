-- WALL OS v1.1 — migração ADITIVA: nenhum dado existente é apagado.

-- ───── WALL Finance ─────
-- Conciliação e importação de extrato.
ALTER TABLE fin_transactions ADD COLUMN reconciled_at TEXT;
ALTER TABLE fin_transactions ADD COLUMN import_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_tx_import_hash ON fin_transactions(import_hash);

-- Contas fora do orçamento (ex.: espécie reservada para ônibus).
ALTER TABLE fin_accounts ADD COLUMN exclude_from_budget INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fin_accounts ADD COLUMN notes TEXT;

-- Reservas protegidas DENTRO de uma conta: separam parte do saldo sem criar despesa.
CREATE TABLE IF NOT EXISTS fin_reserves (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  target_cents INTEGER NOT NULL,
  allocated_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- Despesas/receitas planejadas (não entram no saldo até virarem lançamento).
CREATE TABLE IF NOT EXISTS fin_planned (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES fin_accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('receita','despesa')),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Outros',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'planejada' CHECK (status IN ('planejada','lancada','cancelada')),
  transaction_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fin_wishlist (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER,
  currency TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'media' CHECK (priority IN ('alta','media','baixa')),
  url TEXT,
  status TEXT NOT NULL DEFAULT 'desejo' CHECK (status IN ('desejo','comprado','descartado')),
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- Operações de investimento (registro manual; nenhuma compra é executada).
CREATE TABLE IF NOT EXISTS fin_investment_ops (
  id TEXT PRIMARY KEY,
  investment_id TEXT NOT NULL REFERENCES fin_investments(id),
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('compra','venda','aporte','resgate','rendimento','taxa')),
  quantity_micro INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_invops_inv ON fin_investment_ops(investment_id, date);

-- ───── WALL OS ─────
-- Recria os_items para aceitar novos módulos (hábitos, estudos) e arquivar/reordenar.
CREATE TABLE os_items_v2 (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL CHECK (module IN ('objetivo','plano','diario','checklist','evento','projeto','habito','estudo')),
  title TEXT NOT NULL,
  body TEXT,
  date TEXT,
  time TEXT,
  status TEXT NOT NULL DEFAULT 'aberto',
  done INTEGER NOT NULL DEFAULT 0,
  data_json TEXT,
  horizon TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
INSERT INTO os_items_v2 (id, module, title, body, date, time, status, done, data_json, created_at, updated_at, version, deleted_at)
  SELECT id, module, title, body, date, time, status, done, data_json, created_at, updated_at, version, deleted_at FROM os_items;
DROP TABLE os_items;
ALTER TABLE os_items_v2 RENAME TO os_items;
CREATE INDEX IF NOT EXISTS idx_os_module_date ON os_items(module, date);

-- Registros diários de hábitos (sono, hidratação, exercício…): um por hábito e dia.
CREATE TABLE IF NOT EXISTS os_habit_logs (
  id TEXT PRIMARY KEY,
  habit_id TEXT NOT NULL,
  date TEXT NOT NULL,
  value INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (habit_id, date)
);

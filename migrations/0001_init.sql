-- WALL Finance v1.0 — esquema inicial (Cloudflare D1 / SQLite)
-- Valores monetários SEMPRE em centavos inteiros (amount_cents), nunca em ponto flutuante.
-- Prefixos: auth_* (acesso), fin_* (WALL Finance, comercializável), os_* (WALL OS pessoal).

-- ───────────── Acesso ─────────────
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ───────────── WALL Finance ─────────────
CREATE TABLE IF NOT EXISTS fin_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  institution TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('EUR','BRL')),
  kind TEXT NOT NULL CHECK (kind IN ('banco','carteira_digital','especie','reserva','investimento','outro')),
  is_reserve INTEGER NOT NULL DEFAULT 0,
  reserve_target_cents INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- Fotografias de saldo: valor informado numa data, com fonte e status.
-- A âncora mais recente de cada conta é o ponto de partida do saldo calculado.
CREATE TABLE IF NOT EXISTS fin_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  amount_cents INTEGER NOT NULL,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('a_confirmar','confirmado')),
  is_anchor INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_account ON fin_snapshots(account_id, date);

-- Transações: amount_cents é COM SINAL (entrada positiva, saída negativa).
-- kind define a classificação: transferências e ajustes não contam como receita/despesa.
CREATE TABLE IF NOT EXISTS fin_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('receita','despesa','transferencia','ajuste')),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  merchant TEXT,
  category TEXT NOT NULL DEFAULT 'Outros',
  status TEXT NOT NULL CHECK (status IN ('confirmada','pendente')),
  transfer_id TEXT,
  recurring_id TEXT,
  shift_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON fin_transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_date ON fin_transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_transfer ON fin_transactions(transfer_id);

-- Anexos (recibos/screenshots) guardados no próprio D1 (limite de ~1,5 MB por arquivo).
CREATE TABLE IF NOT EXISTS fin_attachments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT REFERENCES fin_transactions(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data_b64 TEXT NOT NULL,
  extracted_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_tx ON fin_attachments(transaction_id);

CREATE TABLE IF NOT EXISTS fin_budgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  period TEXT NOT NULL CHECK (period IN ('diario','semanal','mensal')),
  limit_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fin_recurring (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('receita','despesa')),
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Outros',
  frequency TEXT NOT NULL CHECK (frequency IN ('semanal','mensal','anual')),
  next_date TEXT NOT NULL,
  is_fixed INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fin_delivery_shifts (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  platform TEXT NOT NULL,
  hours_x100 INTEGER NOT NULL DEFAULT 0,
  km_x10 INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  tips_cents INTEGER NOT NULL DEFAULT 0,
  costs_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  account_id TEXT REFERENCES fin_accounts(id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fin_goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('patrimonio','reserva','conta','manual')),
  target_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  due_date TEXT,
  account_id TEXT REFERENCES fin_accounts(id),
  saved_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fin_investments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  currency TEXT NOT NULL,
  invested_cents INTEGER NOT NULL,
  current_cents INTEGER,
  valued_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fin_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  origin TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON fin_audit(at);

-- Contador global de revisão: cada gravação incrementa; os aparelhos comparam para sincronizar.
CREATE TABLE IF NOT EXISTS sys_revision (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO sys_revision (id, value) VALUES (1, 1);

-- ───────────── WALL OS (independente do financeiro) ─────────────
CREATE TABLE IF NOT EXISTS os_items (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL CHECK (module IN ('objetivo','plano','diario','checklist','evento','projeto')),
  title TEXT NOT NULL,
  body TEXT,
  date TEXT,
  time TEXT,
  status TEXT NOT NULL DEFAULT 'aberto',
  done INTEGER NOT NULL DEFAULT 0,
  data_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_os_module_date ON os_items(module, date);

CREATE TABLE IF NOT EXISTS os_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT
);

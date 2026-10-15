-- WALL Brain (Wall Bot) — migração ADITIVA: memória, tarefas, eventos do Telegram e propostas
-- que exigem confirmação. Nenhuma tabela existente é alterada.

-- Tarefas rastreáveis. Concluir exige evidência; sem executor conectado a tarefa fica bloqueada.
CREATE TABLE IF NOT EXISTS brain_tasks (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT 'geral',
  agent TEXT NOT NULL DEFAULT 'wallacy',
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','ready','running','blocked','review','done','failed','cancelled')),
  scope TEXT,
  acceptance TEXT,
  evidence TEXT,
  blocked_reason TEXT,
  source TEXT NOT NULL DEFAULT 'painel',
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_brain_tasks_status ON brain_tasks(status);

-- Memória: fatos, decisões, hipóteses, pendências e evidências, com origem e validade.
CREATE TABLE IF NOT EXISTS brain_memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fato','decisao','hipotese','pendencia','evidencia')),
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  valid_until TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- Cada atualização do Telegram é gravada uma única vez (id = 'tg:<update_id>'): reenvio não repete ação.
CREATE TABLE IF NOT EXISTS brain_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  from_id TEXT,
  command TEXT,
  outcome TEXT NOT NULL
);

-- Ações com efeito (ex.: lançamento) nascem como proposta e só valem após /confirmar com o código
-- derivado do conteúdo exato. Proposta confirmada, cancelada ou vencida não pode ser reutilizada.
CREATE TABLE IF NOT EXISTS brain_proposals (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('despesa','receita')),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  from_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando','confirmada','cancelada','expirada')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  result_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

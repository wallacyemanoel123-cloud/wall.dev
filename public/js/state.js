// Estado da aplicação no navegador. O servidor (D1) é sempre a fonte da verdade.
import { api } from './api.js';
import { dashboard } from '../shared/finance.js';

export const S = { fin: null, os: [], habitLogs: [], dash: null, revision: 0, email: '', loadedAt: null };

export async function loadAll() {
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const [fin, os, habitLogs] = await Promise.all([api('fin/state'), api('os/items'), api('os/habit-logs?from=' + since)]);
  S.fin = fin; S.os = os; S.habitLogs = habitLogs; S.revision = fin.revision; S.loadedAt = new Date();
  S.dash = dashboard(fin, fin.today);
  return S;
}

export const accountName = id => S.fin.accounts.find(a => a.id === id)?.name || 'Conta removida';
export const accountById = id => S.fin.accounts.find(a => a.id === id);
export const activeAccounts = () => S.fin.accounts.filter(a => !a.archived);
export const accountOptions = () => activeAccounts().map(a => [a.id, `${a.name} (${a.currency})${a.is_reserve ? ' · reserva' : ''}`]);

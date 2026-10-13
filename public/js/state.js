// Estado da aplicação no navegador. O servidor (D1) é sempre a fonte da verdade.
import { api } from './api.js';
import { dashboard } from '../shared/finance.js';

export const S = { fin: null, os: [], dash: null, revision: 0, email: '', loadedAt: null };

export async function loadAll() {
  const [fin, os] = await Promise.all([api('fin/state'), api('os/items')]);
  S.fin = fin; S.os = os; S.revision = fin.revision; S.loadedAt = new Date();
  S.dash = dashboard(fin, fin.today);
  return S;
}

export const accountName = id => S.fin.accounts.find(a => a.id === id)?.name || 'Conta removida';
export const accountById = id => S.fin.accounts.find(a => a.id === id);
export const activeAccounts = () => S.fin.accounts.filter(a => !a.archived);
export const accountOptions = () => activeAccounts().map(a => [a.id, `${a.name} (${a.currency})${a.is_reserve ? ' · reserva' : ''}`]);

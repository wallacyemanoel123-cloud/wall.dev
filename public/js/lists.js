// Reordenar itens de listas (mover para cima/baixo) e gravar a nova ordem no servidor.
import { post } from './api.js';

export async function reorderList(table, list, index, delta, refresh) {
  const ids = list.map(x => x.id);
  const j = index + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[index], ids[j]] = [ids[j], ids[index]];
  await post('reorder', { table, ids });
  await refresh();
}

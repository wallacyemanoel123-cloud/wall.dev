// Utilidades de interface: escape de HTML, formulários em diálogo, avisos e ícones.
import { parseAmount, formatMoney } from '../shared/money.js';
import { ApiError } from './api.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (c, cur, opts) => esc(formatMoney(c, cur, opts));
export const centsToInput = c => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));
export const fmtDate = s => (s ? new Date(s.length === 10 ? s + 'T12:00:00Z' : s).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
export const fmtDateTime = s => (s ? new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const monthLabel = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;

const P = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h.01',
  pie: 'M21 12A9 9 0 1 1 12 3v9z M14 3.2A9 9 0 0 1 20.8 10H14z',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  bike: 'M5 17a3 3 0 1 0 0-.01M19 17a3 3 0 1 0 0-.01M5 17l4-8h6l4 8M9 9l-1-3H6M15 9l2-4h2',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
  check: 'M4 12l5 5L20 6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  book: 'M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM18 20h2V6',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  flag: 'M5 21V4h11l-2 4 2 4H5',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  scale: 'M12 3v18M5 7h14M5 7l-3 7h6zM19 7l-3 7h6z',
  camera: 'M4 7h4l2-3h4l2 3h4v13H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  close: 'M6 6l12 12M18 6L6 18',
};
export const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name] || P.more}"/></svg>`;

let toastTimer;
export function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message; el.className = 'toast ' + kind; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3000);
}

export const isDialogOpen = () => document.getElementById('dialog').open;

function fieldHtml(f) {
  const id = 'f_' + f.name;
  const req = f.required ? ' required' : '';
  const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
  const cls = f.full || f.type === 'textarea' || f.type === 'info' ? ' class="full"' : '';
  if (f.type === 'info') return `<div class="full banner${f.kind ? ' ' + f.kind : ''}">${f.html}</div>`;
  if (f.type === 'checkbox') return `<label class="check${f.full ? ' full' : ''}"><input type="checkbox" id="${id}" name="${f.name}"${f.value ? ' checked' : ''}> ${esc(f.label)}</label>`;
  let input;
  if (f.type === 'select') {
    input = `<select id="${id}" name="${f.name}"${req}>${f.options.map(o => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}"${String(val) === String(f.value ?? '') ? ' selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.name}" maxlength="${f.max || 2000}"${req}>${esc(f.value)}</textarea>`;
  } else if (f.type === 'money') {
    input = `<input id="${id}" name="${f.name}" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(centsToInput(f.value))}"${req}>`;
  } else {
    const type = f.type === 'decimal' ? 'text' : f.type || 'text';
    input = `<input id="${id}" name="${f.name}" type="${type}"${f.type === 'decimal' ? ' inputmode="decimal"' : ''} value="${esc(f.value)}"${f.max ? ` maxlength="${f.max}"` : ''}${f.list ? ` list="${id}_l"` : ''}${req}>`;
    if (f.list) input += `<datalist id="${id}_l">${f.list.map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
  }
  return `<label${cls}>${esc(f.label)}${input}${hint}</label>`;
}

function readValues(form, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'info') continue;
    const el = form.elements[f.name];
    if (f.type === 'checkbox') { out[f.name] = el.checked; continue; }
    const raw = el.value.trim();
    if (f.type === 'money') {
      if (!raw) { if (f.required) throw new Error(`${f.label}: informe o valor.`); out[f.name] = null; continue; }
      const c = parseAmount(raw);
      if (c === null) throw new Error(`${f.label}: valor inválido. Use, por exemplo, 2.345,67.`);
      out[f.name] = c;
    } else {
      if (!raw && f.required) throw new Error(`${f.label}: campo obrigatório.`);
      out[f.name] = raw;
    }
  }
  return out;
}

// Abre um formulário. onSubmit recebe os valores; se lançar erro, ele aparece no formulário.
export function openForm({ title, fields, submitLabel = 'Salvar', onSubmit, extra = [], intro = '' }) {
  const dlg = document.getElementById('dialog');
  dlg.innerHTML = `<form class="modal" method="dialog" novalidate>
    <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="ghost small" data-close aria-label="Fechar">${icon('close')}</button></div>
    <div class="modal-body">${intro}<div class="form-grid">${fields.map(fieldHtml).join('')}</div><p class="form-error" role="alert"></p></div>
    <div class="modal-foot">${extra.map((b, i) => `<button type="button" class="${b.danger ? 'danger' : ''}" data-extra="${i}">${esc(b.label)}</button>`).join('')}<span class="spacer"></span>
      <button type="button" data-close>Cancelar</button><button type="submit" class="primary">${esc(submitLabel)}</button></div></form>`;
  const form = dlg.querySelector('form'), err = dlg.querySelector('.form-error');
  dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));
  extra.forEach((b, i) => dlg.querySelector(`[data-extra="${i}"]`).addEventListener('click', async () => {
    try { await b.onClick(dlg); } catch (e) { err.textContent = e.message; }
  }));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button[type="submit"]');
    try {
      const values = readValues(form, fields);
      btn.disabled = true;
      // onSubmit pode devolver false para manter o diálogo aberto (ex.: mostrar um resultado).
      if (await onSubmit(values, dlg) !== false && dlg.open) dlg.close();
    } catch (e) {
      err.textContent = e.message;
    } finally { btn.disabled = false; }
  });
  dlg.showModal();
  const first = form.querySelector('input:not([type="checkbox"]), select, textarea');
  if (first && matchMedia('(min-width: 561px)').matches) first.focus();
  return dlg;
}

export function confirmDialog(title, message, { confirmLabel = 'Confirmar', danger = false } = {}) {
  return new Promise(resolve => {
    // Diálogo separado, para poder confirmar por cima de um formulário aberto.
    const second = document.createElement('dialog');
    document.body.appendChild(second);
    second.innerHTML = `<form class="modal" method="dialog"><div class="modal-head"><h2>${esc(title)}</h2></div><div class="modal-body"><p>${esc(message)}</p></div>
      <div class="modal-foot"><span class="spacer"></span><button value="no">Cancelar</button><button value="yes" class="${danger ? 'danger' : 'primary'}">${esc(confirmLabel)}</button></div></form>`;
    second.addEventListener('close', () => { resolve(second.returnValue === 'yes'); second.remove(); });
    second.showModal();
  });
}

// Executa uma gravação; se o servidor pedir confirmação de saída da reserva, pergunta e repete.
export async function withReserveConfirm(fn) {
  try { return await fn(false); } catch (e) {
    if (e instanceof ApiError && e.status === 428 && e.data.code === 'reserva') {
      if (await confirmDialog('Reserva protegida', e.message, { confirmLabel: 'Sim, retirar da reserva', danger: true })) return fn(true);
      throw new Error('Operação cancelada: a reserva não foi alterada.');
    }
    throw e;
  }
}

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

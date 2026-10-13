// Gráficos em SVG puro (sem bibliotecas externas, compatível com a CSP).
import { esc } from './ui.js';
import { formatMoney } from '../shared/money.js';

const compact = (c, cur) => {
  const v = Math.abs(c) / 100;
  const s = v >= 1000 ? (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil' : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  return (cur === 'BRL' ? 'R$ ' : '€ ') + s;
};

// Barras agrupadas: labels[i] com séries [{name, cls, values[]}].
export function groupedBars(labels, series, currency, { height = 220 } = {}) {
  const W = 640, H = height, pad = { l: 56, r: 8, t: 10, b: 28 };
  const max = Math.max(1, ...series.flatMap(s => s.values));
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const group = iw / Math.max(1, labels.length), bw = Math.min(28, (group - 10) / series.length);
  const ticks = [0, 0.5, 1].map(f => ({ y: pad.t + ih - ih * f, v: max * f }));
  let out = ticks.map(t => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${t.y}" y2="${t.y}"/><text x="${pad.l - 6}" y="${t.y + 4}" text-anchor="end">${esc(compact(t.v, currency))}</text>`).join('');
  labels.forEach((lab, i) => {
    const gx = pad.l + group * i + (group - bw * series.length) / 2;
    series.forEach((s, k) => {
      const v = s.values[i] || 0, h = ih * v / max;
      out += `<rect class="${s.cls}" x="${gx + k * bw}" y="${pad.t + ih - h}" width="${bw - 2}" height="${Math.max(0, h)}" rx="3"><title>${esc(s.name)} · ${esc(lab)}: ${esc(formatMoney(v, currency))}</title></rect>`;
    });
    out += `<text x="${pad.l + group * i + group / 2}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`;
  });
  const summary = series.map(s => `${s.name}: ${s.values.map((v, i) => `${labels[i]} ${formatMoney(v, currency)}`).join(', ')}`).join('. ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(summary)}">${out}</svg>
    <div class="legend">${series.map(s => `<span><i class="${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}

// Barras horizontais com <progress> (categorias).
export function categoryBars(items, currency) {
  if (!items.length) return '<p class="muted small">Sem despesas confirmadas no período.</p>';
  const max = Math.max(...items.map(i => i.amount));
  return `<div class="bars-h">${items.map(i => `<div class="item"><span>${esc(i.name)}</span><span class="money">${esc(formatMoney(i.amount, currency))}</span>
    <progress max="${max}" value="${i.amount}" aria-label="${esc(i.name)}"></progress></div>`).join('')}</div>`;
}

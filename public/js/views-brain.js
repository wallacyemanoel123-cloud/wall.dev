// Cérebro WALL (Wall Bot): tarefas rastreáveis, memória, propostas do Telegram e estado real dos executores.
import { api, post, del } from './api.js';
import { esc, fmtDateTime, openForm, confirmDialog, toast } from './ui.js';
import { formatMoney } from '../shared/money.js';

const STATUS_LABEL = { backlog: 'Backlog', ready: 'Pronta', running: 'Em execução', blocked: 'Bloqueada', review: 'Em revisão', done: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada' };
const AGENT_LABEL = { wallacy: 'Wallacy', claude_code: 'Claude Code', codex: 'Codex', criativos: 'Criativos' };
const KIND_LABEL = { fato: 'Fato confirmado', decisao: 'Decisão', hipotese: 'Hipótese', pendencia: 'Pendência', evidencia: 'Evidência' };
const PROPOSAL_LABEL = { aguardando: 'Aguardando /confirmar', confirmada: 'Gravada como pendente', cancelada: 'Cancelada', expirada: 'Vencida' };
const empty = t => `<div class="empty"><p>${esc(t)}</p></div>`;

export async function cerebro(host, { refresh }) {
  host.innerHTML = '<p class="muted">Carregando o cérebro…</p>';
  const st = await api('brain/state');
  const open = st.tasks.filter(t => !['done', 'cancelled'].includes(t.status));
  const closed = st.tasks.filter(t => ['done', 'cancelled'].includes(t.status)).slice(0, 15);
  const waiting = st.proposals.filter(p => p.status === 'aguardando' && p.expires_at > new Date().toISOString());
  const taskRow = t => `<div class="row"><div class="grow"><div class="title"><span class="tag">${esc(t.code)}</span> ${esc(t.title)}
      <span class="tag${t.status === 'blocked' || t.status === 'failed' ? ' warn' : t.status === 'done' ? ' ok' : ''}">${esc(STATUS_LABEL[t.status])}</span></div>
      <div class="meta">#${esc(t.project)} · ${esc(AGENT_LABEL[t.agent] || t.agent)} · ${esc(t.source)} · ${fmtDateTime(t.updated_at)}${t.blocked_reason ? ` · ${esc(t.blocked_reason)}` : ''}${t.evidence ? ` · evidência: ${esc(t.evidence)}` : ''}</div></div>
      <button class="small" data-task="${esc(t.id)}">Editar</button></div>`;
  const memRow = m => `<div class="row"><div class="grow"><div class="title"><span class="tag">${esc(KIND_LABEL[m.kind])}</span> ${esc(m.text)}</div>
      <div class="meta">${esc(m.source)} · ${fmtDateTime(m.updated_at)}${m.valid_until ? ` · válido até ${esc(m.valid_until.split('-').reverse().join('/'))}` : ''}</div></div>
      <button class="small" data-mem="${esc(m.id)}">Editar</button></div>`;
  const propRow = p => { const x = JSON.parse(p.payload_json);
    return `<div class="row"><div class="grow"><div class="title">${esc(formatMoney(x.amount_cents, x.currency, { sign: true }))} — ${esc(x.description)} <span class="tag${p.status === 'aguardando' ? ' warn' : ''}">${esc(PROPOSAL_LABEL[p.status])}</span></div>
      <div class="meta">${esc(x.account_name)} · código ${esc(p.code)} · ${fmtDateTime(p.created_at)}</div></div>
      ${p.status === 'aguardando' ? `<button class="small" data-cancel-prop="${esc(p.id)}">Cancelar</button>` : ''}</div>`; };

  host.innerHTML = `
    <div class="page-head"><div><h1>Cérebro WALL</h1><p>Memória, tarefas e comando pelo Telegram. O cérebro registra e propõe; quem decide é você. Nenhum dinheiro é movimentado.</p></div>
      <div class="actions"><button data-new-mem>+ Memória</button><button class="primary" data-new-task>+ Tarefa</button></div></div>
    <div class="grid-2">
      <section class="card"><h2>Conexões reais</h2>
        <div class="list">
          <div class="row"><div class="grow"><div class="title">Telegram ${st.telegram.configured ? '<span class="tag ok">configurado no servidor</span>' : '<span class="tag warn">não configurado</span>'}</div>
            <div class="meta">${st.telegram.configured ? 'Webhook protegido por segredo; só o seu ID de usuário comanda.' : 'Falta criar o bot e cadastrar os segredos na Cloudflare. Veja “Como ligar o Telegram”.'}</div></div></div>
          <div class="row"><div class="grow"><div class="title">Executores cloud ${st.executors.length ? `<span class="tag ok">${esc(st.executors.map(a => AGENT_LABEL[a]).join(', '))}</span>` : '<span class="tag warn">nenhum conectado</span>'}</div>
            <div class="meta">Tarefas de Claude Code, Codex ou criativos ficam bloqueadas até existir um executor testado. Nada é marcado como feito sem evidência.</div></div></div>
        </div>
        <details><summary>Como ligar o Telegram (custo €0)</summary><ol class="small">
          <li>No Telegram, fale com @BotFather → /newbot. Guarde o token só com você (nunca no chat, no GitHub ou no código).</li>
          <li>Descubra seu ID numérico de usuário (ex.: @userinfobot).</li>
          <li>No painel da Cloudflare → Pages → wall-finance → Configurações → Variáveis: cadastre como <b>secretos</b> TELEGRAM_WEBHOOK_SECRET (uma senha longa aleatória) e TELEGRAM_OWNER_ID (seu ID). Faça um novo deploy.</li>
          <li>No navegador do seu celular, registre o webhook uma vez: api.telegram.org/bot&lt;TOKEN&gt;/setWebhook com url = https://SEU-ENDERECO/api/telegram/webhook e secret_token = o mesmo segredo.</li>
          <li>Envie /status ao bot. A resposta vem do servidor na nuvem: funciona com o notebook fechado.</li></ol></details>
      </section>
      <section class="card"><div class="card-head"><h2>Propostas do Telegram</h2><span class="muted small">${waiting.length} aguardando</span></div>
        <div class="list">${st.proposals.slice(0, 8).map(propRow).join('') || empty('Nenhuma proposta. Pelo Telegram: /despesa 12,50 Mercado.')}</div></section>
    </div>
    <section class="card"><div class="card-head"><h2>Tarefas abertas</h2><span class="muted small">${open.length}</span></div>
      <div class="list" id="brain-tasks">${open.map(taskRow).join('') || empty('Nenhuma tarefa aberta.')}</div>
      ${closed.length ? `<details><summary>Concluídas e canceladas (${closed.length})</summary><div class="list">${closed.map(taskRow).join('')}</div></details>` : ''}</section>
    <section class="card"><div class="card-head"><h2>Memória</h2><span class="muted small">fatos, decisões, hipóteses, pendências e evidências</span></div>
      <div class="list" id="brain-memory">${st.memory.map(memRow).join('') || empty('Memória vazia. Use “+ Memória” ou /nota no Telegram.')}</div></section>
    <section class="card"><h2>Últimos eventos do Telegram</h2>
      <div class="list">${st.events.map(e => `<div class="row"><div class="grow"><div class="title">${esc(e.command ? '/' + e.command : '—')} · ${esc(e.outcome)}</div><div class="meta">${fmtDateTime(e.received_at)}</div></div></div>`).join('') || empty('Nenhum evento recebido.')}</div></section>`;

  const reload = async () => { await refresh(); };
  host.querySelector('[data-new-task]').onclick = () => taskForm(null, st, reload);
  host.querySelector('[data-new-mem]').onclick = () => memoryForm(null, reload);
  host.querySelectorAll('[data-task]').forEach(b => { b.onclick = () => taskForm(st.tasks.find(t => t.id === b.dataset.task), st, reload); });
  host.querySelectorAll('[data-mem]').forEach(b => { b.onclick = () => memoryForm(st.memory.find(m => m.id === b.dataset.mem), reload); });
  host.querySelectorAll('[data-cancel-prop]').forEach(b => { b.onclick = async () => {
    if (!await confirmDialog('Cancelar proposta', 'A proposta deixa de valer e o código de confirmação não funcionará mais.')) return;
    try { await post(`brain/proposals/${b.dataset.cancelProp}/cancel`); toast('Proposta cancelada.'); await reload(); } catch (e) { toast(e.message, 'error'); }
  }; });
}

function taskForm(t, st, reload) {
  openForm({
    title: t ? `Tarefa ${t.code}` : 'Nova tarefa',
    fields: [
      { name: 'title', label: 'O que precisa ser feito', required: true, value: t?.title, full: true },
      { name: 'project', label: 'Projeto', value: t?.project || 'geral', hint: 'Ex.: ofertas, finance, wallbot' },
      { name: 'agent', label: 'Responsável', type: 'select', options: st.agents.map(a => [a, AGENT_LABEL[a]]), value: t?.agent || 'wallacy' },
      { name: 'status', label: 'Estado', type: 'select', options: st.statuses.map(s => [s, STATUS_LABEL[s]]), value: t?.status || 'backlog' },
      { name: 'scope', label: 'Escopo autorizado', type: 'textarea', value: t?.scope },
      { name: 'acceptance', label: 'Critério de aceite', type: 'textarea', value: t?.acceptance },
      { name: 'evidence', label: 'Evidência (obrigatória para concluir)', type: 'textarea', value: t?.evidence, hint: 'Link, commit, arquivo ou resultado verificável.' },
      { name: 'blocked_reason', label: 'Motivo do bloqueio', value: t?.blocked_reason, full: true },
    ],
    onSubmit: async val => {
      const r = await post('brain/tasks', { ...val, id: t?.id, version: t?.version });
      toast(r.status === 'blocked' && val.status !== 'blocked' ? `Salva como bloqueada: ${r.blocked_reason}` : 'Tarefa salva.');
      await reload();
    },
  });
}

function memoryForm(m, reload) {
  openForm({
    title: m ? 'Editar memória' : 'Nova memória',
    fields: [
      { name: 'kind', label: 'Tipo', type: 'select', options: Object.entries(KIND_LABEL), value: m?.kind || 'fato' },
      { name: 'valid_until', label: 'Válido até', type: 'date', value: m?.valid_until || '' },
      { name: 'text', label: 'Conteúdo', type: 'textarea', required: true, value: m?.text },
      { name: 'source', label: 'Origem', value: m?.source || 'Painel', full: true, hint: 'De onde veio a informação (conversa, print, documento…).' },
    ],
    extra: m ? [{ label: 'Apagar', danger: true, onClick: async dlg => {
      if (!await confirmDialog('Apagar memória', 'A exclusão fica registrada na auditoria.', { danger: true, confirmLabel: 'Apagar' })) return;
      await del('brain/memory/' + m.id); dlg.close(); toast('Memória apagada.'); await reload();
    } }] : [],
    onSubmit: async val => { await post('brain/memory', { ...val, id: m?.id, version: m?.version }); toast('Memória salva.'); await reload(); },
  });
}

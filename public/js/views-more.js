// Assistente financeiro e Dados & segurança (backup, restauração, importações, sessões, auditoria).
import { api, post } from './api.js';
import { S } from './state.js';
import { esc, fmtDateTime, openForm, confirmDialog, toast, download } from './ui.js';
import { parseAmount } from '../shared/money.js';

export async function assistente(host) {
  host.innerHTML = '<p class="muted">Analisando seus registros…</p>';
  const [status, report] = await Promise.all([api('assistant/status'), api('assistant/insights')]);
  const item = i => `<div class="insight"><span class="dot ${esc(i.tipo)}"></span><p>${esc(i.texto)}</p></div>`;
  host.innerHTML = `
    <div class="page-head"><div><h1>Assistente financeiro</h1><p>${esc(report.fonte)}. ${status.aiEnabled ? `IA externa ligada (${esc(status.model)}).` : status.aiConfigured ? 'IA externa configurada, mas desligada em Dados e segurança.' : 'IA externa não configurada: é opcional e pode ter custo.'}</p></div></div>
    <section class="card"><div class="card-head"><h2>Análise de hoje</h2><span class="muted small">${fmtDateTime(report.gerado_em)}</span></div>${report.itens.map(item).join('')}</section>
    <section class="card"><h2>Pergunte</h2>
      <form id="ask" class="chat"><div id="chat-log" class="chat"></div>
        <label>Sua pergunta<textarea name="q" maxlength="2000" placeholder="Ex.: Quanto preciso guardar por mês para a meta de patrimônio?"></textarea></label>
        <div class="actions"><button class="primary">Perguntar</button></div>
        <p class="hint">O assistente só sugere. Nenhuma movimentação é feita sem você registrar.${status.aiEnabled ? ' Somente totais e metas (sem anexos ou notas) são enviados à IA.' : ''}</p></form></section>`;
  host.querySelector('#ask').addEventListener('submit', async e => {
    e.preventDefault();
    const q = e.target.q.value.trim(), log = host.querySelector('#chat-log'), btn = e.target.querySelector('button');
    if (!q) return;
    log.insertAdjacentHTML('beforeend', `<div class="bubble me">${esc(q)}</div>`);
    e.target.q.value = ''; btn.disabled = true;
    try {
      const r = await post('assistant/ask', { question: q });
      log.insertAdjacentHTML('beforeend', `<div class="bubble">${r.resposta ? esc(r.resposta) : `${esc(r.aviso)}\n\n${r.analise.map(i => '• ' + esc(i.texto)).join('\n')}`}</div>`);
    } catch (err) { log.insertAdjacentHTML('beforeend', `<div class="bubble">${esc(err.message)}</div>`); }
    finally { btn.disabled = false; }
  });
}

const readFile = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('Falha ao ler o arquivo.')); r.readAsText(file); });

// Configuração inicial a partir de um JSON colado (contas + saldos de referência + metas).
async function applySetup(json) {
  let cfg;
  try { cfg = JSON.parse(json); } catch { throw new Error('JSON inválido.'); }
  const kinds = { banco: 'banco', carteira: 'carteira_digital', carteira_digital: 'carteira_digital', especie: 'especie', reserva: 'reserva', investimento: 'investimento' };
  const amount = (v, label) => { const c = parseAmount(v); if (c === null) throw new Error(`${label}: valor inválido (${v}).`); return c; };
  let n = 0;
  for (const c of cfg.contas || []) {
    const acc = await post('fin/accounts', { name: c.nome, institution: c.instituicao, currency: c.moeda, kind: kinds[c.tipo] || 'outro', is_reserve: c.reserva === true,
      reserve_target_cents: c.meta_reserva ? amount(c.meta_reserva, c.nome) : null });
    if (c.saldo !== undefined && c.saldo !== null) await post('fin/snapshots', { account_id: acc.id, amount_cents: amount(c.saldo, c.nome), date: c.data, source: c.fonte || 'Informado pelo titular', status: c.status || 'a_confirmar', is_anchor: true, note: c.observacao });
    n++;
  }
  for (const g of cfg.metas || []) { await post('fin/goals', { name: g.nome, kind: g.tipo || 'manual', target_cents: amount(g.valor, g.nome), currency: g.moeda, due_date: g.prazo || null }); n++; }
  return n;
}

export async function dados(host, { refresh }) {
  const [sessions, audit, status] = await Promise.all([api('auth/sessions'), api('fin/audit?limit=60'), api('assistant/status')]);
  const s = S.fin.settings;
  host.innerHTML = `
    <div class="page-head"><div><h1>Dados e segurança</h1><p>Conectado como ${esc(S.email || 'titular')}. Os dados ficam no seu banco Cloudflare D1, acessível só com login.</p></div>
      <div class="actions"><button data-act="logout">Sair</button></div></div>
    <div class="grid-2">
      <section class="card"><h2>Exportar e fazer backup</h2>
        <p class="muted small">Faça um backup completo ao menos uma vez por semana e guarde fora do celular (ex.: seu Drive pessoal). Arquivos de backup <b>nunca</b> devem ir para o GitHub.</p>
        <div class="actions"><a class="btn" href="/api/fin/export.csv" download>Transações (CSV)</a><a class="btn" href="/api/backup" download>Backup (sem anexos)</a><a class="btn primary" href="/api/backup?anexos=1" download>Backup completo</a></div></section>
      <section class="card"><h2>Restaurar backup</h2>
        <p class="muted small">Substitui <b>todos</b> os dados atuais pelos do arquivo. Baixe um backup do estado atual antes.</p>
        <label class="btn file-btn"><span data-file-label="restore-file">Escolher arquivo de backup (.json)</span><input type="file" id="restore-file" class="visually-hidden" accept="application/json,.json"></label>
        <div class="actions"><button data-act="restore" class="danger">Restaurar…</button></div></section>
      <section class="card"><h2>Configuração inicial</h2>
        <p class="muted small">Cole o JSON de contas, saldos de referência e metas (formato no manual). Cria registros novos; não apaga nada.</p>
        <textarea id="setup-json" placeholder='{"contas":[{"nome":"…","moeda":"EUR","tipo":"carteira","saldo":"0,00","data":"2026-10-13","fonte":"…","status":"a_confirmar"}],"metas":[]}'></textarea>
        <div class="actions"><button data-act="setup">Aplicar configuração</button></div></section>
      <section class="card"><h2>Importar do piloto</h2>
        <p class="muted small">Use o arquivo <code>wall-backup.json</code> exportado no piloto (wall-finance-pilot). Lançamentos, metas, diário, checklist, calendário e planos são copiados. Nada é apagado. ${s.pilot_import_at ? `<b>Já importado em ${fmtDateTime(s.pilot_import_at)}.</b>` : ''}</p>
        <label class="btn file-btn"><span data-file-label="pilot-file">Escolher arquivo do piloto (.json)</span><input type="file" id="pilot-file" class="visually-hidden" accept="application/json,.json"></label>
        <div class="actions"><button data-act="pilot">Importar</button></div></section>
      <section class="card"><h2>Assistente com IA (opcional)</h2>
        ${status.aiConfigured ? `<label class="check"><input type="checkbox" id="ai-toggle"${s.ai_enabled === '1' ? ' checked' : ''}> Usar IA externa nas perguntas do assistente</label><p class="hint">Pode gerar custo na sua conta do provedor. Só totais e metas são enviados.</p>`
          : '<p class="muted small">Não configurada. Para ligar no futuro, crie uma chave de API e grave-a como segredo <code>ANTHROPIC_API_KEY</code> na Cloudflare (nunca no código). Sem chave, o assistente usa só regras locais e não tem custo.</p>'}</section>
      <section class="card"><h2>Aparelhos conectados</h2>
        <div class="list">${sessions.map(x => `<div class="row"><div class="grow"><div class="title small">${esc((x.user_agent || 'Aparelho').slice(0, 80))}</div><div class="meta">Entrou em ${fmtDateTime(x.created_at)} · expira ${fmtDateTime(new Date(x.expires_at).toISOString())}</div></div></div>`).join('')}</div>
        <div class="actions"><button class="danger" data-act="logout-all">Sair de todos os aparelhos</button></div></section>
      <section class="card"><h2>Instalar no celular</h2>
        <p class="small"><b>iPhone:</b> abra o endereço no Safari → Compartilhar → Adicionar à Tela de Início.<br><b>Android:</b> Chrome → menu ⋮ → Instalar app.<br><b>Notebook:</b> Chrome/Edge → ícone de instalar na barra de endereço.</p>
        <p class="hint">Os dados ficam no servidor: o mesmo login mostra as mesmas informações em todos os aparelhos.</p></section>
    </div>
    <section class="card"><h2>Histórico de auditoria</h2><p class="muted small">Últimas 60 alterações. O backup completo inclui o histórico inteiro.</p>
      <div class="table-wrap"><table><thead><tr><th>Quando</th><th>Ação</th><th>Registro</th><th>Detalhe</th></tr></thead><tbody>
      ${audit.map(a => { let after = {}; try { after = JSON.parse(a.after_json || a.before_json || '{}') || {}; } catch { /* registro sem JSON */ } return `<tr><td>${fmtDateTime(a.at)}</td><td>${esc(a.action)}</td><td>${esc(a.entity)}</td><td class="small">${esc(after.description || after.name || after.title || after.source || '')}</td></tr>`; }).join('')}</tbody></table></div></section>`;

  const act = (name, fn) => host.querySelector(`[data-act="${name}"]`).addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    try { await fn(); } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
  });
  act('logout', async () => { await post('auth/logout'); location.reload(); });
  act('logout-all', async () => { if (await confirmDialog('Sair de todos os aparelhos', 'Todos os aparelhos, incluindo este, precisarão entrar de novo.', { danger: true, confirmLabel: 'Sair de todos' })) { await post('auth/logout?all=1'); location.reload(); } });
  act('setup', async () => {
    const json = host.querySelector('#setup-json').value.trim();
    if (!json) throw new Error('Cole o JSON de configuração.');
    if (!await confirmDialog('Aplicar configuração', 'Criar as contas, saldos de referência e metas descritos? Nenhum lançamento será criado.')) return;
    const n = await applySetup(json); toast(`${n} registro(s) criados.`); await refresh();
  });
  act('pilot', async () => {
    const file = host.querySelector('#pilot-file').files[0];
    if (!file) throw new Error('Escolha o arquivo do piloto.');
    const data = JSON.parse(await readFile(file));
    const r = await post('import/pilot', { data, force: Boolean(s.pilot_import_at) && await confirmDialog('Importar de novo?', 'O piloto já foi importado. Importar novamente pode duplicar registros.', { danger: true, confirmLabel: 'Importar mesmo assim' }) });
    toast(`Importado: ${Object.entries(r.report).map(([k, v]) => `${v} ${k}`).join(', ')}.`); await refresh();
  });
  act('restore', async () => {
    const file = host.querySelector('#restore-file').files[0];
    if (!file) throw new Error('Escolha o arquivo de backup.');
    const backup = JSON.parse(await readFile(file));
    openForm({
      title: 'Restaurar backup', submitLabel: 'Restaurar agora',
      intro: `<div class="banner error">Todos os dados atuais serão substituídos pelo backup de ${esc(fmtDateTime(backup.exported_at))}. Esta ação não pode ser desfeita sem outro backup.</div>`,
      fields: [{ name: 'confirm', label: 'Digite RESTAURAR para confirmar', required: true, full: true }],
      onSubmit: async v => { await post('restore', { backup, confirm: v.confirm }); toast('Backup restaurado.'); await refresh(); },
    });
  });
  // Mostra o nome do arquivo escolhido (o botão nativo não é traduzido em todos os navegadores).
  host.querySelectorAll('input[type="file"]').forEach(inp => inp.addEventListener('change', () => { const l = host.querySelector(`[data-file-label="${inp.id}"]`); if (l && inp.files[0]) l.textContent = inp.files[0].name; }));
  host.querySelector('#ai-toggle')?.addEventListener('change', async e => { await post('fin/settings', { ai_enabled: e.target.checked }); toast(e.target.checked ? 'IA externa ligada.' : 'IA externa desligada.'); await refresh(); });
}

export { download };

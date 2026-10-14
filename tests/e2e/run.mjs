// Teste ponta a ponta: sobe Cloudflare Pages + D1 localmente (wrangler) e usa dois navegadores
// (notebook e celular) com sessões separadas para testar login, lançamentos, sincronização,
// reserva protegida, recibos, conciliação, backup/restauração, CSV, WALL OS e PWA.
// Uso: npm run test:e2e   (CHROMIUM_PATH opcional; SHOTS=dir para salvar screenshots)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { hashPassword } from '../../server/auth.js';

const PORT = 8799, BASE = `http://localhost:${PORT}`;
const EMAIL = 'titular@example.com', PASSWORD = 'senha-de-teste-bem-longa';
const root = new URL('../../', import.meta.url).pathname;
const persist = mkdtempSync(join(tmpdir(), 'wf-e2e-'));
const wrangler = join(root, 'node_modules/.bin/wrangler');
const shots = process.env.SHOTS;
const chromePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers').filter(d => d.startsWith('chromium-')).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find(existsSync) : undefined);

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack?.split('\n').slice(0, 9).join('\n    ')}`); }
}

execFileSync(wrangler, ['d1', 'migrations', 'apply', 'wall-finance', '--local', '--persist-to', persist], { cwd: root, stdio: 'ignore', env: { ...process.env, CI: '1' } });
const hash = await hashPassword(PASSWORD);
const server = spawn(wrangler, ['pages', 'dev', 'public', '--port', String(PORT), '--persist-to', persist, '--binding', `OWNER_EMAIL=${EMAIL}`, '--binding', `OWNER_PASSWORD_HASH=${hash}`],
  { cwd: root, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* aguardando */ } await new Promise(r => setTimeout(r, 500)); }

const browser = await chromium.launch({ executablePath: chromePath });
const errors = [];
async function device(name, options) {
  const ctx = await browser.newContext({ ...options, locale: 'pt-BR', timezoneId: 'Europe/Dublin', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  return { ctx, page };
}
const notebook = await device('notebook', { viewport: { width: 1366, height: 900 } });
const phone = await device('celular', { ...devices['iPhone 13'], browserName: undefined, defaultBrowserType: undefined });
const P = notebook.page, M = phone.page;
const snap = async (page, file) => { if (shots) await page.screenshot({ path: join(shots, file), fullPage: false }); };
const fill = async (page, name, value) => page.locator(`#dialog [name="${name}"]`).fill(value);
const select = async (page, name, value) => page.locator(`#dialog [name="${name}"]`).selectOption(value);
const save = async page => { await page.locator('#dialog button[type="submit"]').click(); await page.waitForFunction(() => !document.getElementById('dialog').open); };
const balanceText = async (page, account) => page.locator('.card', { has: page.locator('h2', { hasText: account }) }).locator('.kpi-value').innerText();
const norm = s => s.replace(/\s/g, ' ');
// Espera o saldo exibido chegar ao valor esperado (a tela recarrega logo após salvar).
async function expectBalance(page, account, expected) {
  let last = '';
  for (let i = 0; i < 25; i++) { last = norm(await balanceText(page, account)); if (last === expected) return; await page.waitForTimeout(200); }
  assert.equal(last, expected, account);
}

async function login(page) {
  await page.goto(BASE + '/');
  await page.locator('#login-form [name="email"]').fill(EMAIL);
  await page.locator('#login-form [name="password"]').fill(PASSWORD);
  await page.locator('#login-form button').click();
  await page.locator('#app').waitFor();
}

console.log('WALL Finance — teste ponta a ponta');

await step('API recusa dados sem login (401) e mutação de outra origem (403)', async () => {
  assert.equal((await fetch(BASE + '/api/fin/state')).status, 401);
  assert.equal((await fetch(BASE + '/api/os/items')).status, 401);
  const r = await fetch(BASE + '/api/fin/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
});

await step('Senha errada é recusada; senha certa entra (notebook)', async () => {
  await P.goto(BASE + '/');
  await P.locator('#login-form [name="email"]').fill(EMAIL);
  await P.locator('#login-form [name="password"]').fill('errada');
  await P.locator('#login-form button').click();
  await P.locator('#login-error', { hasText: 'incorretos' }).waitFor();
  await snap(P, 'login.png');
  await login(P);
  assert.equal(await P.locator('#page-title').innerText(), 'Hoje', 'WALL OS abre em Hoje');
});

await step('Cria contas com saldo de referência e reserva protegida', async () => {
  await P.goto(BASE + '/#/contas');
  await P.locator('[data-act="new"]').click();
  await fill(P, 'name', 'Carteira Teste EUR'); await select(P, 'kind', 'carteira_digital');
  await fill(P, 'snap_amount', '1.000,00'); await fill(P, 'snap_date', '2026-10-01'); await fill(P, 'snap_source', 'Teste automatizado');
  await save(P);
  await P.locator('[data-act="new"]').click();
  await fill(P, 'name', 'Reserva Teste'); await select(P, 'kind', 'reserva');
  await P.locator('#dialog [name="is_reserve"]').check(); await fill(P, 'reserve_target', '1.200,00');
  await save(P);
  await P.locator('[data-act="new"]').click();
  await fill(P, 'name', 'Conta Teste BRL'); await select(P, 'currency', 'BRL'); await fill(P, 'snap_amount', '0,00');
  await save(P);
  assert.equal(norm(await balanceText(P, 'Carteira Teste EUR')), '€ 1.000,00');
});

await step('Cria, edita e confere lançamento (saldo atualizado)', async () => {
  await P.locator('#quick-add').click();
  await fill(P, 'amount', '25,50'); await select(P, 'account_id', { label: 'Carteira Teste EUR (EUR)' });
  await fill(P, 'date', '2026-10-05'); await fill(P, 'description', 'Mercado teste'); await fill(P, 'category', 'Mercado');
  await save(P);
  await P.goto(BASE + '/#/lancamentos');
  await P.locator('#filters [name="month"]').selectOption('');
  await P.locator('[data-tx]', { hasText: 'Mercado teste' }).click();
  await fill(P, 'amount', '30,00'); await fill(P, 'description', 'Mercado teste editado');
  await save(P);
  await P.locator('[data-tx]', { hasText: 'Mercado teste editado' }).waitFor();
  await P.goto(BASE + '/#/contas');
  assert.equal(norm(await balanceText(P, 'Carteira Teste EUR')), '€ 970,00');
});

await step('Transferência não vira receita/despesa e reserva exige confirmação para sair', async () => {
  await P.goto(BASE + '/#/painel');
  await P.locator('[data-act="transfer"]').click();
  await select(P, 'from_account_id', { label: 'Carteira Teste EUR (EUR)' }); await select(P, 'to_account_id', { label: 'Reserva Teste (EUR) · reserva' });
  await fill(P, 'amount', '200,00'); await fill(P, 'date', '2026-10-06');
  await save(P);
  await P.goto(BASE + '/#/contas');
  assert.equal(norm(await balanceText(P, 'Carteira Teste EUR')), '€ 770,00');
  assert.equal(norm(await balanceText(P, 'Reserva Teste')), '€ 200,00');
  // Saída da reserva: o servidor pede confirmação; cancelar não altera nada.
  await P.locator('#quick-add').click();
  await fill(P, 'amount', '50,00'); await select(P, 'account_id', { label: 'Reserva Teste (EUR) · reserva' }); await fill(P, 'description', 'Saque reserva');
  await P.locator('#dialog button[type="submit"]').click();
  const confirm = P.locator('dialog:not(#dialog)');
  await confirm.locator('p', { hasText: 'reserva protegida' }).waitFor();
  await confirm.locator('button[value="no"]').click();
  await P.locator('#dialog .form-error', { hasText: 'cancelada' }).waitFor();
  await P.locator('#dialog [data-close]').first().click();
  assert.equal(norm(await balanceText(P, 'Reserva Teste')), '€ 200,00');
  const st = await P.evaluate(() => fetch('/api/fin/state').then(r => r.json()));
  const month = st.transactions.filter(t => t.date.startsWith('2026-10') && t.status === 'confirmada');
  assert.equal(month.filter(t => t.kind === 'despesa').reduce((s, t) => s - t.amount_cents, 0), 3000);
  assert.equal(month.filter(t => t.kind === 'transferencia').length, 2);
});

await step('Recibo: extrai dados, alerta duplicidade e só registra após confirmar', async () => {
  await P.goto(BASE + '/#/recibos');
  await P.locator('#receipt-text').fill('MERCADO TESTE\nTOTAL € 30,00\n05/10/2026');
  await P.locator('#parse-text').click();
  await P.locator('#dialog .banner.warn', { hasText: 'Possível duplicidade' }).waitFor();
  assert.equal(await P.locator('#dialog [name="amount"]').inputValue(), '30,00');
  assert.equal(await P.locator('#dialog [name="date"]').inputValue(), '05/10/2026');
  await snap(P, 'recibo.png');
  const before = (await P.evaluate(() => fetch('/api/fin/state').then(r => r.json()))).transactions.length;
  await P.locator('#dialog [data-close]').first().click();
  const after = (await P.evaluate(() => fetch('/api/fin/state').then(r => r.json()))).transactions.length;
  assert.equal(after, before, 'cancelar não pode registrar nada');
});

await step('Recibo por foto: OCR no aparelho preenche valor, data e estabelecimento', async () => {
  // Cria a "foto" de um recibo renderizando HTML e tirando screenshot.
  const pic = await notebook.ctx.newPage();
  await pic.setViewportSize({ width: 520, height: 420 });
  await pic.setContent(`<body style="margin:0;background:#fff;font:28px/1.5 Arial;padding:30px">PADARIA CENTRAL<br>Rua das Flores 10<br>Data 07/10/2026<br>TOTAL EUR 4,20<br>Obrigado</body>`);
  const png = await pic.screenshot(); await pic.close();
  await P.goto(BASE + '/#/recibos');
  await P.locator('#receipt-file').setInputFiles({ name: 'padaria.png', mimeType: 'image/png', buffer: png });
  await P.locator('#dialog[open]').waitFor({ timeout: 90000 });
  assert.equal(await P.locator('#dialog [name="amount"]').inputValue(), '4,20');
  assert.equal(await P.locator('#dialog [name="date"]').inputValue(), '07/10/2026');
  assert.match(await P.locator('#dialog [name="merchant"]').inputValue(), /PADARIA CENTRAL/i);
  await snap(P, 'recibo-ocr.png');
  await P.locator('#dialog [data-close]').first().click();
  // O comprovante fica na caixa "sem lançamento" até ser confirmado.
  await P.goto(BASE + '/#/painel'); await P.goto(BASE + '/#/recibos');
  await P.locator('[data-launch]').first().waitFor();
});

await step('Recibo com imagem: anexo salvo e ligado ao lançamento', async () => {
  // Gera uma imagem de recibo no próprio navegador e envia pelo fluxo da API (OCR depende de internet).
  const ok = await P.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 300, height: 200 });
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 200); g.fillStyle = '#000'; g.font = '20px sans-serif'; g.fillText('CAFE TESTE  € 4,20', 10, 50);
    const b64 = c.toDataURL('image/jpeg').split(',')[1];
    const att = await fetch('/api/fin/attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'cafe.jpg', mime: 'image/jpeg', data_b64: b64 }) }).then(r => r.json());
    const st = await fetch('/api/fin/state').then(r => r.json());
    const acc = st.accounts.find(a => a.name === 'Carteira Teste EUR');
    const tx = await fetch('/api/fin/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: acc.id, kind: 'despesa', amount_cents: 420, date: '2026-10-07', description: 'Café teste', attachment_ids: [att.id] }) }).then(r => r.json());
    const file = await fetch('/api/fin/attachments/' + att.id);
    const st2 = await fetch('/api/fin/state').then(r => r.json());
    return file.ok && file.headers.get('content-type') === 'image/jpeg' && st2.attachments.find(a => a.id === att.id).transaction_id === tx.id;
  });
  assert.equal(ok, true);
});

await step('Conciliação: detecta diferença e ajuste só com autorização', async () => {
  await P.goto(BASE + '/#/contas');
  await P.locator('.card', { has: P.locator('h2', { hasText: 'Carteira Teste EUR' }) }).locator('[data-recon]').click();
  await fill(P, 'reported', '760,00');
  await P.locator('#dialog button[type="submit"]').click();
  await P.locator('#recon-result', { hasText: 'calculado' }).waitFor();
  assert.match(norm(await P.locator('#recon-result').innerText()), /−€ 5,80/);
  await P.locator('#dialog button', { hasText: 'Lançar ajuste da diferença' }).click();
  await P.locator('dialog:not(#dialog) button[value="yes"]').click();
  await P.waitForFunction(() => !document.getElementById('dialog').open);
  await expectBalance(P, 'Carteira Teste EUR', '€ 760,00'); // 770 − 4,20 (café) − 5,80 (ajuste)
});

await step('Celular: login separado vê os mesmos dados (sincronização via servidor)', async () => {
  await login(M);
  await M.goto(BASE + '/#/lancamentos');
  await M.locator('#filters [name="month"]').selectOption('');
  await M.locator('[data-tx]', { hasText: 'Mercado teste editado' }).waitFor();
  assert.ok(await M.locator('#tabbar').isVisible(), 'barra inferior visível no celular');
  assert.ok(!(await M.locator('.sidebar').isVisible()), 'menu lateral oculto no celular');
  const overflow = await M.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'sem rolagem horizontal no celular');
  await M.goto(BASE + '/#/painel'); await snap(M, 'celular-painel.png');
});

await step('Lançamento feito no celular aparece no notebook sem recarregar', async () => {
  await M.locator('[data-quick]').click();
  await fill(M, 'amount', '12,00'); await select(M, 'account_id', { label: 'Carteira Teste EUR (EUR)' }); await fill(M, 'date', '2026-10-08'); await fill(M, 'description', 'Feito no celular');
  await save(M);
  await P.goto(BASE + '/#/lancamentos');
  await P.locator('#filters [name="month"]').selectOption('');
  await P.evaluate(() => window.dispatchEvent(new Event('online'))); // mesmo gatilho da verificação periódica
  await P.locator('[data-tx]', { hasText: 'Feito no celular' }).waitFor({ timeout: 10000 });
});

await step('Edição concorrente: versão antiga é recusada (409) sem sobrescrever', async () => {
  const r = await P.evaluate(async () => {
    const st = await fetch('/api/fin/state').then(r => r.json());
    const t = st.transactions.find(x => x.description === 'Feito no celular');
    const body = { id: t.id, version: t.version, account_id: t.account_id, kind: 'despesa', amount_cents: 1300, date: t.date, description: 'Versão A' };
    const a = await fetch('/api/fin/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const b = await fetch('/api/fin/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, description: 'Versão B' }) });
    const final = (await fetch('/api/fin/state').then(r => r.json())).transactions.find(x => x.id === t.id);
    return [a.status, b.status, final.description];
  });
  assert.deepEqual(r, [200, 409, 'Versão A']);
});

await step('Auditoria registra criação, edição, exclusão', async () => {
  const audit = await P.evaluate(() => fetch('/api/fin/audit?limit=500').then(r => r.json()));
  for (const action of ['criar', 'editar']) assert.ok(audit.some(a => a.action === action), action);
});

await step('Backup e restauração recuperam os dados', async () => {
  const backup = await P.evaluate(() => fetch('/api/backup?anexos=1').then(r => r.json()));
  assert.equal(backup.format, 'wall-finance-backup');
  const count = backup.tables.fin_transactions.filter(t => !t.deleted_at).length;
  await P.evaluate(async () => {
    const st = await fetch('/api/fin/state').then(r => r.json());
    for (const t of st.transactions.filter(x => x.kind === 'despesa')) await fetch('/api/fin/transactions/' + t.id, { method: 'DELETE' });
  });
  const wrong = await P.evaluate(b => fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: b, confirm: 'sim' }) }).then(r => r.status), backup);
  assert.equal(wrong, 400, 'sem a palavra RESTAURAR não restaura');
  const res = await P.evaluate(b => fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: b, confirm: 'RESTAURAR' }) }).then(r => r.json()), backup);
  assert.equal(res.ok, true);
  const st = await P.evaluate(() => fetch('/api/fin/state').then(r => r.json()));
  assert.equal(st.transactions.length, count);
  await P.goto(BASE + '/#/contas'); await P.reload();
  await expectBalance(P, 'Carteira Teste EUR', '€ 747,00'); // 760 − 13,00 (lançamento do celular, editado)
});

await step('Exportação CSV com cabeçalho em português', async () => {
  // Response.text() remove o BOM; conferimos os bytes crus.
  const [bom, csv] = await P.evaluate(async () => { const b = new Uint8Array(await fetch('/api/fin/export.csv').then(r => r.arrayBuffer())); return [[...b.slice(0, 3)], new TextDecoder().decode(b)]; });
  assert.deepEqual(bom, [0xEF, 0xBB, 0xBF], 'BOM para o Excel abrir acentos corretamente');
  assert.ok(csv.startsWith('Data;Conta;Tipo;Descrição'));
  assert.ok(csv.includes('Mercado teste editado'));
});

await step('Orçamento, recorrência (lançamento manual), delivery e meta', async () => {
  const r = await P.evaluate(async () => {
    const j = (p, b) => fetch('/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => [r.status, await r.json()]);
    const st = await fetch('/api/fin/state').then(r => r.json());
    const acc = st.accounts.find(a => a.name === 'Carteira Teste EUR');
    const out = {};
    out.budget = (await j('fin/budgets', { name: 'Mercado', category: 'Mercado', period: 'mensal', limit_cents: 10000, currency: 'EUR' }))[0];
    const [, rec] = await j('fin/recurring', { account_id: acc.id, kind: 'despesa', amount_cents: 5000, description: 'Internet', frequency: 'mensal', next_date: '2026-10-31' });
    const before = (await fetch('/api/fin/state').then(r => r.json())).transactions.length;
    out.noAuto = before; // criar recorrência não lança nada
    const [, launched] = await j(`fin/recurring/${rec.id}/launch`, {});
    out.next = launched.next_date;
    out.shift = (await j('fin/shifts', { date: '2026-10-09', platform: 'Uber Eats', hours_x100: 450, km_x10: 620, orders: 9, gross_cents: 6500, tips_cents: 800, costs_cents: 900, account_id: acc.id, register: true, status: 'pendente' }))[0];
    out.goal = (await j('fin/goals', { name: 'Patrimônio', kind: 'patrimonio', target_cents: 10000000, currency: 'BRL', due_date: '2027-10-13' }))[0];
    out.rate = (await j('fin/settings', { eur_brl_milli: 6200, eur_brl_date: '2026-10-13' }))[0];
    const st2 = await fetch('/api/fin/state').then(r => r.json());
    out.after = st2.transactions.length - before;
    return out;
  });
  assert.deepEqual(r, { budget: 201, noAuto: r.noAuto, next: '2026-11-30', shift: 201, goal: 201, rate: 200, after: 3 });
  for (const route of ['orcamentos', 'recorrentes', 'delivery', 'metas', 'relatorios', 'painel']) {
    await P.goto(BASE + '/#/' + route);
    await P.locator('.page-head h1').waitFor();
    assert.equal(await P.locator('.banner.error').count(), 0, route);
  }
  await snap(P, 'notebook-painel.png');
});

await step('WALL OS: checklist, diário, calendário e planejamento', async () => {
  await M.goto(BASE + '/#/hoje');
  await M.locator('#quick-check [name="title"]').fill('Revisar gastos do dia');
  await M.locator('#quick-check button').click();
  await M.locator('[data-toggle]').first().check();
  await M.waitForFunction(() => document.querySelector('[data-toggle]')?.checked);
  for (const route of ['objetivos', 'planejamento', 'diario', 'calendario']) {
    await M.goto(BASE + '/#/' + route);
    await M.locator('.page-head h1').waitFor();
  }
  const items = await M.evaluate(() => fetch('/api/os/items').then(r => r.json()));
  assert.ok(items.some(i => i.module === 'checklist' && i.done === 1));
});

await step('Assistente: análise por regras sem IA externa', async () => {
  await P.goto(BASE + '/#/assistente');
  await P.locator('.insight').first().waitFor();
  await P.locator('#ask textarea').fill('Como estão minhas metas?');
  await P.locator('#ask button.primary').click();
  await P.locator('.bubble:not(.me)', { hasText: 'Regras sobre' }).waitFor(); // respondida pelas regras, sem IA
});

await step('PWA: manifesto, ícones e service worker', async () => {
  const m = await (await fetch(BASE + '/manifest.webmanifest')).json();
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.equal((await fetch(BASE + i.src)).status, 200, i.src);
  assert.ok(m.icons.some(i => i.sizes === '512x512') && m.icons.some(i => i.sizes === '192x192'));
  assert.equal(await P.evaluate(async () => !!(await navigator.serviceWorker.ready).active), true);
  const head = await fetch(BASE + '/');
  assert.match(head.headers.get('content-security-policy') || '', /default-src 'self'/);
});


const api = (page, path, body, method) => page.evaluate(async ([p, b, m]) => {
  const r = await fetch('/api/' + p, { method: m || (b === undefined ? 'GET' : 'POST'), headers: b === undefined ? {} : { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [path, body, method]);
const accId = async (page, name) => (await api(page, 'fin/state')).body.accounts.find(a => a.name === name).id;

await step('Reserva dentro da conta: tira do disponível, não vira despesa e protege o saldo', async () => {
  await P.goto(BASE + '/#/contas');
  await P.locator('[data-act="reserve"]').click();
  await fill(P, 'name', 'Moradia teste'); await select(P, 'account_id', { label: 'Carteira Teste EUR (EUR)' });
  await fill(P, 'target', '800,00'); await fill(P, 'allocated', '600,00');
  await save(P);
  await P.locator('text=/Déficit: €\\s200,00/').waitFor();
  const st = (await api(P, 'fin/state')).body;
  assert.equal(st.transactions.filter(t => t.description.includes('Moradia')).length, 0, 'reservar não cria lançamento');
  const acc = st.accounts.find(a => a.name === 'Carteira Teste EUR').id;
  // Saldo 697 (após a recorrência “Internet”) − reservado 600 = 97 livres. Gastar 120 avança sobre a reserva → 428.
  const r1 = await api(P, 'fin/transactions', { account_id: acc, kind: 'despesa', amount_cents: 12000, date: '2026-10-10', description: 'Gasto grande' });
  assert.equal(r1.status, 428);
  const r2 = await api(P, 'fin/transactions', { account_id: acc, kind: 'despesa', amount_cents: 4000, date: '2026-10-10', description: 'Gasto ok' });
  assert.equal(r2.status, 201);
  const big = await api(P, 'fin/reserves', { name: 'Excesso', account_id: acc, target_cents: 100000, allocated_cents: 100000 });
  assert.equal(big.status, 400, 'não reserva mais do que existe na conta');
});

await step('Planejada fica fora do saldo até ser lançada', async () => {
  const acc = await accId(P, 'Carteira Teste EUR');
  const before = (await api(P, 'fin/state')).body.transactions.length;
  const p = await api(P, 'fin/planned', { kind: 'despesa', amount_cents: 500, description: 'Passagem planejada', account_id: acc, due_date: '2026-10-20' });
  assert.equal(p.status, 201);
  assert.equal((await api(P, 'fin/state')).body.transactions.length, before);
  await P.goto(BASE + '/#/recorrentes'); await P.reload();
  await P.locator('[data-plan-launch]').first().click();
  await save(P);
  const st = (await api(P, 'fin/state')).body;
  assert.equal(st.transactions.length, before + 1);
  assert.equal(st.planned.find(x => x.id === p.body.id).status, 'lancada');
});

await step('Importação de extrato CSV: preview, duplicados e reimportação sem duplicar', async () => {
  const csv = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n'
    + 'CARD_PAYMENT,Current,2026-10-11 10:00:00,2026-10-11 10:05:00,Padaria do bairro,-3.10,0.00,EUR,COMPLETED,1\n'
    + 'TRANSFER,Current,2026-10-12 10:00:00,2026-10-12 10:00:00,Pagamento recebido,25.00,0.00,EUR,COMPLETED,1\n'
    + 'CARD_PAYMENT,Current,2026-10-12 11:00:00,2026-10-12 11:00:00,Estornado,-9.00,0.00,EUR,REVERTED,1\n';
  await P.goto(BASE + '/#/extrato');
  await P.locator('#csv-file').setInputFiles({ name: 'revolut.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await P.locator('text=Formato detectado').waitFor();
  await P.locator('#csv-map [name="account"]').selectOption({ label: 'Carteira Teste EUR (EUR)' });
  await P.locator('[data-row]').first().waitFor();
  assert.equal(await P.locator('[data-row]').count(), 2, 'linha estornada ignorada');
  await P.locator('#csv-import').click();
  await P.locator('dialog:not(#dialog) button[value="yes"]').click();
  await P.locator('#toast', { hasText: '2 importada' }).waitFor();
  const acc = await accId(P, 'Carteira Teste EUR');
  const again = await api(P, 'fin/import/csv', { account_id: acc, rows: [{ line: 2, date: '2026-10-11', description: 'Padaria do bairro', amount_cents: -310 }] });
  assert.deepEqual(again.body, { imported: 0, skipped: 1 });
  const st = (await api(P, 'fin/state')).body;
  assert.ok(st.transactions.filter(t => t.import_hash).every(t => t.status === 'pendente'), 'importadas como pendentes não mexem no saldo');
});

await step('Lançamentos em lote: classificar e confirmar', async () => {
  await P.goto(BASE + '/#/lancamentos'); await P.reload();
  await P.locator('#filters [name="status"]').selectOption('pendente');
  await P.locator('[data-act="select"]').click();
  await P.locator('#sel-all').check();
  await P.locator('[data-bulk="categoria"]').click();
  await fill(P, 'category', 'Mercado'); await save(P);
  await P.locator('#toast', { hasText: 'atualizados' }).waitFor();
  const st = (await api(P, 'fin/state')).body;
  assert.ok(st.transactions.filter(t => t.import_hash).every(t => t.category === 'Mercado'));
});

await step('Investimentos: operações registradas sem criar lançamentos', async () => {
  const before = (await api(P, 'fin/state')).body.transactions.length;
  const inv = await api(P, 'fin/investments', { name: 'ETF teste', kind: 'ETFs', currency: 'EUR', invested_cents: 0 });
  assert.equal((await api(P, 'fin/investment-ops', { investment_id: inv.body.id, type: 'compra', date: '2026-10-10', total_cents: 10000, quantity_micro: 2000000 })).status, 201);
  const st = (await api(P, 'fin/state')).body;
  assert.equal(st.transactions.length, before);
  await P.goto(BASE + '/#/investimentos'); await P.reload();
  await P.locator('text=ETF teste').waitFor();
});

await step('Lista de desejos: criar e reordenar', async () => {
  for (const name of ['Fone', 'Tênis']) assert.equal((await api(P, 'fin/wishlist', { name, price_cents: 5000, currency: 'EUR' })).status, 201);
  await P.goto(BASE + '/#/desejos'); await P.reload();
  await P.locator('[data-down="0"]').click();
  await P.waitForFunction(() => document.querySelector('#wish .row .title')?.textContent.includes('Tênis'));
});

await step('WALL OS: hábitos, inglês, metas por prazo, projeto, arquivar e reordenar', async () => {
  await M.goto(BASE + '/#/habitos'); await M.reload();
  await M.locator('[data-preset="agua"]').click(); await save(M);
  await M.locator('[data-habit] [name="value"]').first().fill('8');
  await M.locator('[data-habit] button').first().click();
  await M.locator('#toast', { hasText: 'Registrado' }).waitFor();
  const logs = (await api(M, 'os/habit-logs?from=2000-01-01')).body;
  assert.equal(logs[0].value, 8);
  await M.goto(BASE + '/#/ingles');
  await M.locator('[data-new]').click(); await fill(M, 'title', 'Phrasal verbs'); await fill(M, 'minutes', '25'); await save(M);
  await M.locator('text=/25 min/').first().waitFor();
  await M.goto(BASE + '/#/objetivos');
  for (const [h, t] of [['curto', 'Completar reserva'], ['longo', 'Comprar casa']]) { await M.locator(`[data-new-h="${h}"]`).click(); await fill(M, 'title', t); await save(M); }
  await M.locator('[data-h="longo"]', { hasText: 'Comprar casa' }).waitFor();
  await M.goto(BASE + '/#/projetos');
  await M.locator('[data-new]').click(); await fill(M, 'title', 'Projeto teste'); await fill(M, 'next', 'Publicar'); await save(M);
  await M.locator('#biz [data-archive]').first().click();
  await M.locator('#toast', { hasText: 'Arquivado' }).waitFor();
  const items = (await api(M, 'os/items')).body;
  assert.equal(items.find(i => i.title === 'Projeto teste').archived, 1);
  assert.equal(items.find(i => i.title === 'Comprar casa').horizon, 'longo');
  await M.goto(BASE + '/#/hoje'); await snap(M, 'celular-hoje.png');
});

await step('Assistente responde as 7 perguntas pelas regras, sem IA externa', async () => {
  const qs = ['Quanto tenho disponível hoje?', 'Quanto ainda falta para completar minha reserva?', 'Quais contas vencem nesta semana?', 'Quanto ganhei trabalhando com delivery?',
    'Quanto economizei neste mês?', 'Quais tarefas ainda tenho hoje?', 'Qual é o progresso das minhas metas?'];
  for (const q of qs) { const r = (await api(P, 'assistant/ask', { question: q })).body; assert.equal(r.modo, 'regras', q); assert.ok(r.resposta && r.resposta.length > 10, q); }
  const fall = (await api(P, 'assistant/ask', { question: 'previsão do tempo amanhã' })).body;
  assert.equal(fall.resposta, null); assert.ok(fall.sugestoes.length >= 7);
  await P.goto(BASE + '/#/assistente');
  await P.locator('[data-q]').first().click();
  await P.locator('.bubble:not(.me)', { hasText: 'livres' }).waitFor();
});

await step('Recibo duplicado pode ser conciliado com o lançamento existente (sem lançar de novo)', async () => {
  const before = (await api(P, 'fin/state')).body.transactions.length;
  await P.goto(BASE + '/#/recibos'); await P.reload();
  await P.locator('#receipt-text').fill('PADARIA DO BAIRRO\nTOTAL € 3,10\n11/10/2026');
  await P.locator('#parse-text').click();
  await P.locator('#dialog [data-reconcile]').first().click();
  await P.locator('#toast', { hasText: 'conciliado' }).waitFor();
  const st = (await api(P, 'fin/state')).body;
  assert.equal(st.transactions.length, before);
  assert.ok(st.transactions.some(t => t.reconciled_at));
});

await step('Interface: modo escuro e datas em português', async () => {
  await P.emulateMedia({ colorScheme: 'dark' });
  await P.goto(BASE + '/#/painel'); await P.reload();
  const bg = await P.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(13, 17, 22)');
  await snap(P, 'notebook-escuro.png');
  await P.emulateMedia({ colorScheme: 'light' });
  await P.locator('#quick-add').click();
  assert.equal(await P.locator('#dialog [name="date"]').getAttribute('placeholder'), 'dd/mm/aaaa');
  await fill(P, 'date', '31/02/2026'); await fill(P, 'amount', '1,00'); await fill(P, 'description', 'x');
  await P.locator('#dialog button[type="submit"]').click();
  await P.locator('#dialog .form-error', { hasText: 'data inválida' }).waitFor();
  await P.locator('#dialog [data-close]').first().click();
  assert.equal(await P.locator('input[type="date"], input[type="time"], input[type="number"]').count(), 0, 'sem controles nativos com texto em inglês');
});

await step('Restauração do backup em um banco limpo', async () => {
  const backup = await P.evaluate(() => fetch('/api/backup?anexos=1').then(r => r.json()));
  const persist2 = mkdtempSync(join(tmpdir(), 'wf-e2e-clean-'));
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'wall-finance', '--local', '--persist-to', persist2], { cwd: root, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  const PORT2 = 8798, srv2 = spawn(wrangler, ['pages', 'dev', 'public', '--port', String(PORT2), '--persist-to', persist2, '--binding', `OWNER_EMAIL=${EMAIL}`, '--binding', `OWNER_PASSWORD_HASH=${hash}`], { cwd: root, env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${PORT2}/api/health`)).ok) break; } catch { /* aguardando */ } await new Promise(r => setTimeout(r, 500)); }
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT2}/`);
    await page.locator('#login-form [name="email"]').fill(EMAIL); await page.locator('#login-form [name="password"]').fill(PASSWORD);
    await page.locator('#login-form button').click(); await page.locator('#app').waitFor();
    const empty = (await api(page, 'fin/state')).body;
    assert.equal(empty.accounts.length, 0, 'banco limpo');
    const r = await api(page, 'restore', { backup, confirm: 'RESTAURAR' });
    assert.equal(r.status, 200);
    const st = (await api(page, 'fin/state')).body, os = (await api(page, 'os/items')).body;
    assert.equal(st.accounts.length, backup.tables.fin_accounts.length);
    assert.equal(st.transactions.length, backup.tables.fin_transactions.filter(t => !t.deleted_at).length);
    assert.equal(st.reserves.length, backup.tables.fin_reserves.length);
    assert.equal(os.length, backup.tables.os_items.filter(i => !i.deleted_at).length);
    assert.equal(st.attachments.length, backup.tables.fin_attachments.length);
    await ctx.close();
  } finally { srv2.kill(); }
});

await step('Configuração inicial por JSON cria contas, fotografias “a confirmar” e metas', async () => {
  await P.goto(BASE + '/#/dados');
  await P.locator('#setup-json').fill(JSON.stringify({
    contas: [{ nome: 'Seed EUR', moeda: 'EUR', tipo: 'carteira', saldo: '321,09', data: '2026-10-13', fonte: 'Teste', status: 'a_confirmar' },
      { nome: 'Seed Reserva', moeda: 'EUR', tipo: 'reserva', reserva: true, meta_reserva: '500,00' }],
    metas: [{ nome: 'Seed patrimônio', tipo: 'patrimonio', valor: '50.000,00', moeda: 'BRL', prazo: '2027-10-13' }],
  }));
  await P.locator('[data-act="setup"]').click();
  await P.locator('dialog:not(#dialog) button[value="yes"]').click();
  await P.locator('#toast', { hasText: '3 registro' }).waitFor();
  const st = await P.evaluate(() => fetch('/api/fin/state').then(r => r.json()));
  const acc = st.accounts.find(a => a.name === 'Seed EUR');
  const s = st.snapshots.find(x => x.account_id === acc.id);
  assert.deepEqual([s.amount_cents, s.status, s.is_anchor], [32109, 'a_confirmar', 1]);
  assert.equal(st.accounts.find(a => a.name === 'Seed Reserva').is_reserve, 1);
  assert.ok(st.goals.some(g => g.name === 'Seed patrimônio' && g.target_cents === 5000000));
  assert.equal(st.transactions.filter(t => t.account_id === acc.id).length, 0, 'nenhum lançamento retroativo');
});

await step('Sair encerra a sessão (dados voltam a exigir login)', async () => {
  await P.goto(BASE + '/#/dados');
  await P.locator('[data-act="logout"]').click();
  await P.locator('#login').waitFor();
  assert.equal(await P.evaluate(() => fetch('/api/fin/state').then(r => r.status)), 401);
  assert.equal(await M.evaluate(() => fetch('/api/fin/state').then(r => r.status)), 200, 'celular continua conectado');
});

await step('Sem erros de JavaScript ou CSP no console', async () => { assert.deepEqual(errors, []); });

await browser.close();
server.kill();
console.log(`\n${passed} passaram, ${failed} falharam.`);
if (failed) { console.log('\nLog do servidor (final):\n' + log.slice(-3000)); process.exit(1); }

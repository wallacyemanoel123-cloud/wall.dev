// Roteador da API. Tudo em /api/* exige sessão válida, exceto login e health.
import { HttpError, json, assertSameOrigin, fail } from './http.js';
import { currentSession, login, logout, listSessions } from './auth.js';
import { finRoutes } from './fin.js';
import { osRoutes } from './os.js';
import { backup, restore, importPilot } from './backup.js';
import { assistantRoutes } from './assistant.js';
import { revision } from './store.js';

export async function handle(request, env) {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const method = request.method;
    if (!['GET', 'POST', 'DELETE'].includes(method)) fail(405, 'Método não permitido.');
    if (method !== 'GET') assertSameOrigin(request);
    if (!env.DB) fail(503, 'Banco de dados não configurado (binding DB).');

    if (parts[0] === 'health') return json({ ok: true, configured: Boolean(env.OWNER_EMAIL && env.OWNER_PASSWORD_HASH) });
    if (parts[0] === 'auth' && parts[1] === 'login' && method === 'POST') return await login(request, env);

    const session = await currentSession(request, env);
    if (!session) fail(401, 'Entre com seu e-mail e senha.');

    if (parts[0] === 'auth') {
      if (parts[1] === 'me') return json({ email: session.email });
      if (parts[1] === 'logout' && method === 'POST') return await logout(env, session, url.searchParams.get('all') === '1');
      if (parts[1] === 'sessions') return json(await listSessions(env));
    }
    if (parts[0] === 'revision') return json({ revision: await revision(env.DB) });
    if (parts[0] === 'fin') return await finRoutes(request, env, parts.slice(1), url);
    if (parts[0] === 'os') return await osRoutes(request, env, parts.slice(1));
    if (parts[0] === 'assistant') return await assistantRoutes(request, env, parts.slice(1));
    if (parts[0] === 'backup' && method === 'GET') return await backup(env, url.searchParams.get('anexos') === '1');
    if (parts[0] === 'restore' && method === 'POST') return await restore(request, env);
    if (parts[0] === 'import' && parts[1] === 'pilot' && method === 'POST') return await importPilot(request, env);
    fail(404, 'Operação não encontrada.');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
    console.error(e);
    return json({ error: 'Falha interna no servidor. Atualize a tela e confira antes de tentar de novo.' }, 500);
  }
}

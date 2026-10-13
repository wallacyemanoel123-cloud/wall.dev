// Cliente da API. Cookies HttpOnly cuidam da sessão; nenhum segredo fica no navegador.
export class ApiError extends Error {
  constructor(status, data) { super(data?.error || `Erro ${status}`); this.status = status; this.data = data || {}; }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api/' + path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: 'Sem conexão com o servidor. Nada foi salvo.' });
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    if (res.status === 401 && path !== 'auth/login') window.dispatchEvent(new CustomEvent('wf:logout'));
    throw new ApiError(res.status, data);
  }
  return data;
}

export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const del = path => api(path, { method: 'DELETE' });

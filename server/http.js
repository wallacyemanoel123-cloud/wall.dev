// Utilidades HTTP: respostas JSON, erros, leitura de corpo com limite e cabeçalhos de segurança.
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

export async function readJson(request, maxBytes = 64 * 1024) {
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) fail(415, 'Envie os dados em JSON.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) fail(413, 'Pedido muito grande.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Pedido vazio.');
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); fail(413, 'Pedido muito grande.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes) || '{}'); } catch { fail(400, 'JSON inválido.'); }
}

// Proteção CSRF: mutações só a partir da própria origem.
export function assertSameOrigin(request) {
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  const self = new URL(request.url).origin;
  if (origin ? origin !== self : site && site !== 'same-origin') fail(403, 'Origem não autorizada.');
}

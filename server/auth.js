// Conta única (v1.0): e-mail + senha verificados contra segredos do servidor.
// A senha nunca é guardada: só o hash PBKDF2-SHA256 (segredo OWNER_PASSWORD_HASH).
import { fail, json, readJson } from './http.js';

const COOKIE = '__Host-wf_session';
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 8, WINDOW_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map(n => n.toString(16).padStart(2, '0')).join('');

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Formato: pbkdf2-sha256$<iterações>$<salt base64>$<hash base64>
export async function hashPassword(password, iterations = 100000, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false;
  const again = (await hashPassword(password, Number(iter), unb64(salt))).split('$')[3];
  return sameBytes(unb64(again), unb64(hash));
}

function readCookie(request) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE.replace(/[$]/g, '\\$')}=([A-Za-z0-9_-]{20,})`).exec(request.headers.get('Cookie') || '');
  return m ? m[1] : null;
}

export async function currentSession(request, env) {
  const token = readCookie(request);
  if (!token) return null;
  const row = await env.DB.prepare('SELECT token_hash, expires_at FROM auth_sessions WHERE token_hash = ?').bind(await sha256(token)).first();
  if (!row || row.expires_at < Date.now()) return null;
  return { tokenHash: row.token_hash, email: env.OWNER_EMAIL };
}

export async function login(request, env) {
  if (!env.OWNER_EMAIL || !env.OWNER_PASSWORD_HASH) fail(503, 'Acesso ainda não configurado no servidor (OWNER_EMAIL / OWNER_PASSWORD_HASH).');
  const input = await readJson(request, 4096);
  const now = Date.now();
  const ip = await sha256(request.headers.get('CF-Connecting-IP') || 'local');
  const bucket = `${ip}:${Math.floor(now / WINDOW_MS)}`;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_attempts WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO auth_attempts (bucket, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1').bind(bucket, now + WINDOW_MS),
  ]);
  const { count } = await env.DB.prepare('SELECT count FROM auth_attempts WHERE bucket = ?').bind(bucket).first();
  if (count > MAX_ATTEMPTS) fail(429, 'Muitas tentativas. Aguarde 15 minutos.');
  const email = String(input.email || '').trim().toLowerCase();
  const okEmail = email === String(env.OWNER_EMAIL).trim().toLowerCase();
  // Verifica a senha mesmo com e-mail errado, para não revelar qual dos dois falhou pelo tempo de resposta.
  const okPass = typeof input.password === 'string' && input.password.length <= 256 && await verifyPassword(input.password, env.OWNER_PASSWORD_HASH);
  if (!okEmail || !okPass) fail(401, 'E-mail ou senha incorretos.');
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_attempts WHERE bucket = ?').bind(bucket),
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO auth_sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), new Date(now).toISOString(), now + maxAge * 1000, (request.headers.get('User-Agent') || '').slice(0, 200)),
  ]);
  return json({ ok: true, email: env.OWNER_EMAIL }, 200, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax` });
}

export async function logout(env, session, everywhere = false) {
  if (everywhere) await env.DB.prepare('DELETE FROM auth_sessions').run();
  else await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(session.tokenHash).run();
  return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` });
}

export async function listSessions(env) {
  const { results } = await env.DB.prepare('SELECT created_at, expires_at, user_agent FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC').bind(Date.now()).all();
  return results;
}

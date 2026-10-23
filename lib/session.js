import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const COOKIE = 'todoweb3_session';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const secret = () => process.env.SESSION_SECRET || '';

function signature(payload) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}
export function configured() {
  return /^\d{4}$/.test(process.env.APP_PASSWORD || '') && secret().length >= 32;
}
export function verifiedPin(pin) {
  if (!/^\d{4}$/.test(pin)) return false;
  const a = createHash('sha256').update(pin).digest();
  const b = createHash('sha256').update(process.env.APP_PASSWORD).digest();
  return timingSafeEqual(a, b);
}
function readCookie(req) {
  const cookies = (req.headers.cookie || '').split(';');
  const entry = cookies.find(v => v.trim().startsWith(COOKIE + '='));
  return entry ? entry.trim().slice(COOKIE.length + 1) : '';
}
export function isAuthenticated(req) {
  if (!configured()) return false;
  const token = readCookie(req);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot), mac = token.slice(dot + 1);
  const expected = signature(payload);
  const x = Buffer.from(mac), y = Buffer.from(expected);
  if (x.length !== y.length || !timingSafeEqual(x, y)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.v === 1 && Number.isSafeInteger(claims.exp) &&
      claims.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
export function setSession(res) {
  const claims = { v: 1, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS };
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url');
  res.setHeader('Set-Cookie', COOKIE + '=' + data + '.' + signature(data) +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + TTL_SECONDS);
}
export function clearSession(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}

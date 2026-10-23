import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { configured, verifiedPin, isAuthenticated, setSession, clearSession } from './_session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({error: 'Authentication not configured'});
  if (req.method === 'GET') return res.status(200).json({authenticated: isAuthenticated(req)});
  if (req.method === 'DELETE') {
    clearSession(res);
    return res.status(200).json({authenticated: false});
  }
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});
  const pin = req.body?.pin;
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({error: 'PIN must be 4 digits'});
  }

  // Shared PostgreSQL rate limit survives serverless cold starts.
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const key = createHash('sha256').update(ip).digest('hex');
  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS auth_attempts (
      client_hash TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      window_started TIMESTAMPTZ NOT NULL
    )`;
    const attempts = await sql`
      INSERT INTO auth_attempts (client_hash, attempts, window_started)
      VALUES (${key}, 1, now())
      ON CONFLICT (client_hash) DO UPDATE SET
        attempts = CASE WHEN auth_attempts.window_started < now() - interval '15 minutes'
          THEN 1 ELSE auth_attempts.attempts + 1 END,
        window_started = CASE WHEN auth_attempts.window_started < now() - interval '15 minutes'
          THEN now() ELSE auth_attempts.window_started END
      RETURNING attempts
    `;
    if (attempts[0].attempts > 5) {
      res.setHeader('Retry-After', '900');
      return res.status(429).json({error: 'Too many attempts. Try again later.'});
    }
    if (!verifiedPin(pin)) return res.status(401).json({error: 'Incorrect PIN'});
    await sql`DELETE FROM auth_attempts WHERE client_hash = ${key}`;
    setSession(res);
    return res.status(200).json({authenticated: true});
  } catch (err) {
    console.error('PIN authentication error:', err);
    return res.status(500).json({error: 'Authentication temporarily unavailable'});
  }
}

import { neon } from '@neondatabase/serverless';
import { isAuthenticated } from '../lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    if (req.method === 'GET') {
      const rows = await sql`SELECT data, updated_at FROM app_state WHERE id = 1`;
      return res.status(200).json({
        status: 'ok',
        data: rows[0]?.data ?? null,
        updated_at: rows[0]?.updated_at ?? null
      });
    }

    // Only accept the three data tabs, matching the existing JSON backup layout.
    const body = req.body;
    const data = body?.data;
    const previous = body?.updated_at;
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !data.tab1_todo || !Array.isArray(data.tab1_todo['1']) ||
        typeof data.tab2_memo !== 'string' || !Array.isArray(data.tab4_bookmarks) ||
        typeof previous !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(previous)) {
      return res.status(400).json({ error: 'Invalid state or missing updated_at' });
    }
    if (Object.keys(data).some(k => !['tab1_todo','tab2_memo','tab4_bookmarks'].includes(k)) ||
        Object.keys(data.tab1_todo).some(k => k !== '1') ||
        data.tab1_todo['1'].length > 5000 || data.tab4_bookmarks.length > 2000 ||
        data.tab2_memo.length > 300000) {
      return res.status(400).json({ error: 'State exceeds limits or has unexpected fields' });
    }
    const todosValid = data.tab1_todo['1'].every(t =>
      t && typeof t.text === 'string' && t.text.length <= 2000 &&
      typeof t.isDone === 'boolean');
    const bookmarksValid = data.tab4_bookmarks.every(b => {
      if (!b || typeof b.name !== 'string' || typeof b.url !== 'string' ||
          !b.name.trim() || b.name.length > 200 || b.url.length > 2048) return false;
      try { return ['http:', 'https:'].includes(new URL(b.url).protocol); }
      catch { return false; }
    });
    if (!todosValid || !bookmarksValid) {
      return res.status(400).json({ error: 'Invalid todo or bookmark data' });
    }
    // A conditional update prevents a stale preview tab overwriting later changes.
    const result = await sql`
      UPDATE app_state SET
        data = ${JSON.stringify(data)}::jsonb,
        updated_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', updated_at) + interval '1 millisecond')
      WHERE id = 1 AND date_trunc('milliseconds', updated_at) = ${previous}::timestamptz
      RETURNING updated_at
    `;
    if (!result.length) {
      return res.status(409).json({ error: 'Data changed since last load. Refresh before saving.' });
    }
    return res.status(200).json({ status: 'ok', updated_at: result[0].updated_at });
  } catch (error) {
    console.error('State API failed:', error);
    return res.status(500).json({ status: 'error', message: 'Database operation failed' });
  }
}

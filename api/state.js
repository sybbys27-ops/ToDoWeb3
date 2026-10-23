
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    const rows = await sql`
      SELECT data, updated_at
      FROM app_state
      WHERE id = 1
    `;

    return res.status(200).json({
      status: 'ok',
      data: rows[0]?.data ?? null,
      updated_at: rows[0]?.updated_at ?? null
    });
  } catch (error) {
    console.error('Database query failed:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Database connection failed'
    });
  }
}

import pg from 'pg';

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-time Date objects.
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || undefined,
  database: process.env.DB_NAME,
});

export const query = (text, params) => pool.query(text, params);

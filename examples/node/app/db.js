import pg from 'pg';
export const db = new pg.Pool({
  host: 'db',
  database: 'app',
  user: 'app',
  password: process.env.DB_PASSWORD,
});

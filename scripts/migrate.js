// Creates the tables and indexes. Usage: DATABASE_URL=... node scripts/migrate.js
import { readFile } from 'node:fs/promises';
import { withClient } from '../lib/db.js';

const sql = await readFile(new URL('../lib/schema.sql', import.meta.url), 'utf8');
await withClient((c) => c.query(sql));
console.log('Schema is up to date.');

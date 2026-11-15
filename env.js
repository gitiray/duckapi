// env.js — zero-dependency .env loader. Imported FIRST by api.js so that
// PORT / API_KEY / STRICT_MODELS are in process.env before anything else
// runs. Existing environment variables always win.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');

if (existsSync(envFile)) {
  for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // strip surrounding quotes and inline comments after quoted values
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (value.includes(' #')) {
      value = value.split(' #')[0].trim();
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

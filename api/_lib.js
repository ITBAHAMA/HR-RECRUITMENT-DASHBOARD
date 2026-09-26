// Shared helpers for BRDC Recruit API (Vercel Node functions)
import crypto from 'node:crypto';

let _q = null;
async function driver() {
  if (_q) return _q;
  if (process.env.PGLITE_DIR) { // local testing only
    const { PGlite } = await import('@electric-sql/pglite');
    const db = globalThis.__pglite || (globalThis.__pglite = new PGlite(process.env.PGLITE_DIR));
    _q = { query: async (t, p = []) => (await db.query(t, p)).rows,
           tx: async (list) => { const out = []; await db.transaction(async (tx) => { for (const [t, p] of list) out.push((await tx.query(t, p || [])).rows); }); return out; } };
  } else {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw Object.assign(new Error('Database is not connected (DATABASE_URL missing)'), { status: 503 });
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    _q = { query: (t, p = []) => sql.query(t, p), tx: (list) => sql.transaction(list.map(([t, p]) => sql.query(t, p || []))) };
  }
  return _q;
}
export async function q(t, p) { return (await driver()).query(t, p); }
export async function tx(list) { return (await driver()).tx(list); }

let schemaReady = false;
export async function ensureSchema() {
  if (schemaReady) return;
  await q(`CREATE TABLE IF NOT EXISTS app_state (id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}'::jsonb, version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text)`);
  await q(`CREATE TABLE IF NOT EXISTS accounts (u text PRIMARY KEY, name text NOT NULL, first text, email text, role text NOT NULL DEFAULT 'hr_staff', bu text, status text NOT NULL DEFAULT 'active', hash text, must_change boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), last_login timestamptz)`);
  await q(`CREATE TABLE IF NOT EXISTS applications (id serial PRIMARY KEY, ref text NOT NULL, job text NOT NULL, mobile_key text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await q(`INSERT INTO app_state (id, data) VALUES ('main', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
  const n = await q(`SELECT count(*)::int AS n FROM accounts`);
  if (!n[0].n) {
    const pw = process.env.ADMIN_INITIAL_PASSWORD || 'BRDC@Admin2026';
    await q(`INSERT INTO accounts (u, name, first, role, bu, status, hash, must_change) VALUES ('admin','Administrator','Admin','hr_admin','All business units','active',$1,true)`, [hashPw(pw)]);
  }
  schemaReady = true;
}

// Passwords: scrypt with per-user salt
export function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); const h = crypto.scryptSync(String(pw), salt, 32).toString('hex'); return `s1$${salt}$${h}`; }
export function checkPw(pw, stored) {
  if (!stored || !stored.startsWith('s1$')) return false;
  const [, salt, h] = stored.split('$'); const c = crypto.scryptSync(String(pw), salt, 32);
  const b = Buffer.from(h, 'hex'); return b.length === c.length && crypto.timingSafeEqual(b, c);
}
export function pwProblems(p, u) { const x = []; p = String(p || ''); if (p.length < 8) x.push('at least 8 characters'); if (!/[A-Z]/.test(p)) x.push('an uppercase letter'); if (!/[a-z]/.test(p)) x.push('a lowercase letter'); if (!/\d/.test(p)) x.push('a number'); if (u && p.toLowerCase().includes(String(u).toLowerCase())) x.push('not containing the username'); return x; }

// Signed session tokens (HMAC-SHA256)
function secret() { const s = process.env.SESSION_SECRET; if (!s || s.length < 16) throw Object.assign(new Error('SESSION_SECRET is not set'), { status: 503 }); return s; }
export function sign(payload, hours = 12) { const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + hours * 3600e3 })).toString('base64url'); const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url'); return `${body}.${mac}`; }
export function verify(token) {
  if (!token || !token.includes('.')) return null; const [body, mac] = token.split('.');
  const good = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null;
}
export async function requireUser(req, { admin = false } = {}) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const p = verify(t);
  if (!p || p.kind !== 'session') throw Object.assign(new Error('Please sign in again'), { status: 401 });
  const a = (await q(`SELECT u, name, first, role, status FROM accounts WHERE u=$1`, [p.u]))[0];
  if (!a || a.status !== 'active') throw Object.assign(new Error('Account is disabled or missing'), { status: 401 });
  if (admin && a.role !== 'hr_admin') throw Object.assign(new Error('hr_admin only'), { status: 403 });
  return a;
}

export function body(req) { if (req.body && typeof req.body === 'object') return req.body; try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
export function send(res, status, data) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(data)); }
export function handle(fn) { return async (req, res) => { try { await ensureSchema(); await fn(req, res); } catch (e) { send(res, e.status || 500, { error: e.status ? e.message : 'Server error: ' + e.message }); } }; }
export const mobileKey = (m) => String(m || '').replace(/\D/g, '').slice(-10);
export const publicAccount = (a) => ({ u: a.u, name: a.name, first: a.first, email: a.email || '', role: a.role, bu: a.bu || '—', status: a.status, mustChange: !!a.must_change, hasPassword: !!a.hash, last: a.last_login, created: a.created_at });

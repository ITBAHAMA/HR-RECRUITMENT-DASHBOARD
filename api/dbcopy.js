import { q, tx, handle, body, send, requireUser, dbUrls, makeDriver, TABLES } from './_lib.js';
// One-time copy of everything from the old Neon database into Supabase (hr_admin only, run from Settings).
// The client calls step 'start' once, then each table in batches until done, then 'finish'.
const KEY = { accounts: 'u', app_state: 'id', applications: 'id', files: 'id', forms: 'ref', kv: 'k', outbox: 'id', reminders: 'key' };
const NUMERIC = new Set(['applications', 'files', 'outbox']);
const BATCH = (t) => (t === 'files' ? 4 : t === 'app_state' ? 1 : 200);
let OLD = null;
const old = async () => OLD || (OLD = await makeDriver(dbUrls().old));
const ins = (t) => `INSERT INTO ${t} SELECT * FROM jsonb_populate_recordset(null::${t}, $1::jsonb) ON CONFLICT DO NOTHING`;

export default handle(async (req, res) => {
  await requireUser(req, { admin: true });
  const U = dbUrls();
  if (req.method === 'GET') return send(res, 200, { kind: U.kind, oldAvailable: !!U.old });
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  if (U.kind !== 'supabase' || !U.old) return send(res, 400, { error: 'Copy works only after SUPABASE_DB_URL is set and the old Neon database is still connected' });
  const b = body(req) || {}; const O = await old();

  if (b.step === 'start') {
    const counts = {};
    for (const t of TABLES) { try { counts[t] = (await O.query(`SELECT count(*)::int n FROM ${t}`))[0].n; } catch (e) {
      if (/quota|402/i.test(String(e.message))) return send(res, 409, { error: 'The old Neon database is still blocked (quota). Try again after the monthly reset.' });
      counts[t] = 0; } }
    const acc = await O.query(`SELECT * FROM accounts`); const st = await O.query(`SELECT * FROM app_state`);
    await tx([[`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`], [ins('accounts'), [JSON.stringify(acc)]], [ins('app_state'), [JSON.stringify(st)]]]);
    return send(res, 200, { counts, tables: TABLES.filter((t) => t !== 'accounts' && t !== 'app_state') });
  }
  if (b.step === 'finish') {
    for (const t of NUMERIC) await q(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT max(id) FROM ${t}), 0), 1))`);
    const counts = {}; for (const t of TABLES) counts[t] = (await q(`SELECT count(*)::int n FROM ${t}`))[0].n;
    return send(res, 200, { ok: true, counts });
  }
  const t = String(b.table || ''); if (!KEY[t] || t === 'accounts' || t === 'app_state') return send(res, 400, { error: 'Unknown table' });
  const k = KEY[t]; const num = NUMERIC.has(t); const after = b.after == null ? (num ? 0 : '') : b.after;
  let rows; try { rows = await O.query(`SELECT * FROM ${t} WHERE ${k} > $1 ORDER BY ${k} LIMIT ${BATCH(t)}`, [num ? Number(after) : String(after)]); }
  catch (e) { if (/does not exist/i.test(String(e.message))) return send(res, 200, { done: true, n: 0 }); throw e; }
  if (rows.length) await q(ins(t), [JSON.stringify(rows)]);
  return send(res, 200, { n: rows.length, next: rows.length ? rows[rows.length - 1][k] : after, done: rows.length < BATCH(t) });
});

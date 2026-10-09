import { scopeOf } from './_scope.js';
import { q, handle, body, send, verify, derivedKey } from './_lib.js';
import { syncJotform, jotStatus, jotConfig, checkOne } from './_jotform.js';
// Jotform → BRDC Recruit. Called by: the Jotform webhook (?key=…), the Vercel cron, or HR admins (Sync now / Import past submissions).
const adminOf = async (req) => {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const p = verify(t);
  if (!p || p.kind !== 'session') return null;
  const a = (await q(`SELECT u, role, status, bu FROM accounts WHERE u=$1`, [p.u]))[0];
  return a && a.status === 'active' && a.role === 'hr_admin' ? a : null;
};
const staffOf = async (req) => {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const p = verify(t);
  if (!p || p.kind !== 'session') return null;
  const a = (await q(`SELECT u, role, status, bu FROM accounts WHERE u=$1`, [p.u]))[0];
  return a && a.status === 'active' && a.role !== 'viewer' ? a : null;
};
export default handle(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const admin = await adminOf(req);
  const cronOk = process.env.CRON_SECRET && (req.headers.authorization || '') === 'Bearer ' + process.env.CRON_SECRET;
  const hookOk = url.searchParams.get('key') === (process.env.INBOUND_KEY ? process.env.INBOUND_KEY + '-jf' : derivedKey('jotform'));
  if (url.searchParams.get('status')) {
    if (!admin) return send(res, 401, { error: 'Please sign in again' });
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    return send(res, 200, { configured: !!jotConfig().key, form: jotConfig().form, status: await jotStatus(),
      webhook: `${/localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https'}://${host}/api/jotform?key=${process.env.INBOUND_KEY ? process.env.INBOUND_KEY + '-jf' : derivedKey('jotform')}` });
  }
  if (req.method === 'POST') { const who = admin || await staffOf(req); if (who) { const b = body(req); if (b.ref) return send(res, 200, await checkOne(b.ref, scopeOf(who))); } }
  if (admin && req.method === 'POST') { const b = body(req); return send(res, 200, await syncJotform({ all: !!b.all, offset: Math.max(0, +b.offset || 0), max: b.all ? 10 : 8, rematch: !!b.rematch && !b.all })); }
  const staff = !admin && await staffOf(req);
  if (staff && req.method === 'POST') { const b = body(req); const r = await syncJotform({ rematch: !!b.rematch }); return send(res, 200, { imported: r.imported || 0, attached: r.attached || 0, merged: r.merged || [], configured: r.configured, error: r.error }); }
  if (!admin && !cronOk && !hookOk) {
    // anonymous calls (e.g. the cron without CRON_SECRET) may run at most every 2 minutes and get no details back
    const last = ((await q(`SELECT updated_at FROM kv WHERE k='jot:status'`))[0] || {}).updated_at;
    if (last && Date.now() - new Date(last).getTime() < 120000) return send(res, 200, { ok: true, throttled: true });
    const r = await syncJotform(); return send(res, 200, { ok: true, imported: r.imported || 0 });
  }
  const r = await syncJotform();
  return send(res, 200, hookOk && !admin && !cronOk ? { ok: true, imported: r.imported || 0 } : r);
});

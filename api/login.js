import { q, handle, body, send, checkPw, hashPw, pwProblems, sign, verify, publicAccount } from './_lib.js';
const clean = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '');
const fails = new Map(); // best-effort throttle per instance

export default handle(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = body(req);
  if (b.action === 'setpw') { // forced change after temporary password
    const p = verify(b.changeToken); if (!p || p.kind !== 'change') return send(res, 401, { error: 'This step expired. Sign in again.' });
    const a = (await q(`SELECT * FROM accounts WHERE u=$1`, [p.u]))[0]; if (!a) return send(res, 401, { error: 'Account missing' });
    const bad = pwProblems(b.newPw, a.u); if (bad.length) return send(res, 400, { error: 'Password needs ' + bad.join(', ') + '.' });
    if (checkPw(b.newPw, a.hash)) return send(res, 400, { error: 'Choose a password different from the temporary one.' });
    await q(`UPDATE accounts SET hash=$1, must_change=false, last_login=now() WHERE u=$2`, [hashPw(b.newPw), a.u]);
    return send(res, 200, { token: sign({ kind: 'session', u: a.u }), user: publicAccount({ ...a, must_change: false }) });
  }
  const who = String(b.u || '').trim().toLowerCase(); const key = who + '|' + (req.headers['x-forwarded-for'] || '');
  const f = fails.get(key); if (f && f.n >= 5 && Date.now() - f.t < 30000) return send(res, 429, { error: 'Too many attempts. Try again in 30 seconds.' });
  const rows = await q(`SELECT * FROM accounts WHERE u=$1 OR lower(email)=$1 OR lower(name)=$1 OR u=$2 LIMIT 1`, [who, clean(who)]);
  const a = rows[0];
  const fail = (msg, code = 401) => { const x = fails.get(key) || { n: 0, t: 0 }; fails.set(key, { n: x.n + 1, t: Date.now() }); return send(res, code, { error: msg }); };
  if (!a) return fail(`No account “${b.u}”. Use the username HR gave you.`);
  if (!a.hash) return fail('This account has no password yet. Ask an hr_admin to set a temporary password.');
  if (!checkPw(b.p, a.hash)) return fail('Incorrect username or password.');
  if (a.status !== 'active') return fail('This account is disabled. Contact your administrator.');
  fails.delete(key);
  if (a.must_change) return send(res, 200, { mustChange: true, changeToken: sign({ kind: 'change', u: a.u }, 0.25), user: publicAccount(a) });
  await q(`UPDATE accounts SET last_login=now() WHERE u=$1`, [a.u]);
  return send(res, 200, { token: sign({ kind: 'session', u: a.u }), user: publicAccount(a) });
});

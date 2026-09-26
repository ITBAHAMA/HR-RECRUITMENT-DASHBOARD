import crypto from 'node:crypto';
import { q, handle, body, send, requireUser, hashPw, checkPw, pwProblems, publicAccount } from './_lib.js';
function tempPw() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ', a = 'abcdefghijkmnpqrstuvwxyz', d = '23456789', s = '@#$%&*!', all = A + a + d; const r = (n) => crypto.randomInt(n);
  let p = A[r(A.length)] + a[r(a.length)] + d[r(d.length)] + s[r(s.length)]; for (let i = 0; i < 6; i++) p += all[r(all.length)]; return p.split('').sort(() => r(3) - 1).join(''); }

export default handle(async (req, res) => {
  const me = await requireUser(req);
  const b = body(req);
  if (req.method === 'POST' && b.action === 'changePw') { // any signed-in user
    const a = (await q(`SELECT * FROM accounts WHERE u=$1`, [me.u]))[0];
    if (!checkPw(b.current, a.hash)) return send(res, 400, { error: 'Current password is incorrect.' });
    const bad = pwProblems(b.newPw, a.u); if (bad.length) return send(res, 400, { error: 'Password needs ' + bad.join(', ') + '.' });
    await q(`UPDATE accounts SET hash=$1, must_change=false WHERE u=$2`, [hashPw(b.newPw), a.u]); return send(res, 200, { ok: true });
  }
  if (me.role !== 'hr_admin') return send(res, 403, { error: 'hr_admin only' });
  if (req.method === 'GET') return send(res, 200, { accounts: (await q(`SELECT * FROM accounts ORDER BY created_at`)).map(publicAccount) });
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const admins = async () => (await q(`SELECT count(*)::int n FROM accounts WHERE role='hr_admin' AND status='active'`))[0].n;
  if (b.action === 'create') {
    const u = String(b.u || '').toLowerCase().trim(); if (!b.name || !/^[a-z0-9._-]{2,30}$/.test(u)) return send(res, 400, { error: 'Name and a valid username are required.' });
    if ((await q(`SELECT 1 FROM accounts WHERE u=$1`, [u])).length) return send(res, 409, { error: `The username “${u}” is already used.` });
    const tmp = tempPw();
    await q(`INSERT INTO accounts (u,name,first,email,role,bu,status,hash,must_change) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,true)`, [u, b.name, String(b.name).split(' ')[0], b.email || '', ['hr_admin', 'hr_staff', 'viewer'].includes(b.role) ? b.role : 'hr_staff', b.bu || '—', hashPw(tmp)]);
    return send(res, 200, { u, tmp });
  }
  const a = (await q(`SELECT * FROM accounts WHERE u=$1`, [b.u]))[0]; if (!a) return send(res, 404, { error: 'Account not found' });
  if (b.action === 'reset') { const tmp = tempPw(); await q(`UPDATE accounts SET hash=$1, must_change=true, status=CASE WHEN status='pending' THEN 'active' ELSE status END WHERE u=$2`, [hashPw(tmp), a.u]); return send(res, 200, { u: a.u, tmp }); }
  if (b.action === 'update') {
    const role = ['hr_admin', 'hr_staff', 'viewer'].includes(b.role) ? b.role : a.role;
    if (a.role === 'hr_admin' && role !== 'hr_admin' && (await admins()) <= 1) return send(res, 400, { error: 'Keep at least one active hr_admin.' });
    await q(`UPDATE accounts SET name=$1, first=$2, email=$3, role=$4, bu=$5 WHERE u=$6`, [b.name || a.name, String(b.name || a.name).split(' ')[0], b.email || '', role, b.bu || '—', a.u]); return send(res, 200, { ok: true });
  }
  if (b.action === 'status') {
    if (a.u === me.u) return send(res, 400, { error: 'You cannot disable your own account.' });
    if (b.status === 'disabled' && a.role === 'hr_admin' && (await admins()) <= 1) return send(res, 400, { error: 'Keep at least one active hr_admin.' });
    await q(`UPDATE accounts SET status=$1 WHERE u=$2`, [b.status === 'disabled' ? 'disabled' : 'active', a.u]); return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});

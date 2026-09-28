// Business-unit access: an account limited to some business units only sees and edits their records.
export const BU_NAMES = { br: 'BRDC', sf: 'Smartfuels', nb: 'Neo Bros Ventures', uh: 'U Hotels', th: 'Toilena Hotel', ex: 'Exelhaul Logistics', pp: 'Pan Pacific', lf: 'La Ferme Organique' };

// null = all business units. hr_admin always has all.
export function scopeOf(a) {
  if (!a || a.role === 'hr_admin') return null;
  const s = String(a.bu || '').trim();
  if (!s || s === '—' || /\ball\b/i.test(s)) return null;
  const keys = new Set();
  s.split(/[,;/|]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).forEach((x) => {
    for (const [k, n] of Object.entries(BU_NAMES)) if (x === k || x === n.toLowerCase()) keys.add(k);
  });
  return keys.size ? keys : null;
}

const arr = (x) => (Array.isArray(x) ? x : []);
function preds(d, S) {
  const jobs = arr(d.JOBS), jobBu = (id) => (jobs.find((j) => j.id === id) || {}).bu;
  const candIds = new Set(arr(d.CANDS).filter((c) => S.has(jobBu(c.job))).map((c) => c.id));
  const candNames = new Set(arr(d.CANDS).filter((c) => candIds.has(c.id)).map((c) => c.n));
  return {
    JOBS: (j) => S.has(j.bu),
    CANDS: (c) => S.has(jobBu(c.job)),
    MPR: (m) => S.has(m.bu),
    HIST: (h) => S.has(h.bu),
    INTV: (i) => (i.bu ? S.has(i.bu) : candIds.has(i.cid)),
    MSGS: (m) => (m.bu ? S.has(m.bu) : m.cid != null ? candIds.has(m.cid) : candNames.has(m.cand)),
    ACT: (a) => !a.job || S.has(jobBu(a.job)),
  };
}
const COLS = ['JOBS', 'CANDS', 'MPR', 'HIST', 'INTV', 'MSGS', 'ACT'];

// What a restricted user receives
export function viewFor(d, S) {
  if (!S) return d;
  const p = preds(d, S), v = { ...d };
  COLS.forEach((k) => { v[k] = arr(d[k]).filter(p[k]); });
  v.NOTES = Object.fromEntries(Object.entries(d.NOTES || {}).filter(([jid]) => p.JOBS({ bu: (arr(d.JOBS).find((j) => j.id === jid) || {}).bu })));
  v.BRANCHES = Object.fromEntries(Object.entries(d.BRANCHES || {}).filter(([k]) => S.has(k)));
  return v;
}

// Combine a restricted user's save with the records they cannot see
export function mergeFor(full, sub, S) {
  if (!S) return { data: sub };
  full = full || {};
  const pf = preds(full, S);
  const out = { ...full, v: sub.v || full.v };
  out.JOBS = arr(full.JOBS).filter((x) => !pf.JOBS(x)).concat(arr(sub.JOBS).filter((j) => S.has(j.bu)));
  const ps = preds({ ...sub, JOBS: out.JOBS }, S);
  out.CANDS = arr(full.CANDS).filter((x) => !pf.CANDS(x)).concat(arr(sub.CANDS).filter(ps.CANDS));
  const pm = preds({ ...sub, JOBS: out.JOBS, CANDS: out.CANDS }, S);
  ['MPR', 'HIST', 'INTV', 'MSGS', 'ACT'].forEach((k) => { out[k] = arr(full[k]).filter((x) => !pf[k](x)).concat(arr(sub[k]).filter(pm[k])); });
  out.ACT.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))); out.ACT = out.ACT.slice(0, 400);
  out.POOL = arr(sub.POOL); // the talent pool is shared by the whole group
  const jb = (jid) => (out.JOBS.find((j) => j.id === jid) || {}).bu;
  out.NOTES = { ...Object.fromEntries(Object.entries(full.NOTES || {}).filter(([jid]) => !S.has(jb(jid)))), ...Object.fromEntries(Object.entries(sub.NOTES || {}).filter(([jid]) => S.has(jb(jid)))) };
  out.BRANCHES = { ...(full.BRANCHES || {}) }; Object.entries(sub.BRANCHES || {}).forEach(([k, v]) => { if (S.has(k)) out.BRANCHES[k] = v; });
  // ids must stay unique across business units
  const dup = (list) => { const seen = new Set(); return list.some((x) => x.id != null && (seen.has(x.id) || !seen.add(x.id))); };
  if (dup(out.CANDS) || dup(out.INTV) || dup(out.MPR) || dup(out.JOBS)) return { conflict: true };
  return { data: out };
}

export function maxIds(d) {
  const mx = (l, f) => Math.max(0, ...arr(l).map(f).filter(Number.isFinite));
  return { cand: mx(d.CANDS, (c) => +c.id), intv: mx(d.INTV, (i) => +i.id), mpr: mx(d.MPR, (m) => +String(m.id || '').replace(/\D/g, '')) };
}
export const jobBuOf = (d, id) => (arr(d.JOBS).find((j) => j.id === id) || {}).bu;

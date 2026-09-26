import { q, handle, body, send, mobileKey } from './_lib.js';
// Public endpoints: GET open jobs; POST {action:'apply'} new application; POST {action:'status'} status lookup
const STAGE_TXT = { new: 'Received', screening: 'Under review', hr_int: 'Interview', dept_int: 'Interview', exam: 'Assessment', final: 'Final interview', offer: 'Job offer', reqs: 'Completing requirements', hired: 'Hired', onboarding: 'Onboarding' };
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
export default handle(async (req, res) => {
  const s = (await q(`SELECT data FROM app_state WHERE id='main'`))[0].data || {};
  if (req.method === 'GET') {
    const jobs = (s.JOBS || []).filter((j) => j.status === 'open').map((j) => ({ id: j.id, t: j.t, bu: j.bu, dept: j.dept, br: j.br, prov: j.prov, rf: j.rf, head: j.head, filled: j.filled || 0, open: j.open, status: j.status, sal: j.sal, vac: j.vac, skills: j.skills || [] }));
    return send(res, 200, { ready: true, configured: !!(s.JOBS && s.JOBS.length), jobs });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const b = body(req);
  if (b.action === 'status') {
    const qv = str(b.q, 40), mk = mobileKey(qv);
    const inCands = (s.CANDS || []).filter((c) => c.stage !== 'draft' && ((c.ref || '').toLowerCase() === qv.toLowerCase() || (mk.length >= 10 && mobileKey(c.mob) === mk)));
    const jt = (id) => ((s.JOBS || []).find((j) => j.id === id) || {}).t || 'Application';
    const out = inCands.map((c) => ({ ref: c.ref || 'C-' + (2000 + c.id), job: jt(c.job), status: STAGE_TXT[c.stage] || 'Under review', since: c.since }));
    const inbox = await q(`SELECT ref, job, created_at FROM applications WHERE lower(ref)=lower($1) OR ($2 <> '' AND mobile_key=$2)`, [qv, mk.length >= 10 ? mk : '']);
    inbox.forEach((r) => out.push({ ref: r.ref, job: jt(r.job), status: 'Received', since: new Date(r.created_at).toISOString().slice(0, 10) }));
    return send(res, 200, { results: out });
  }
  if (b.action === 'apply') {
    const a = b.app || {}; const job = (s.JOBS || []).find((j) => j.id === a.job && j.status === 'open');
    if (!job) return send(res, 400, { error: 'This position is no longer open.' });
    if (!str(a.n) || !str(a.city) || !str(a.prov) || !str(a.src)) return send(res, 400, { error: 'Please fill in all required fields.' });
    const mk = mobileKey(a.mob); if (mk.length < 10) return send(res, 400, { error: 'Enter a valid mobile number.' });
    if (!a.consent) return send(res, 400, { error: 'Consent is required.' });
    const dupState = (s.CANDS || []).some((c) => c.job === job.id && mobileKey(c.mob) === mk);
    const dupInbox = (await q(`SELECT 1 FROM applications WHERE job=$1 AND mobile_key=$2`, [job.id, mk])).length;
    if (dupState || dupInbox) return send(res, 409, { error: 'You have already applied for this job. HR will contact you soon.' });
    const clean = { n: str(a.n, 80), nick: str(a.nick, 40), mob: str(a.mob, 20), em: str(a.em, 120), city: str(a.city, 60), prov: str(a.prov, 60), job: job.id, src: str(a.src, 40), exp: str(a.exp, 2000), skills: (Array.isArray(a.skills) ? a.skills : []).slice(0, 30).map((x) => str(x, 60)), salary: str(a.salary, 20), avail: str(a.avail, 10), resume: a.resume ? str(a.resume, 120) : null };
    const row = (await q(`INSERT INTO applications (ref, job, mobile_key, data) VALUES ('pending', $1, $2, $3::jsonb) RETURNING id`, [job.id, mk, JSON.stringify(clean)]))[0];
    const ref = 'C-' + (5000 + row.id); await q(`UPDATE applications SET ref=$1 WHERE id=$2`, [ref, row.id]);
    return send(res, 200, { ref, job: job.t });
  }
  send(res, 400, { error: 'Unknown action' });
});

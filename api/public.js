import { q, handle, body, send, mobileKey, sign, verify, rateLimit } from './_lib.js';
import { cleanForm, UP_KINDS } from './_form.js';
import { providers, sendSms, sendEmail } from './_msg.js';
const MAX_BYTES = 3 * 1024 * 1024;
const OK_TYPES = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/(jpeg|png|webp|heic|heif))$/;
const BU = { br: 'BRDC', sf: 'Smartfuels', nb: 'Neo Bros Ventures', uh: 'U Hotels', th: 'Toilena Hotel', ex: 'Exelhaul Logistics', pp: 'Pan Pacific', lf: 'La Ferme Organique' };
// Public endpoints: GET open jobs; POST {action:'apply'} new application; POST {action:'status'} status lookup
const STAGE_TXT = { new: 'Received', screening: 'Under review', hr_int: 'Interview', dept_int: 'Interview', exam: 'Assessment', final: 'Final interview', offer: 'Job offer', reqs: 'Completing requirements', hired: 'Hired', onboarding: 'Onboarding' };
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
export default handle(async (req, res) => {
  const s = (await q(`SELECT data FROM app_state WHERE id='main'`))[0].data || {};
  if (req.method === 'GET') {
    const jobs = (s.JOBS || []).filter((j) => j.status === 'open').map((j) => ({ id: j.id, t: j.t, bu: j.bu, dept: j.dept, br: j.br, prov: j.prov, rf: j.rf, head: j.head, filled: j.filled || 0, open: j.open, status: j.status, sal: j.sal, vac: j.vac, skills: j.skills || [], basicForm: j.basicForm }));
    return send(res, 200, { ready: true, configured: !!(s.JOBS && s.JOBS.length), jobs });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const b = body(req);
  if (b.action === 'status') {
    await rateLimit(req, 'status', 60);
    const qv = str(b.q, 40), mk = mobileKey(qv);
    if (qv.length < 4) return send(res, 400, { error: 'Enter your reference number or mobile number.' });
    const inCands = (s.CANDS || []).filter((c) => c.stage !== 'draft' && ((c.ref || 'C-' + (2000 + c.id)).toLowerCase() === qv.toLowerCase() || (mk.length >= 10 && mobileKey(c.mob) === mk)));
    const jt = (id) => ((s.JOBS || []).find((j) => j.id === id) || {}).t || 'Application';
    const out = inCands.map((c) => ({ ref: c.ref || 'C-' + (2000 + c.id), job: jt(c.job), status: STAGE_TXT[c.stage] || 'Under review', since: c.since }));
    const inbox = await q(`SELECT ref, job, created_at FROM applications WHERE lower(ref)=lower($1) OR ($2 <> '' AND mobile_key=$2)`, [qv, mk.length >= 10 ? mk : '']);
    inbox.forEach((r) => out.push({ ref: r.ref, job: jt(r.job), status: 'Received', since: new Date(r.created_at).toISOString().slice(0, 10) }));
    return send(res, 200, { results: out });
  }
  if (b.action === 'apply') {
    await rateLimit(req, 'apply', 60);
    const a = b.app || {}; const job = (s.JOBS || []).find((j) => j.id === a.job && j.status === 'open');
    if (!job) return send(res, 400, { error: 'This position is no longer open.' });
    if (!str(a.n) || !str(a.city) || !str(a.prov) || !str(a.src)) return send(res, 400, { error: 'Please fill in all required fields.' });
    const mk = mobileKey(a.mob); if (mk.length < 10) return send(res, 400, { error: 'Enter a valid mobile number.' });
    if (!a.consent) return send(res, 400, { error: 'Consent is required.' });
    const dupState = (s.CANDS || []).some((c) => c.job === job.id && mobileKey(c.mob) === mk);
    const dupInbox = (await q(`SELECT 1 FROM applications WHERE job=$1 AND mobile_key=$2`, [job.id, mk])).length;
    if (dupState || dupInbox) return send(res, 409, { error: 'You have already applied for this job. HR will contact you soon.' });
    const file = a.file && a.file.data ? a.file : null; let fb64 = null;
    if (file) {
      fb64 = String(file.data).replace(/^data:[^,]*,/, '');
      if (fb64.length * 3 / 4 > MAX_BYTES) return send(res, 413, { error: 'Your resume file is larger than 3 MB. Please upload a smaller file or a photo of it.' });
      if (!OK_TYPES.test(String(file.type || ''))) return send(res, 400, { error: 'Resume must be a PDF, Word document or photo.' });
    }
    const clean = { n: str(a.n, 80), nick: str(a.nick, 40), mob: str(a.mob, 20), em: str(a.em, 120), city: str(a.city, 60), prov: str(a.prov, 60), job: job.id, src: str(a.src, 40), exp: str(a.exp, 2000), skills: (Array.isArray(a.skills) ? a.skills : []).slice(0, 30).map((x) => str(x, 60)), salary: str(a.salary, 20), avail: str(a.avail, 10), resume: a.file && a.file.name ? str(a.file.name, 120) : a.resume ? str(a.resume, 120) : null };
    const form = cleanForm(a.form); if (form) clean.form = true;
    const row = (await q(`INSERT INTO applications (ref, job, mobile_key, data) VALUES ('pending', $1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [job.id, mk, JSON.stringify(clean)]))[0];
    if (!row) return send(res, 409, { error: 'You have already applied for this job. HR will contact you soon.' });
    const ref = 'C-' + (5000 + row.id); await q(`UPDATE applications SET ref=$1 WHERE id=$2`, [ref, row.id]);
    if (form) await q(`INSERT INTO forms (ref, data) VALUES ($1, $2::jsonb) ON CONFLICT (ref) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [ref, JSON.stringify(form)]);
    if (file) await q(`INSERT INTO files (ref, kind, name, type, size, b64, uploaded_by) VALUES ($1,'resume',$2,$3,$4,$5,'Applicant')`, [ref, str(file.name, 120) || 'resume', String(file.type), Math.floor(fb64.length * 3 / 4), fb64]);
    // acknowledgment (only when a provider is set up; never blocks the application)
    const p = providers(), nick = clean.nick || clean.n.split(' ')[0], co = BU[job.bu] || 'BRDC';
    const ack = { sms: false, email: false };
    try {
      if (p.sms) ack.sms = (await sendSms(clean.mob, `Hi ${nick}, BRDC received your application for ${job.t} (${co}). Your reference no. is ${ref}. HR will contact you within 2 working days. - BRDC HR`, { by: 'Career page', ref })).ok;
      if (p.email && clean.em) ack.email = (await sendEmail({ to: clean.em, subject: `Application received — ${job.t} (${ref})`, text: `Hi ${nick},\n\nThank you for applying for ${job.t} at ${co}.\n\nYour reference number is ${ref}. Keep it to check your application status on our careers page.\n\nHR reviews applications within 2 working days and will contact you by text or email if you move to the interview stage.\n\n— BRDC HR` }, { by: 'Career page', ref })).ok;
    } catch (e) { /* ignore */ }
    return send(res, 200, { ref, job: job.t, ack, tok: sign({ kind: 'form', ref }, 6) });
  }

  // Application for Employment — files sent after the form (photo, ID, map, resume, signature)
  if (b.action === 'upload') {
    await rateLimit(req, 'upload', 400);
    const t = verify(String(b.tok || '')); if (!t || t.kind !== 'form') return send(res, 401, { error: 'This upload link has expired. Please contact BRDC HR.' });
    const kind = UP_KINDS.includes(b.kind) ? b.kind : null; if (!kind) return send(res, 400, { error: 'Unknown document type' });
    const f = b.file || {}; const b64 = String(f.data || '').replace(/^data:[^,]*,/, '');
    if (!b64) return send(res, 400, { error: 'Missing file' });
    if (b64.length * 3 / 4 > MAX_BYTES) return send(res, 413, { error: 'File is larger than 3 MB. Please choose a smaller file.' });
    if (!OK_TYPES.test(String(f.type || ''))) return send(res, 400, { error: 'Only PDF, Word or photo files are accepted.' });
    const n = (await q(`SELECT count(*)::int n FROM files WHERE ref=$1 AND uploaded_by='Applicant'`, [t.ref]))[0].n;
    if (n >= 12) return send(res, 429, { error: 'Too many files for this application.' });
    if (kind === 'signature' || kind === 'photo') await q(`DELETE FROM files WHERE ref=$1 AND kind=$2 AND uploaded_by='Applicant'`, [t.ref, kind]);
    await q(`INSERT INTO files (ref, kind, name, type, size, b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,'Applicant')`, [t.ref, kind, str(f.name, 120) || kind, String(f.type), Math.floor(b64.length * 3 / 4), b64]);
    return send(res, 200, { ok: true });
  }
  // Form link sent by HR to an existing candidate (walk-in, Jobstreet, imported …)
  if (b.action === 'formload' || b.action === 'formsubmit') {
    await rateLimit(req, 'form', 100);
    const t = verify(String(b.tok || '')); if (!t || t.kind !== 'formlink') return send(res, 401, { error: 'This application form link has expired or is not valid. Please ask BRDC HR for a new link.' });
    const c = (s.CANDS || []).find((x) => (x.ref || 'C-' + (2000 + x.id)) === t.ref);
    let info = c ? { n: c.n, nick: c.nick, mob: c.mob, em: c.em, job: c.job } : null;
    if (!info) { const a = (await q(`SELECT job, data FROM applications WHERE ref=$1`, [t.ref]))[0]; if (a) info = { n: a.data.n, nick: a.data.nick, mob: a.data.mob, em: a.data.em, job: a.job }; }
    if (!info) return send(res, 404, { error: 'Application not found. Please contact BRDC HR.' });
    const j = (s.JOBS || []).find((x) => x.id === info.job) || {};
    if (b.action === 'formload') {
      const done = (await q(`SELECT updated_at FROM forms WHERE ref=$1`, [t.ref]))[0];
      return send(res, 200, { ref: t.ref, n: info.n, nick: info.nick, mob: info.mob, em: info.em, job: { id: j.id, t: j.t, bu: j.bu, dept: j.dept, br: j.br, basicForm: j.basicForm }, submittedAt: done ? done.updated_at : null });
    }
    const form = cleanForm(b.form); if (!form) return send(res, 400, { error: 'The form is empty.' });
    await q(`INSERT INTO forms (ref, data) VALUES ($1, $2::jsonb) ON CONFLICT (ref) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [t.ref, JSON.stringify(form)]);
    return send(res, 200, { ref: t.ref, job: j.t || 'your application', tok: sign({ kind: 'form', ref: t.ref }, 6) });
  }
  send(res, 400, { error: 'Unknown action' });
});

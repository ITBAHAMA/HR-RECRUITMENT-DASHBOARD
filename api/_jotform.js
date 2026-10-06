import { q, mobileKey } from './_lib.js';
import { cleanForm } from './_form.js';
// Brings Jotform "Application for Employment" submissions into BRDC Recruit (as new applications with the full form + files).
// Settings (Vercel → Environment Variables): JOTFORM_API_KEY, optional JOTFORM_FORM_ID, optional JOTFORM_API_HOST (eu-api.jotform.com for EU accounts).
export const jotConfig = () => ({ key: String(process.env.JOTFORM_API_KEY || '').trim(), form: String(process.env.JOTFORM_FORM_ID || '260282284429460').trim(), host: String(process.env.JOTFORM_API_HOST || 'api.jotform.com').replace(/^https?:\/\//, '').replace(/\/$/, '') });
const getKv = async (k) => ((await q(`SELECT v FROM kv WHERE k=$1`, [k]))[0] || {}).v || null;
const setKv = (k, v) => q(`INSERT INTO kv (k, v, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, updated_at=now()`, [k, JSON.stringify(v)]);
export const jotStatus = () => getKv('jot:status');
const MAX = 3 * 1024 * 1024;
const OK_TYPES = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/(jpeg|png|webp|heic|heif))$/;
const norm = (s) => String(s || '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/^\s*[\divx]+[.)]\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// label → our field key (first match wins). Order matters for the generic emergency-contact labels.
const MAP = [
  [/^position applied/, 'position'], [/^department$/, 'department'], [/^date of application/, 'app_date', 'date'], [/^expected salary/, 'salary'],
  [/how did you learn/, 'source', 'list'], [/^photo/, 'photo', 'file'],
  [/^full ?name/, 'name', 'name'], [/preferred name|nickname/, 'nick'], [/^date of birth|^birth ?date/, 'dob', 'date'], [/^place of birth/, 'pob'],
  [/^sex/, 'sex'], [/^gender identity/, 'gender'], [/self describe/, 'gender_other'], [/^civil status/, 'civil'], [/^you live with/, 'livewith'],
  [/common law/, 'commonlaw', 'text'], [/^nationality/, 'nationality'], [/^mobile/, 'mobile'], [/^home address/, 'addr', 'addr'], [/^provincial address/, 'prov_addr', 'text'],
  [/^e ?mail/, 'email'], [/^religion/, 'religion'], [/^height/, 'height'], [/^weight/, 'weight'], [/^sss/, 'sss'], [/^tin\b/, 'tin'], [/^philhealth/, 'philhealth'],
  [/^pag ?ibig/, 'pagibig'], [/^passport/, 'passport'], [/government id/, 'gid', 'gid'], [/valid id/, 'valid_id', 'file'],
  [/family information|^family$/, 'family', 'table'], [/^dependents?/, 'dependents', 'table'], [/educational background|^education/, 'education', 'table'], [/employment history/, 'employment', 'table'],
  [/date available/, 'start', 'date'], [/physically fit/, 'fit'], [/other group compan/, 'group'], [/transferred/, 'transfer'], [/willing to work in\b/, 'work_in', 'list'], [/willing to work on\b/, 'work_on', 'list'],
  [/overtime/, 'ot'], [/night ?shift/, 'night'], [/limitation|restriction/, 'limit'], [/going abroad|application abroad/, 'abroad'], [/pending application to other compan/, 'othercos'],
  [/terminated|dismissed/, 'terminated'], [/accused|convicted/, 'accused'], [/bond|non compete/, 'bond'], [/relatives or close friends/, 'relatives'],
  [/location screenshot|google maps/, 'location_map', 'file'], [/resume|curriculum/, 'resume', 'file'],
  [/hard skills/, 'hard', 'list'], [/soft skills/, 'soft', 'list'], [/computer skills|system knowledge/, 'computer'], [/licenses|certifications/, 'licenses'], [/trainings|seminars/, 'trainings'],
  [/^spoken/, 'lang_spoken'], [/^dialect/, 'lang_dialect'], [/^written/, 'lang_written'], [/membership/, 'membership'], [/hobbies|outside interest/, 'hobbies'],
  [/pregnant/, 'med_preg'], [/surgery|hospitali/, 'med_surg'], [/taking any medication|medical treatment/, 'med_meds'], [/medical condition that may require|accommodation/, 'med_cond'], [/consultation|therapy|psychological/, 'med_psych'],
  [/brdc ?ref/, 'brdcRef'], [/references?/, 'refs', 'table'], [/acknowledg/, 'ack', 'ack'], [/signature/, 'signature', 'file'],
];
const NAME_MAP = { positionApplied: ['position'], department: ['department'], dateOf: ['app_date', 'date'], expectedSalary: ['salary'], howDid: ['source', 'list'],
  fullName: ['name', 'name'], preferredName: ['nick'], dateOf410: ['dob', 'date'], sexAssigned: ['sex'], gender470: ['gender'], civilStatus: ['civil'], youLive: ['livewith'],
  pleaseType: ['gender_other'], pleaseType474: ['commonlaw', 'text'], mobileNumber: ['mobile'], governmentId: ['gid', 'gid'],
  familyBackground: ['family', 'table'], familyBackground414: ['dependents', 'table'], educationalBackground: ['education', 'table'], typeA363: ['employment', 'table'],
  educationalBackground376: ['refs', 'table'], dataPrivacy: ['ack', 'ack'], applicantSignature: ['signature', 'file'], dateAvailable: ['start', 'date'],
  name: ['em_name'], relationship: ['em_rel'], contactNumber: ['em_mob'], address: ['em_addr'], brdcRef: ['brdcRef'] };
const EMERG = { 'name': 'em_name', 'relationship': 'em_rel', 'contact number': 'em_mob', 'contact no': 'em_mob', 'address': 'em_addr' };
const FOLLOW = /^(if yes|please (type|specify|explain))/;
const TABLES = {
  family: { rows: ['father', 'mother', 'spouse', 'sibling', 'sibling', 'sibling'], cols: ['name', 'age', 'occupation', 'employer'] },
  dependents: { n: 4, cols: ['full name', 'relationship', 'age', 'occupation'] },
  education: { rows: ['elementary', 'high school', 'college', 'graduate', 'vocational'], cols: ['school', 'from', 'to', 'degree', 'major'] },
  employment: { n: 5, cols: ['name', 'period', 'position', 'gross', 'reason'] },
  refs: { n: 3, cols: ['name', 'address', 'occupation', 'contact', 'company'] },
};
function asText(a) {
  if (a == null) return '';
  if (typeof a === 'string') return a.trim();
  if (Array.isArray(a)) return a.map(asText).filter(Boolean).join(', ');
  if (typeof a === 'object') return Object.values(a).map(asText).filter(Boolean).join(' ');
  return String(a);
}
function asDate(a, pretty) {
  if (a && typeof a === 'object' && a.year) return `${a.year}-${String(a.month || 1).padStart(2, '0')}-${String(a.day || 1).padStart(2, '0')}`;
  const s = asText(pretty || a); const m = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const iso = s.match(/\d{4}-\d{2}-\d{2}/); return iso ? iso[0] : s;
}
function asList(a) { if (Array.isArray(a)) return a.map(asText).filter(Boolean); if (a && typeof a === 'object') return Object.values(a).map(asText).filter(Boolean); return asText(a).split(/\r?\n|,\s*(?=[A-Z])/).map((x) => x.trim()).filter(Boolean); }
function asTable(a, def) {
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return []; } }
  if (!a || typeof a !== 'object') return [];
  const colIdx = (k, i) => { const n = norm(k); const j = def.cols.findIndex((c) => n.includes(c)); return j >= 0 ? j : i; };
  const toRow = (r) => { const out = []; if (Array.isArray(r)) r.forEach((v, i) => { out[i] = asText(v); }); else if (r && typeof r === 'object') Object.entries(r).forEach(([k, v], i) => { out[colIdx(k, i)] = asText(v); }); else out[0] = asText(r); return out; };
  const rows = Array.isArray(a) ? a.map(toRow) : Object.entries(a).map(([k, v]) => ({ label: norm(k), row: toRow(v) }));
  if (Array.isArray(a)) return rows.filter((r) => r.some(Boolean));
  const res = []; const used = new Set();
  rows.forEach(({ label, row }, i) => {
    let at = -1; if (def.rows) def.rows.forEach((rl, j) => { if (at < 0 && !used.has(j) && label.includes(rl)) at = j; });
    if (at < 0) { at = /^\d+$/.test(label) ? +label - 1 : i; while (used.has(at)) at++; }
    used.add(at); res[at] = row;
  });
  for (let i = 0; i < res.length; i++) if (!res[i]) res[i] = [];
  return res;
}
const PROVS = ['Laguna', 'Cavite', 'Batangas', 'Rizal', 'Bulacan', 'Pampanga', 'Tarlac', 'Nueva Ecija', 'Pangasinan', 'Zambales', 'Bataan', 'Quezon', 'Cebu', 'Davao', 'Iloilo', 'Bohol', 'Leyte', 'Albay', 'Camarines Sur', 'Isabela', 'Cagayan', 'La Union', 'Benguet', 'Palawan', 'Metro Manila', 'NCR'];
const NCR = ['Quezon City', 'Manila', 'Makati', 'Pasig', 'Taguig', 'Caloocan', 'Marikina', 'Parañaque', 'Paranaque', 'Las Piñas', 'Las Pinas', 'Muntinlupa', 'Mandaluyong', 'San Juan', 'Valenzuela', 'Malabon', 'Navotas', 'Pasay', 'Pateros'];
function splitAddr(a) {
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const line = [a.addr_line1, a.addr_line2].filter(Boolean).join(', ');
    return { addr: line || asText(a), city: asText(a.city), prov: asText(a.state) };
  }
  const s = asText(a); const low = s.toLowerCase(); const ncr = NCR.find((c) => low.includes(c.toLowerCase()));
  if (ncr) return { addr: s, city: ncr, prov: 'NCR' };
  const pv = PROVS.slice().sort((x, y) => y.length - x.length).find((p) => new RegExp('\\b' + p + '\\b', 'i').test(s));
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (pv) { const i = parts.findIndex((x) => new RegExp('\\b' + pv + '\\b', 'i').test(x)); return { addr: s, city: i > 0 ? parts[i - 1].replace(/^city of\s+/i, '') : '', prov: pv }; }
  return { addr: s, city: parts.length > 1 ? parts[parts.length - 1] : '', prov: '' };
}

/* Turn one Jotform submission into our form object + list of file URLs */
export function mapSubmission(sub) {
  const ans = Object.values(sub.answers || {}).filter((x) => x && (x.text || x.name) && !/control_(head|text|button|image|pagebreak|divider|collapse)$/.test(x.type || ''))
    .sort((a, b) => (+a.order || 0) - (+b.order || 0));
  const f = { _v: 1, _source: 'Jotform', _jotform: { id: sub.id, created: sub.created_at } }, files = [], other = [];
  let lastKey = null, inEmergency = false;
  for (const x of ans) {
    const label = norm(x.text || x.name), raw = x.answer, pretty = x.prettyFormat, byName = NAME_MAP[x.name];
    if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) { const m0 = MAP.find(([re]) => re.test(label)); if (m0 && m0[2] !== 'file') lastKey = m0[1]; continue; }
    if (byName) { const [k0, kd0] = byName; if (kd0 !== 'file') lastKey = k0; }
    if (/references?/.test(label)) inEmergency = false;
    if (!byName && (inEmergency || ((f.refs || lastKey === 'refs') && EMERG[label] && !f[EMERG[label]]))) { const k = EMERG[label]; if (k) { f[k] = asText(raw); inEmergency = true; continue; } }
    const m = byName ? [null, byName[0], byName[1]] : MAP.find(([re]) => re.test(label));
    if (!byName && FOLLOW.test(label) && lastKey && !(m && /^(commonlaw|gender_other)$/.test(m[1]))) { f[lastKey + '_x'] = asText(raw); continue; }
    if (!m && /fileupload/.test(x.type || '')) { const k = f._files && f._files.includes('photo') ? 'other' : 'photo'; asList(raw).filter((u) => /^https?:\/\//.test(u)).forEach((u) => files.push({ kind: k, url: u })); f._files = [...new Set([...(f._files || []), k])]; continue; }
    if (!m) { other.push([x.text.replace(/<[^>]+>/g, '').trim(), asText(pretty || raw)]); continue; }
    const [, key, kind] = m;
    if (kind === 'file') { asList(raw).filter((u) => /^https?:\/\//.test(u)).forEach((u) => files.push({ kind: key, url: u })); f._files = [...new Set([...(f._files || []), key])]; continue; }
    if (kind === 'name') { const o = typeof raw === 'object' ? raw : {}; f.name = typeof raw === 'object' ? { first: asText(o.first), middle: asText(o.middle), last: asText(o.last) } : (() => { const p = asText(raw).split(/\s+/); return { first: p.slice(0, -1).join(' ') || p[0], middle: '', last: p.length > 1 ? p[p.length - 1] : '' }; })(); }
    else if (kind === 'date') f[key] = asDate(raw, pretty);
    else if (kind === 'list') f[key] = asList(raw);
    else if (kind === 'table') f[key] = asTable(raw, TABLES[key]);
    else if (kind === 'addr') Object.assign(f, (({ addr, city, prov }) => ({ addr, city, prov }))(splitAddr(raw)));
    else if (kind === 'gid') { if (typeof raw === 'object') { const v = Object.values(raw).map(asText); f.gid_type = v[0] || ''; f.gid_no = v[1] || ''; } else f.gid_type = asText(raw); }
    else if (kind === 'ack') f.ack = !!asText(raw);
    else f[key] = asText(kind === 'text' ? raw : (typeof raw === 'object' ? raw : raw));
    lastKey = key;
  }
  if (other.length) f._other = other.slice(0, 60);
  return { form: f, files };
}

function summary(f) {
  const nm = f.name || {}, n = [nm.first, nm.middle, nm.last].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  const srcMap = { 'company website walkin': 'Career page', 'job fair': 'Job fair', facebook: 'Facebook', indeed: 'Indeed', jobstreet: 'Jobstreet', referral: 'Referral' };
  const s0 = (f.source || [])[0]; const src = (s0 && srcMap[norm(s0)]) || (s0 && s0 !== 'Other' ? s0 : 'Jotform');
  const exp = (f.employment || []).filter((r) => r && String(r[0] || '').trim()).map((r) => `${r[2] || '—'} – ${r[0]}${r[1] ? ` (${r[1]})` : ''}`).join('\n');
  const skills = [...new Set([...(f.hard || []), ...(f.soft || [])].filter((x) => x && x !== 'Other'))];
  return { n, nick: String(f.nick || '').trim() || String(nm.first || '').split(' ')[0], mob: String(f.mobile || '').trim(), em: String(f.email || '').trim(), city: f.city || '—', prov: f.prov || '', src, exp: exp || '—', skills, salary: String(f.salary || ''), avail: f.start || '' };
}
function matchJob(jobs, f) {
  const open = jobs.filter((j) => j.status === 'open'), p = norm(f.position), d = norm(f.department);
  if (p) {
    const exact = open.filter((j) => norm(j.t) === p && j.rf !== 'general');
    if (exact.length) return exact.find((j) => d && norm(j.dept) === d) || exact[0];
    const part = open.find((j) => j.rf !== 'general' && (p.includes(norm(j.t)) || norm(j.t).includes(p)));
    if (part) return part;
  }
  return null;
}
async function fetchFile(url, key) {
  const u = new URL(url); if (/jotform\.(com|eu)$/.test(u.hostname) && key) u.searchParams.set('apiKey', key);
  const r = await fetch(u, { redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > MAX) throw new Error('larger than 3 MB');
  let type = (r.headers.get('content-type') || '').split(';')[0].trim();
  const name = decodeURIComponent(u.pathname.split('/').pop() || 'file').slice(0, 120);
  if (!OK_TYPES.test(type)) { const ext = name.split('.').pop().toLowerCase(); type = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[ext] || type; }
  if (!OK_TYPES.test(type)) throw new Error('unsupported file type');
  return { name, type, b64: buf.toString('base64'), size: buf.length };
}

async function api(cfg, path) {
  if (globalThis.__mockJotform) return globalThis.__mockJotform(path); // local tests only
  const r = await fetch(`https://${cfg.host}${path}${path.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(cfg.key)}`);
  let j = {}; try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok || (j.responseCode && j.responseCode !== 200)) throw new Error(j.message || ('Jotform answered ' + r.status));
  return j;
}

/* An applicant HR already added (walk-in, referral …) and sent the Jotform link to: same reference, mobile, email or name */
const refOfC = (c) => c.ref || 'C-' + (2000 + c.id);
const nk = (x) => norm(x).replace(/\b(jr|sr|ii|iii)\b/g, '').replace(/\s+/g, ' ').trim();
async function findExisting(s, form, sm, mk) {
  const cands = (s.CANDS || []).filter((c) => c.stage !== 'draft');
  const pick = (l) => l.sort((a, b) => String(b.jotSent || '').localeCompare(String(a.jotSent || '')) || String(b.applied || '').localeCompare(String(a.applied || '')))[0];
  const bref = String(form.brdcRef || '').trim().toUpperCase();
  let c = bref && cands.find((x) => refOfC(x).toUpperCase() === bref);
  if (!c && mk.length >= 10) c = pick(cands.filter((x) => mobileKey(x.mob) === mk));
  if (!c && sm.em) c = pick(cands.filter((x) => (x.em || '').toLowerCase() === sm.em.toLowerCase()));
  if (!c) { const nm = form.name || {}, full = nk(sm.n), fl = nk(`${nm.first || ''} ${nm.last || ''}`), fw = fl.split(' ');
    c = pick(cands.filter((x) => { if (!x.jotSent) return false; const cn = nk(x.n); if (!cn) return false; const cw = cn.split(' ');
      return cn === full || cn === fl || (cw[0] === fw[0] && cw[cw.length - 1] === fw[fw.length - 1]); })); }
  if (c) return { ref: refOfC(c) };
  if (mk.length >= 10) { const a = (await q(`SELECT ref FROM applications WHERE mobile_key=$1 AND ref <> 'pending' ORDER BY id DESC LIMIT 1`, [mk]))[0]; if (a) return { ref: a.ref }; }
  return null;
}
async function attach(ref, form, files, cfg, out) {
  const missing = [];
  for (const fl of files.slice(0, 8)) {
    try { const d = await fetchFile(fl.url, cfg.key);
      if (fl.kind === 'photo' || fl.kind === 'signature') await q(`DELETE FROM files WHERE ref=$1 AND kind=$2 AND uploaded_by='Jotform'`, [ref, fl.kind]);
      await q(`INSERT INTO files (ref, kind, name, type, size, b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,'Jotform')`, [ref, fl.kind, d.name, d.type, d.size, d.b64]); }
    catch (e) { missing.push({ kind: fl.kind, url: fl.url, why: String(e.message || e).slice(0, 80) }); }
  }
  if (missing.length) form._missing = missing;
  form._attached = true;
  await q(`INSERT INTO forms (ref, data) VALUES ($1, $2::jsonb) ON CONFLICT (ref) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [ref, JSON.stringify(cleanForm(form))]);
}

/* Import new submissions. all=true walks back through every past submission (in pages). */
export async function syncJotform({ all = false, max = 8, offset = 0 } = {}) {
  const cfg = jotConfig(); if (!cfg.key) return { configured: false };
  const st = (await jotStatus()) || {}; const started = Date.now();
  const out = { configured: true, imported: 0, skipped: 0, errors: [], done: true, offset };
  try {
    const page = await api(cfg, `/form/${cfg.form}/submissions?limit=${all ? 50 : 30}&offset=${all ? offset : 0}&orderby=created_at`);
    const subs = (page.content || []).filter((s) => s.status !== 'DELETED');
    out.total = page.resultSet ? page.resultSet.count : subs.length;
    const s = (await q(`SELECT data FROM app_state WHERE id='main'`))[0].data || {}; const jobs = s.JOBS || [];
    const gen = jobs.find((j) => j.rf === 'general' && j.status === 'open') || jobs.find((j) => j.rf === 'general');
    let processed = 0;
    for (const sub of subs) {
      if (out.imported + (out.attached || 0) >= max || Date.now() - started > 40000) { out.done = false; break; }
      const seen = await q(`INSERT INTO reminders (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`, ['jot:' + sub.id]);
      processed++;
      if (!seen.length) { out.skipped++; continue; }
      try {
        const { form, files } = mapSubmission(sub); const sm = summary(form); const jm = matchJob(jobs, form); const job = jm || gen;
        if (!job) { await q(`DELETE FROM reminders WHERE key=$1`, ['jot:' + sub.id]); out.errors.push(`#${sub.id}: no open job matches “${form.position || '?'}” and there is no general application job`); continue; }
        const mk = mobileKey(sm.mob); const dupKey = mk.length >= 10 ? mk : sm.em ? 'e:' + sm.em.toLowerCase() : 'j:' + sub.id;
        const hit = await findExisting(s, form, sm, mk);
        if (hit) { await attach(hit.ref, form, files, cfg, out); out.attached = (out.attached || 0) + 1; continue; }
        const dupState = (s.CANDS || []).some((c) => c.job === job.id && ((mk.length >= 10 && mobileKey(c.mob) === mk) || (sm.em && (c.em || '').toLowerCase() === sm.em.toLowerCase())));
        if (dupState) { out.skipped++; continue; }
        const data = { ...sm, n: sm.n || 'Jotform applicant', job: job.id, form: true, review: true, via: 'Jotform', viaAt: sub.created_at ? new Date(String(sub.created_at).replace(' ', 'T') + '+08:00').toISOString() : new Date().toISOString(), jobGuess: !!jm, resume: null,
          inNote: `Imported from Jotform (submission ${sub.id}, ${sub.created_at || ''})${jm ? '' : ` — position “${form.position || '?'}” not matched, placed in ${job.t}`}.` };
        const row = (await q(`INSERT INTO applications (ref, job, mobile_key, data) VALUES ('pending',$1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [job.id, dupKey, JSON.stringify(data)]))[0];
        if (!row) { out.skipped++; continue; }
        const ref = 'C-' + (5000 + row.id); await q(`UPDATE applications SET ref=$1 WHERE id=$2`, [ref, row.id]);
        const missing = [];
        for (const fl of files.slice(0, 8)) {
          try { const d = await fetchFile(fl.url, cfg.key); await q(`INSERT INTO files (ref, kind, name, type, size, b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,'Jotform')`, [ref, fl.kind, d.name, d.type, d.size, d.b64]);
            if (fl.kind === 'resume') await q(`UPDATE applications SET data = jsonb_set(data, '{resume}', to_jsonb($1::text)) WHERE id=$2`, [d.name, row.id]); }
          catch (e) { missing.push({ kind: fl.kind, url: fl.url, why: String(e.message || e).slice(0, 80) }); }
        }
        if (missing.length) form._missing = missing;
        await q(`INSERT INTO forms (ref, data) VALUES ($1, $2::jsonb) ON CONFLICT (ref) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [ref, JSON.stringify(cleanForm(form))]);
        out.imported++;
      } catch (e) { await q(`DELETE FROM reminders WHERE key=$1`, ['jot:' + sub.id]); out.errors.push(`#${sub.id}: ${String(e.message || e).slice(0, 120)}`); }
    }
    if (all) { out.offset = offset + (out.done ? subs.length : processed); out.done = out.done && subs.length < 50; }
    await setKv('jot:status', { ok: true, at: new Date().toISOString(), lastImported: out.imported ? new Date().toISOString() : st.lastImported || null, totalImported: (st.totalImported || 0) + out.imported, totalAttached: (st.totalAttached || 0) + (out.attached || 0), total: out.total, errors: out.errors.slice(0, 5), form: cfg.form });
  } catch (e) {
    out.error = String(e.message || e).slice(0, 200);
    await setKv('jot:status', { ...st, ok: false, at: new Date().toISOString(), error: out.error, form: cfg.form });
  }
  return out;
}

import { q, handle, body, send, mobileKey, derivedKey } from './_lib.js';
// Receives application notification emails from Indeed / Jobstreet (forwarded by a Gmail script,
// Power Automate, or an inbound-email service such as Postmark) and turns them into new applications.
const MAX = 3 * 1024 * 1024;
const OK_TYPES = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/(jpeg|png|webp|heic|heif))$/;
const guess = (n) => ({ pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' })[(String(n).split('.').pop() || '').toLowerCase()] || '';
const strip = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/(^|[\s-])([a-zñ])/g, (m, a, b) => a + b.toUpperCase());

// Accept Postmark's inbound JSON, or a simple {from, subject, text, html, attachments:[{name,type,data}]} shape
function normalise(b) {
  if (b.Subject !== undefined || b.TextBody !== undefined) return { id: b.MessageID, from: b.From || '', subject: b.Subject || '', text: b.TextBody || '', html: b.HtmlBody || '',
    attachments: (b.Attachments || []).map((a) => ({ name: a.Name, type: a.ContentType, data: a.Content })) };
  return { id: b.id, from: b.from || '', subject: b.subject || '', text: b.text || '', html: b.html || '', attachments: b.attachments || [] };
}

export function parseApplication(m, jobs) {
  const text = (m.text && m.text.trim().length > 40 ? m.text : strip(m.html) || m.text || '').slice(0, 20000);
  const all = `${m.from}\n${m.subject}\n${text}`, low = all.toLowerCase();
  const src = /indeed/.test(low) ? 'Indeed' : /jobstreet|seek\.com/.test(low) ? 'Jobstreet' : /linkedin/.test(low) ? 'LinkedIn' : /kalibrr/.test(low) ? 'Kalibrr' : 'Email';
  // job: longest open job title found in the subject, then in the text
  const open = jobs.filter((j) => j.status === 'open' && j.rf !== 'general');
  const find = (hay) => { const h = ' ' + norm(hay) + ' '; let best = null;
    for (const j of open) { const t = norm(j.t); if (t && h.includes(' ' + t + ' ')) { const brHit = j.br && h.includes(norm(j.br)); const score = t.length + (brHit ? 50 : 0); if (!best || score > best.s) best = { j, s: score }; } }
    return best && best.j; };
  const job = find(m.subject) || find(text.slice(0, 3000)) || null;
  // name — capitalised words, stopping at words like "for", "applied", "has"
  const STOP = new Set(['for', 'to', 'has', 'have', 'applied', 'is', 'in', 'at', 'the', 'via', 'on', 'and', 'from', 'mobile', 'email', 'phone', 'location', 'view', 'new']);
  const cleanName = (raw) => { const out = []; for (const t of String(raw || '').split(/[ \t]+/)) { if (!t || STOP.has(t.toLowerCase()) || !/^[A-ZÑ][A-Za-zñÑ.'-]*$/.test(t)) break; out.push(t); if (out.length === 5) break; }
    const n = out.join(' ').replace(/[.,]+$/, ''); return out.length >= 2 && !/indeed|jobstreet|seek|brdc|hiring|team|employer/i.test(n) ? n : ''; };
  const pats = [
    /(?:[Aa]pplication|[Aa]pplicant|[Cc]andidate)[ \t]*(?:from|:|-)[ \t]*([^\n]{3,80})/,
    /(?:^|\n)[ \t]*([A-ZÑ][^\n]{3,80}?)[ \t]+(?:has[ \t]+)?applied\b/,
    /\b(?:[Aa]pplicant|[Cc]andidate|[Nn]ame|[Ff]ull [Nn]ame)[ \t]*[:\-][ \t]*([^\n]{3,80})/,
    /\b(?:from|by)[ \t]+([A-ZÑ][^\n]{3,80})/,
  ];
  let name = '';
  for (const p of pats) { for (const hay of [m.subject, text]) { const r = hay.match(p); const n = r && cleanName(r[1]); if (n) { name = n; break; } } if (name) break; }
  if (!name) { const f = (m.attachments || []).find((a) => /pdf|doc|word/i.test(a.type || a.name || '')); if (f) { const base = String(f.name).replace(/\.\w+$/, '').replace(/[_\-.]+/g, ' ').replace(/\b(resume|cv|curriculum vitae|application|updated|final|\d+)\b/gi, ' ').trim(); if (/^[a-zñ ]{3,60}$/i.test(base) && base.split(' ').length >= 2) name = titleCase(base); } }
  // contact details (Indeed relay addresses like …@indeedemail.com are kept, they forward to the applicant)
  const emails = (all.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).filter((e) => !/@(indeed\.com|[\w.-]*jobstreet\.[\w.]+|[\w.-]*seek\.[\w.]+|brdc\.ph|linkedin\.com|kalibrr\.com|[\w.-]*google\.com|gmail-noreply)|no-?reply|donotreply|notification|alerts?@|jobs?@/i.test(e));
  const phone = (text.match(/(?:\+?63|0)\s?9\d{2}[\s-]?\d{3}[\s-]?\d{4}/) || [])[0] || '';
  const loc = (text.match(/(?:^|\n)\s*(?:location|address|city)\s*[:\-]\s*([^\n]{2,60})/i) || [])[1] || '';
  return { src, job, name, email: emails[0] || '', phone: phone.replace(/\s+/g, ' '), city: loc.split(',')[0].trim(), prov: (loc.split(',')[1] || '').trim(), text };
}

export default handle(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const key = new URL(req.url || '/', 'http://x').searchParams.get('key') || '';
  if (!key || key !== (process.env.INBOUND_KEY || derivedKey('inbound'))) return send(res, 401, { error: 'Invalid key' });
  const m = normalise(body(req));
  if (!m.subject && !m.text && !m.html) return send(res, 400, { error: 'Empty email' });
  const mid = String(m.id || `${m.from}|${m.subject}|${(m.text || m.html).length}`).slice(0, 300);
  const seen = await q(`INSERT INTO reminders (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`, ['mail:' + mid]);
  if (!seen.length) return send(res, 200, { skipped: 'Already imported' });
  // job-seeker emails (job alerts / recommendations) are not applications — ignore them
  if (/job alert|job recommendations?|recommended jobs|jobs? for you|\+\s*\d+\s+new jobs|new jobs? (?:match|near)|we've got new job|saved search/i.test(`${m.subject}\n${String(m.text || strip(m.html)).slice(0, 600)}`)) return send(res, 200, { skipped: 'Job alert, not an application' });
  const s = (await q(`SELECT data FROM app_state WHERE id='main'`))[0].data || {};
  const jobs = s.JOBS || [];
  const p = parseApplication(m, jobs);
  if (!/indeed|jobstreet|seek|linkedin|kalibrr|appl(y|ied|icant|ication)|candidate|resume|cv\b/i.test(`${m.from} ${m.subject} ${p.text.slice(0, 2000)}`)) return send(res, 200, { skipped: 'Not an application email' });
  const job = p.job || jobs.find((j) => j.rf === 'general' && j.status === 'open') || jobs.find((j) => j.id === 'GEN-SF') || jobs[0];
  if (!job) return send(res, 400, { error: 'No jobs set up yet' });
  const mk = mobileKey(p.phone);
  const dupKey = mk.length >= 10 ? mk : p.email ? 'e:' + p.email.toLowerCase() : 'm:' + mid.slice(-40);
  if ((await q(`SELECT 1 FROM applications WHERE job=$1 AND mobile_key=$2`, [job.id, dupKey])).length || (s.CANDS || []).some((c) => c.job === job.id && ((mk.length >= 10 && mobileKey(c.mob) === mk) || (p.email && (c.em || '').toLowerCase() === p.email.toLowerCase()))))
    return send(res, 200, { skipped: 'Applicant already in BRDC Recruit' });
  const files = (m.attachments || []).map((a) => ({ name: String(a.name || 'file').slice(0, 120), type: a.type && OK_TYPES.test(a.type) ? a.type : guess(a.name), data: String(a.data || '').replace(/^data:[^,]*,/, '') }))
    .filter((a) => OK_TYPES.test(a.type) && a.data && a.data.length * 3 / 4 <= MAX && !/logo|banner|icon|image\d{3}/i.test(a.name));
  const resume = files.find((f) => /pdf|word/.test(f.type)) || files[0];
  const note = `Imported from ${p.src} email${p.job ? '' : ' — position not recognised, please set the correct job'}.\nSubject: ${m.subject}\n\n${p.text.slice(0, 1500)}`;
  const data = { n: p.name || `${p.src} applicant (check email)`, nick: (p.name || '').split(' ')[0], mob: p.phone, em: p.email, city: p.city || '—', prov: p.prov || '', job: job.id, src: p.src,
    exp: '—', skills: [], resume: resume ? resume.name : null, review: true, inNote: note, jobGuess: !!p.job };
  const row = (await q(`INSERT INTO applications (ref, job, mobile_key, data) VALUES ('pending',$1,$2,$3::jsonb) RETURNING id`, [job.id, dupKey, JSON.stringify(data)]))[0];
  const ref = 'C-' + (5000 + row.id); await q(`UPDATE applications SET ref=$1 WHERE id=$2`, [ref, row.id]);
  for (const f of files.slice(0, 5)) await q(`INSERT INTO files (ref, kind, name, type, size, b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ref, f === resume ? 'resume' : 'Other', f.name, f.type, Math.floor(f.data.length * 3 / 4), f.data, p.src + ' email']);
  return send(res, 200, { ok: true, ref, job: job.id, name: data.n, source: p.src, matchedJob: !!p.job, files: files.length });
});

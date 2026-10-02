import { q, mobileKey } from './_lib.js';
// Turns Indeed / Jobstreet application notification emails into new applications.
// Used by /api/inbound (forwarded emails) and /api/mailcheck (reads the Zoho mailbox).
const MAX = 3 * 1024 * 1024;
const OK_TYPES = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/(jpeg|png|webp|heic|heif))$/;
const guess = (n) => ({ pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' })[(String(n).split('.').pop() || '').toLowerCase()] || '';
const strip = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/(^|[\s-])([a-zñ])/g, (m, a, b) => a + b.toUpperCase());

// Accept Postmark's inbound JSON, or a simple {from, subject, text, html, attachments:[{name,type,data}]} shape
export function normalise(b) {
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
  const PLACE = /\b(city|province|municipality|metro|manila|makati|quezon|pasig|taguig|laguna|cavite|batangas|rizal|bulacan|pampanga|cebu|davao|ncr|philippines|calabarzon|region|branch|head office|full[- ]time|part[- ]time)\b/i;
  const places = new Set(jobs.flatMap((j) => [norm(j.br), norm(j.prov), norm(j.city)]).filter(Boolean));
  const others = +((m.subject + '\n' + text).match(/\band\s+(\d+)\s+others?\s+applied/i) || [])[1] || 0;
  const extra = [];
  if (others && name) { const bad = /^(qualifications?|indeed|see |view |job |location|bachelor|managerial|hi |dear |regards)/i;
    for (const line of text.split('\n').map((l) => l.trim())) { if (extra.length >= others) break;
      if (!/^[A-ZÑ][A-Za-zñÑ.'-]*(?:[ \t]+[A-ZÑ][A-Za-zñÑ.'-]*){1,4}$/.test(line) || bad.test(line) || line.includes('•') || PLACE.test(line) || places.has(norm(line))) continue;
      const n = cleanName(line); if (n && n.toLowerCase() !== name.toLowerCase() && !open.some((j) => norm(j.t) === norm(n)) && !extra.some((x) => x.toLowerCase() === n.toLowerCase())) extra.push(n); } }
  if (!name) { const f = (m.attachments || []).find((a) => /pdf|doc|word/i.test(a.type || a.name || '')); if (f) { const base = String(f.name).replace(/\.\w+$/, '').replace(/[_\-.]+/g, ' ').replace(/\b(resume|cv|curriculum vitae|application|updated|final|\d+)\b/gi, ' ').trim(); if (/^[a-zñ ]{3,60}$/i.test(base) && base.split(' ').length >= 2) name = titleCase(base); } }
  // contact details (Indeed relay addresses like …@indeedemail.com are kept, they forward to the applicant)
  const emails = (all.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).filter((e) => !/@(indeed\.com|[\w.-]*jobstreet\.[\w.]+|[\w.-]*seek\.[\w.]+|brdc\.ph|linkedin\.com|kalibrr\.com|[\w.-]*google\.com|gmail-noreply)|no-?reply|donotreply|notification|alerts?@|jobs?@/i.test(e));
  const relay = (String(m.from).match(/conversation-[\w.+-]+@[\w.-]+/i) || [])[0];
  if (relay) emails.unshift(relay);
  const phone = (text.match(/(?:\+?63|0)\s?9\d{2}[\s-]?\d{3}[\s-]?\d{4}/) || [])[0] || '';
  const loc = (text.match(/(?:^|\n)\s*(?:location|address|city)\s*[:\-]\s*([^\n]{2,60})/i) || [])[1] || '';
  const fix = (n) => (n && n === n.toUpperCase() ? titleCase(n) : n);
  return { src, job, name: fix(name), extra: extra.map(fix), others, email: emails[0] || '', phone: phone.replace(/\s+/g, ' '), city: loc.split(',')[0].trim(), prov: (loc.split(',')[1] || '').trim(), text };
}


const JOB_ALERT = /job alert|job recommendations?|recommended jobs|jobs? for you|\+\s*\d+\s+new jobs|new jobs? (?:match|near)|we've got new job|saved search/i;
// m = {id, from, subject, text, html, attachments:[{name,type,data(base64)}]}
export async function ingest(m, via) {
  if (!m.subject && !m.text && !m.html) return { skipped: 'Empty email' };
  const mid = String(m.id || `${m.from}|${m.subject}|${(m.text || m.html).length}`).slice(0, 300);
  const seen = await q(`INSERT INTO reminders (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`, ['mail:' + mid]);
  if (!seen.length) return { skipped: 'Already imported' };
  if (JOB_ALERT.test(`${m.subject}\n${String(m.text || strip(m.html)).slice(0, 600)}`)) return { skipped: 'Job alert, not an application' };
  const s = (await q(`SELECT data FROM app_state WHERE id='main'`))[0].data || {};
  const jobs = s.JOBS || [];
  const p = parseApplication(m, jobs);
  if (!/indeed|jobstreet|seek|linkedin|kalibrr|appl(y|ied|icant|ication)|candidate|resume|cv\b/i.test(`${m.from} ${m.subject} ${p.text.slice(0, 2000)}`)) return { skipped: 'Not an application email' };
  const job = p.job || jobs.find((j) => j.rf === 'general' && j.status === 'open');
  if (!job) { await q(`DELETE FROM reminders WHERE key=$1`, ['mail:' + mid]); return { error: 'Position not recognised and no open general application job — create one, then the email is retried' }; }
  const files = (m.attachments || []).map((a) => ({ name: String(a.name || 'file').slice(0, 120), type: a.type && OK_TYPES.test(a.type) ? a.type : guess(a.name), data: String(a.data || '').replace(/^data:[^,]*,/, '') }))
    .filter((a) => OK_TYPES.test(a.type) && a.data && a.data.length * 3 / 4 <= MAX && !/logo|banner|icon|image\d{3}/i.test(a.name));
  const resume = files.find((f) => /pdf|word/.test(f.type)) || files[0];
  const people = [{ name: p.name, email: p.email, phone: p.phone, withFiles: true }, ...p.extra.map((n) => ({ name: n, email: '', phone: '' }))];
  const out = [];
  try {
  for (const person of people) {
    const mk = mobileKey(person.phone);
    const dupKey = mk.length >= 10 ? mk : person.email ? 'e:' + person.email.toLowerCase() : person.name ? 'n:' + person.name.toLowerCase() : 'm:' + mid.slice(-40);
    const dupState = (s.CANDS || []).some((c) => c.job === job.id && ((mk.length >= 10 && mobileKey(c.mob) === mk) || (person.email && (c.em || '').toLowerCase() === person.email.toLowerCase()) || (!mk && !person.email && person.name && (c.n || '').toLowerCase() === person.name.toLowerCase())));
    if (dupState || (await q(`SELECT 1 FROM applications WHERE job=$1 AND mobile_key=$2`, [job.id, dupKey])).length) { out.push({ skipped: 'Already in BRDC Recruit', name: person.name }); continue; }
    const note = `Imported from ${p.src} email${via ? ' (' + via + ')' : ''}${p.job ? '' : ' — position not recognised, please set the correct job'}.${p.others ? `\nThis email listed ${p.others + 1} applicants; open it on ${p.src} for contact details.` : ''}\nSubject: ${m.subject}\n\n${p.text.slice(0, 1500)}`;
    const data = { n: person.name || `${p.src} applicant (check email)`, nick: (person.name || '').split(' ')[0], mob: person.phone, em: person.email, city: p.city || '—', prov: p.prov || '', job: job.id, src: p.src,
      exp: '—', skills: [], resume: person.withFiles && resume ? resume.name : null, review: true, inNote: note, jobGuess: !!p.job };
    const row = (await q(`INSERT INTO applications (ref, job, mobile_key, data) VALUES ('pending',$1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [job.id, dupKey, JSON.stringify(data)]))[0];
    if (!row) { out.push({ skipped: 'Already in BRDC Recruit', name: person.name }); continue; }
    const ref = 'C-' + (5000 + row.id); await q(`UPDATE applications SET ref=$1 WHERE id=$2`, [ref, row.id]);
    if (person.withFiles) for (const f of files.slice(0, 5)) await q(`INSERT INTO files (ref, kind, name, type, size, b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ref, f === resume ? 'resume' : 'Other', f.name, f.type, Math.floor(f.data.length * 3 / 4), f.data, p.src + ' email']);
    out.push({ ok: true, ref, name: data.n });
  }
  } catch (e) { if (!out.some((x) => x.ok)) await q(`DELETE FROM reminders WHERE key=$1`, ['mail:' + mid]); throw e; }
  return { ok: true, job: job.id, source: p.src, matchedJob: !!p.job, files: files.length, added: out.filter((x) => x.ok).length, people: out };
}

import { q, handle, send } from './_lib.js';
import { providers, sendSms, sendEmail } from './_msg.js';
// Runs every morning (see vercel.json): texts applicants and emails interviewers about tomorrow's interviews.
const phDay = (d) => new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const fmtPH = (d) => new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default handle(async (req, res) => {
  if (process.env.CRON_SECRET && (req.headers.authorization || '') !== 'Bearer ' + process.env.CRON_SECRET) return send(res, 401, { error: 'Unauthorized' });
  const p = providers(); if (!p.sms && !p.email) return send(res, 200, { skipped: 'No SMS or email provider set up' });
  const d = (await q(`SELECT data FROM app_state WHERE id='main'`))[0].data || {};
  const tomorrow = phDay(Date.now() + 864e5);
  const jobs = d.JOBS || [], cands = d.CANDS || [];
  const BU = { br: 'BRDC', sf: 'Smartfuels', nb: 'Neo Bros Ventures', uh: 'U Hotels', th: 'Toilena Hotel', ex: 'Exelhaul Logistics', pp: 'Pan Pacific', lf: 'La Ferme Organique' };
  const accounts = await q(`SELECT name, email FROM accounts WHERE status='active' AND email IS NOT NULL AND email <> ''`);
  const due = (d.INTV || []).filter((i) => i.status === 'scheduled' && i.when && phDay(i.when) === tomorrow);
  const done = [];
  for (const i of due) {
    const key = `intv-${i.id}-${phDay(i.when)}`;
    const fresh = await q(`INSERT INTO reminders (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`, [key]);
    if (!fresh.length) continue;
    const c = cands.find((x) => x.id === i.cid); if (!c) continue;
    const j = jobs.find((x) => x.id === c.job) || {}, when = fmtPH(i.when), meta = { by: 'Automatic reminder', ref: c.ref || 'C-' + (2000 + c.id) };
    const r = { id: i.id };
    if (p.sms && c.mob) r.sms = (await sendSms(c.mob, `Hi ${c.nick || c.n}, reminder: your ${String(i.type || 'interview').toLowerCase()} for ${j.t || 'your application'} is tomorrow, ${when}, at ${i.loc || 'BRDC office'}. Please bring a valid ID. - BRDC HR`, meta)).ok;
    const ivEmail = i.ivEmail || (accounts.find((a) => a.name === i.interviewer) || {}).email;
    if (p.email && ivEmail) r.email = (await sendEmail({ to: ivEmail, subject: `Reminder: interview with ${c.n} tomorrow`, text: `Hi ${i.interviewer},\n\nReminder: you are interviewing ${c.n} for ${j.t || '—'} (${BU[j.bu] || ''}) tomorrow, ${when}, at ${i.loc || 'BRDC office'}.\n\n— BRDC Recruit` }, meta)).ok;
    done.push(r);
  }
  return send(res, 200, { day: tomorrow, reminders: done.length, done });
});

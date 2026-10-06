// SMS (Semaphore, Philippines) and email (Resend) delivery. Keys live in Vercel environment variables.
import { q } from './_lib.js';

// SMS can go out through an Android phone running the free "SMS Gateway for Android" app (sms-gate.app):
// SMSGATE_USER + SMSGATE_PASSWORD (shown in the app → Cloud server), optional SMSGATE_URL for a private/local server.
const smsGate = () => (process.env.SMSGATE_USER && process.env.SMSGATE_PASSWORD) ? { user: process.env.SMSGATE_USER.trim(), pass: process.env.SMSGATE_PASSWORD.trim(), url: (process.env.SMSGATE_URL || 'https://api.sms-gate.app/3rdparty/v1').replace(/\/$/, '') } : null;
export function providers() {
  return {
    sms: !!(smsGate() || process.env.SEMAPHORE_API_KEY),
    smsVia: smsGate() ? 'phone' : process.env.SEMAPHORE_API_KEY ? 'semaphore' : '',
    email: !!process.env.RESEND_API_KEY,
    smsSender: process.env.SEMAPHORE_SENDER || '',
    emailFrom: process.env.EMAIL_FROM || '',
  };
}
export function phMobile(m) {
  const d = String(m || '').replace(/\D/g, '');
  if (/^09\d{9}$/.test(d)) return d;
  if (/^639\d{9}$/.test(d)) return '0' + d.slice(2);
  if (/^9\d{9}$/.test(d)) return '0' + d;
  return null;
}
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));

async function logOut(row) {
  try {
    await q(`INSERT INTO outbox (channel, recipient, subject, body, status, provider_id, error, sent_by, ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.channel, row.to, row.subject || null, String(row.body || '').slice(0, 4000), row.status, row.id || null, row.error || null, row.by || null, row.ref || null]);
  } catch (e) { /* logging must never block sending */ }
}

async function sendViaPhone(g, num, text, meta) {
  const e164 = '+63' + num.slice(1);
  let r, j;
  try { r = await fetch(`${g.url}/messages`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${g.user}:${g.pass}`).toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ textMessage: { text: String(text).slice(0, 900) }, phoneNumbers: [e164] }) }); j = await r.json().catch(() => ({})); }
  catch (e) { await logOut({ channel: 'sms', to: num, body: text, status: 'failed', error: e.message, ...meta }); return { ok: false, error: 'Could not reach the SMS gateway phone service.' }; }
  if (!r.ok || !j.id) {
    const err = j.message || j.error || (r.status === 401 ? 'wrong SMS gateway username or password' : `SMS gateway error ${r.status}`);
    await logOut({ channel: 'sms', to: num, body: text, status: 'failed', error: String(err), ...meta });
    return { ok: false, error: 'SMS not sent: ' + String(err).slice(0, 200) };
  }
  await logOut({ channel: 'sms', to: num, body: text, status: 'sent', id: String(j.id), ...meta });
  return { ok: true, id: j.id, via: 'phone' };
}

export async function sendSms(to, text, meta = {}) {
  const num = phMobile(to);
  const g = smsGate();
  if (g) { if (!num) return { ok: false, error: `“${to}” is not a valid Philippine mobile number.` }; return sendViaPhone(g, num, text, meta); }
  if (!process.env.SEMAPHORE_API_KEY) return { ok: false, error: 'SMS is not set up (add the SMS Gateway phone app or Semaphore in Vercel).' };
  if (!num) return { ok: false, error: `“${to}” is not a valid Philippine mobile number.` };
  const form = new URLSearchParams({ apikey: process.env.SEMAPHORE_API_KEY, number: num, message: String(text).slice(0, 900) });
  if (process.env.SEMAPHORE_SENDER) form.set('sendername', process.env.SEMAPHORE_SENDER);
  let r, j;
  try { r = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', body: form }); j = await r.json().catch(() => ({})); }
  catch (e) { await logOut({ channel: 'sms', to: num, body: text, status: 'failed', error: e.message, ...meta }); return { ok: false, error: 'Could not reach the SMS service.' }; }
  const first = Array.isArray(j) ? j[0] : null;
  if (!r.ok || !first || !first.message_id) {
    const err = (j && (j.message || j.error || (typeof j === 'object' && Object.values(j).flat().join(' ')))) || `SMS service error ${r.status}`;
    await logOut({ channel: 'sms', to: num, body: text, status: 'failed', error: String(err), ...meta });
    return { ok: false, error: 'SMS not sent: ' + String(err).slice(0, 200) };
  }
  await logOut({ channel: 'sms', to: num, body: text, status: 'sent', id: String(first.message_id), ...meta });
  return { ok: true, id: first.message_id };
}

export async function sendEmail({ to, subject, text, html, attachments }, meta = {}) {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: 'Email is not set up (RESEND_API_KEY missing).' };
  const list = (Array.isArray(to) ? to : [to]).filter(okEmail);
  if (!list.length) return { ok: false, error: 'No valid email address.' };
  const from = process.env.EMAIL_FROM || 'BRDC Careers <onboarding@resend.dev>';
  const payload = { from, to: list, subject: String(subject || 'BRDC Careers').slice(0, 200), text: String(text || ''), html: html || undefined, attachments: attachments && attachments.length ? attachments : undefined };
  let r, j;
  try { r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); j = await r.json().catch(() => ({})); }
  catch (e) { await logOut({ channel: 'email', to: list.join(','), subject, body: text, status: 'failed', error: e.message, ...meta }); return { ok: false, error: 'Could not reach the email service.' }; }
  if (!r.ok || !j.id) {
    const err = j.message || j.error || `Email service error ${r.status}`;
    await logOut({ channel: 'email', to: list.join(','), subject, body: text, status: 'failed', error: String(err), ...meta });
    return { ok: false, error: 'Email not sent: ' + String(err).slice(0, 200) };
  }
  await logOut({ channel: 'email', to: list.join(','), subject, body: text, status: 'sent', id: j.id, ...meta });
  return { ok: true, id: j.id };
}

// Calendar invite (.ics) for an interview
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export function interviewIcs({ uid, start, minutes = 60, title, location, description, organizer }) {
  const end = new Date(new Date(start).getTime() + minutes * 60000);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BRDC//Recruit//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${uid}@brdc-recruit`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEsc(title)}`, `LOCATION:${icsEsc(location)}`, `DESCRIPTION:${icsEsc(description)}`,
    organizer ? `ORGANIZER;CN=BRDC HR:mailto:${organizer}` : null,
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Interview in 30 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
}

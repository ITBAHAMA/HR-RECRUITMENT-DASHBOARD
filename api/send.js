import { q, handle, body, send, requireUser, derivedKey } from './_lib.js';
import { providers, sendSms, sendEmail, interviewIcs } from './_msg.js';
// GET: which channels are set up + recent deliveries. POST: send an SMS / email, or an interview invitation.
const s = (v, n = 500) => String(v ?? '').trim().slice(0, n);
const fmtPH = (d) => new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default handle(async (req, res) => {
  const me = await requireUser(req);
  if (req.method === 'GET') {
    const p = providers();
    const recent = await q(`SELECT id, channel, recipient, subject, status, error, sent_by, ref, created_at FROM outbox ORDER BY id DESC LIMIT 50`);
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const inbound = me.role === 'hr_admin' ? `${/localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https'}://${host}/api/inbound?key=${process.env.INBOUND_KEY || derivedKey('inbound')}` : null;
    const imported = (await q(`SELECT count(*)::int n, max(created_at) last FROM reminders WHERE key LIKE 'mail:%'`))[0];
    return send(res, 200, { sms: p.sms, email: p.email, smsSender: p.smsSender, emailFrom: p.emailFrom, recent, inbound, mailSeen: imported.n, mailLast: imported.last });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  if (me.role === 'viewer') return send(res, 403, { error: 'Viewers cannot send messages' });
  const b = body(req); const meta = { by: me.name, ref: s(b.ref, 40) || null };

  if (b.action === 'invite') {
    const i = b.intv || {}, c = b.cand || {}, iv = b.interviewer || {}, j = b.job || {}, n = b.notify || {};
    if (!i.when) return send(res, 400, { error: 'Interview time missing' });
    const when = fmtPH(i.when), where = s(i.loc, 200) || 'BRDC office';
    const ics = interviewIcs({ uid: `intv-${s(i.id, 20)}-${Date.parse(i.when)}`, start: i.when, minutes: +i.minutes || 60,
      title: `${s(i.type, 60)}: ${s(c.n, 80)} — ${s(j.t, 80)}`, location: where,
      description: `Candidate: ${s(c.n, 80)} (${s(c.mob, 20)})\nPosition: ${s(j.t, 80)} · ${s(j.bu, 60)}\nInterviewer: ${s(iv.name, 80)}\nScheduled in BRDC Recruit by ${me.name}.`,
      organizer: process.env.EMAIL_FROM && (process.env.EMAIL_FROM.match(/<([^>]+)>/) || [])[1] });
    const att = [{ filename: 'interview.ics', content: Buffer.from(ics).toString('base64') }];
    const out = {};
    if (n.interviewerEmail && iv.email) out.interviewer = await sendEmail({ to: iv.email, subject: `Interview: ${s(c.n, 80)} for ${s(j.t, 80)} — ${when}`,
      text: `Hi ${s(iv.name, 60) || 'there'},\n\nYou are interviewing ${s(c.n, 80)} for ${s(j.t, 80)} (${s(j.bu, 60)}).\n\nWhen: ${when}\nWhere: ${where}\nType: ${s(i.type, 60)}\n\nThe calendar invite is attached. Please record the result in BRDC Recruit after the interview.\n\n— BRDC HR` , attachments: att }, meta);
    if (n.applicantEmail && c.em) out.applicantEmail = await sendEmail({ to: c.em, subject: `Your interview with BRDC — ${when}`,
      text: `Hi ${s(c.nick || c.n, 60)},\n\nThank you for applying for ${s(j.t, 80)} at ${s(j.bu, 60) || 'BRDC'}. You are invited to a ${s(i.type, 60).toLowerCase()}.\n\nWhen: ${when}\nWhere: ${where}\n\nPlease bring a valid ID and a copy of your resume. Reply to this email or text us if you need to reschedule.\n\n— BRDC HR`, attachments: att }, meta);
    if (n.applicantSms && c.mob) out.applicantSms = await sendSms(c.mob, s(b.smsText, 900) || `Hi ${s(c.nick || c.n, 40)}, you are scheduled for a ${s(i.type, 40).toLowerCase()} for ${s(j.t, 60)} on ${when} at ${where}. Please bring a valid ID. Reply to confirm. - BRDC HR`, meta);
    return send(res, 200, { results: out, ics });
  }

  const ch = b.channel === 'email' ? 'email' : 'sms';
  const r = ch === 'sms' ? await sendSms(b.to, s(b.body, 900), meta)
    : await sendEmail({ to: s(b.to, 200), subject: s(b.subject, 200) || 'BRDC Careers', text: s(b.body, 5000) }, meta);
  return send(res, r.ok ? 200 : 400, r);
});

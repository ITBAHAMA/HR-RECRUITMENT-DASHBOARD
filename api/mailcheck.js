import { q, handle, send, verify } from './_lib.js';
import { ingest } from './_ingest.js';
// Reads the HR mailbox (Zoho Mail over IMAP, read-only) every 5 minutes and imports new Indeed / Jobstreet applicants.
// Settings (Vercel → Environment Variables): MAIL_USER, MAIL_PASSWORD (a Zoho app password), MAIL_IMAP_HOST (imappro.zoho.com).
const getKv = async (k) => ((await q(`SELECT v FROM kv WHERE k=$1`, [k]))[0] || {}).v || null;
const setKv = (k, v) => q(`INSERT INTO kv (k, v, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, updated_at=now()`, [k, JSON.stringify(v)]);

export function mailConfig() {
  const E = process.env;
  return { user: E.MAIL_USER || '', pass: E.MAIL_PASSWORD || '', host: E.MAIL_IMAP_HOST || 'imappro.zoho.com', port: +(E.MAIL_IMAP_PORT || 993), folder: E.MAIL_FOLDER || 'INBOX' };
}
const SENDERS = ['indeed', 'jobstreet', 'seek'];

async function openClient(cfg) {
  if (globalThis.__mockImap) return globalThis.__mockImap(cfg); // local tests only
  const { ImapFlow } = await import('imapflow');
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false, socketTimeout: 30000 });
  await c.connect(); return c;
}

export async function checkMailbox({ days = 3, max = 25 } = {}) {
  const cfg = mailConfig();
  if (!cfg.user || !cfg.pass) return { configured: false };
  const { simpleParser } = await import('mailparser');
  const started = Date.now(), res = { configured: true, checked: 0, added: 0, skipped: 0, people: [] };
  let client;
  try {
    client = await openClient(cfg);
    const lock = await client.getMailboxLock(cfg.folder, { readOnly: true });
    try {
      const since = new Date(Date.now() - days * 864e5);
      const uids = await client.search({ since, or: SENDERS.map((f) => ({ from: f })) }, { uid: true });
      const done = new Set((await getKv('imap:done')) || []);
      const todo = (uids || []).filter((u) => !done.has(`${client.mailbox.uidValidity}:${u}`)).sort((a, b) => a - b).slice(0, max);
      for (const uid of todo) {
        if (Date.now() - started > 45000) break; // stay inside the function time limit; the rest waits for the next run
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        const p = await simpleParser(msg.source);
        const m = { id: p.messageId || `imap-${client.mailbox.uidValidity}-${uid}`, from: (p.from && p.from.text) || '', subject: p.subject || '', text: p.text || '', html: p.html || '',
          attachments: (p.attachments || []).filter((a) => a.size <= 3 * 1024 * 1024).map((a) => ({ name: a.filename || 'file', type: a.contentType, data: a.content.toString('base64') })) };
        const r = await ingest(m, 'Zoho mailbox');
        res.checked++; if (r.added) { res.added += r.added; res.people.push(...r.people.filter((x) => x.ok).map((x) => x.name)); } else res.skipped++;
        done.add(`${client.mailbox.uidValidity}:${uid}`);
      }
      await setKv('imap:done', [...done].slice(-3000));
    } finally { lock.release(); }
    await client.logout();
    res.ok = true;
  } catch (e) {
    try { client && client.close(); } catch {}
    const msg = String(e.responseText || e.message || e);
    res.ok = false;
    res.error = /auth|login|credential|invalid|password/i.test(msg) ? 'Zoho refused the sign-in. Check MAIL_USER, that IMAP access is turned on for this mailbox, and that MAIL_PASSWORD is a Zoho app password.'
      : /ENOTFOUND|getaddrinfo/i.test(msg) ? `Mail server “${cfg.host}” not found. Use imappro.zoho.com (company mail) or imap.zoho.com (personal).`
      : /timeout|ETIMEDOUT|ECONNREFUSED/i.test(msg) ? 'Could not reach the Zoho mail server. It will try again in 5 minutes.' : 'Mailbox check failed: ' + msg.slice(0, 200);
  }
  res.at = new Date().toISOString();
  const prev = (await getKv('imap:status')) || {};
  await setKv('imap:status', { ...res, people: res.people.slice(0, 20), totalAdded: (prev.totalAdded || 0) + res.added, lastAdded: res.added ? res.at : prev.lastAdded || null });
  return res;
}

export default handle(async (req, res) => {
  const auth = req.headers.authorization || '';
  const cron = process.env.CRON_SECRET ? auth === 'Bearer ' + process.env.CRON_SECRET : /vercel-cron/i.test(req.headers['user-agent'] || '');
  const tok = verify(auth.replace(/^Bearer\s+/i, ''));
  const admin = tok && tok.kind === 'session' && ((await q(`SELECT role FROM accounts WHERE u=$1 AND status='active'`, [tok.u]))[0] || {}).role === 'hr_admin';
  if (req.method === 'GET' && admin && new URL(req.url || '/', 'http://x').searchParams.get('status')) {
    const c = mailConfig(); return send(res, 200, { configured: !!(c.user && c.pass), user: c.user, host: c.host, status: await getKv('imap:status') });
  }
  if (!cron && !admin) {
    const st = await getKv('imap:status'); // anyone else may only nudge it, at most once a minute
    if (st && Date.now() - Date.parse(st.at) < 60000) return send(res, 200, { skipped: 'Checked less than a minute ago' });
  }
  const r = await checkMailbox();
  return send(res, 200, r);
});

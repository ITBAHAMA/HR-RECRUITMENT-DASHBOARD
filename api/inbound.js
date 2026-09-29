import { handle, body, send, derivedKey } from './_lib.js';
import { normalise, ingest } from './_ingest.js';
// Receives application emails forwarded by a Gmail script, Power Automate, or an inbound-email service (Postmark shape accepted).
export default handle(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const key = new URL(req.url || '/', 'http://x').searchParams.get('key') || '';
  if (!key || key !== (process.env.INBOUND_KEY || derivedKey('inbound'))) return send(res, 401, { error: 'Invalid key' });
  const r = await ingest(normalise(body(req)), 'forwarded');
  return send(res, r.error ? 400 : 200, r);
});

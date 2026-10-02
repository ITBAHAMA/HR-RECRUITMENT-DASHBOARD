import { q, handle, body, send, requireUser, sign } from './_lib.js';
import { scopeOf } from './_scope.js';
import { buOfRef } from './files.js';
import { redact } from './_form.js';
// Staff side of the Application for Employment: read a candidate's form, or make a link the applicant can fill in.
export default handle(async (req, res) => {
  const me = await requireUser(req);
  const S = scopeOf(me);
  const url = new URL(req.url || '/', 'http://x');
  const ref = String((req.method === 'GET' ? url.searchParams.get('ref') : body(req).ref) || '').slice(0, 40);
  if (!/^C-\d{1,9}$/.test(ref)) return send(res, 400, { error: 'Invalid reference' });
  if (S && !S.has(await buOfRef(ref))) return send(res, 403, { error: 'Not your business unit' });
  if (req.method === 'GET') {
    const r = (await q(`SELECT data, updated_at FROM forms WHERE ref=$1`, [ref]))[0];
    return send(res, 200, { form: r ? redact(r.data, me.role) : null, updatedAt: r ? r.updated_at : null });
  }
  if (req.method === 'POST') {
    if (me.role === 'viewer') return send(res, 403, { error: 'Viewers cannot send forms' });
    return send(res, 200, { token: sign({ kind: 'formlink', ref }, 24 * 30) });
  }
  send(res, 405, { error: 'Method not allowed' });
});

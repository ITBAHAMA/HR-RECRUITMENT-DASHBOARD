import { q, handle, body, send, requireUser } from './_lib.js';
import { scopeOf, jobBuOf } from './_scope.js';
// Candidate files (resumes and pre-employment documents), stored in the database.
export const MAX_BYTES = 3 * 1024 * 1024;
export const OK_TYPES = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/(jpeg|png|webp|heic|heif))$/;
const refOf = (c) => c.ref || 'C-' + (2000 + c.id);

async function buOfRef(ref) {
  const s = (await q(`SELECT data FROM app_state WHERE id='main'`))[0].data || {};
  const c = (s.CANDS || []).find((x) => refOf(x) === ref);
  if (c) return jobBuOf(s, c.job);
  const a = (await q(`SELECT job FROM applications WHERE ref=$1`, [ref]))[0];
  return a ? jobBuOf(s, a.job) : undefined;
}

export default handle(async (req, res) => {
  const me = await requireUser(req);
  const S = scopeOf(me);
  const url = new URL(req.url || '/', 'http://x');
  const allowed = async (ref) => !S || S.has(await buOfRef(ref));

  const fid = Number(url.searchParams.get('id'));
  if (url.searchParams.get('id') && !(Number.isInteger(fid) && fid > 0)) return send(res, 400, { error: 'Invalid file id' });
  if (req.method === 'GET' && url.searchParams.get('id')) {
    const f = (await q(`SELECT * FROM files WHERE id=$1`, [fid]))[0];
    if (!f) return send(res, 404, { error: 'File not found' });
    if (!(await allowed(f.ref))) return send(res, 403, { error: 'Not your business unit' });
    const buf = Buffer.from(f.b64, 'base64');
    res.statusCode = 200; res.setHeader('Content-Type', f.type || 'application/octet-stream'); res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
    return res.end(buf);
  }
  if (req.method === 'GET') {
    const ref = url.searchParams.get('ref');
    if (!ref) return send(res, 400, { error: 'ref required' });
    if (!(await allowed(ref))) return send(res, 403, { error: 'Not your business unit' });
    const rows = await q(`SELECT id, ref, kind, name, type, size, uploaded_by, created_at FROM files WHERE ref=$1 ORDER BY id DESC`, [ref]);
    return send(res, 200, { files: rows });
  }
  if (me.role === 'viewer') return send(res, 403, { error: 'Viewers cannot change files' });
  if (req.method === 'POST') {
    const b = body(req); const ref = String(b.ref || '').slice(0, 40);
    if (!ref || !b.data || !b.name) return send(res, 400, { error: 'Missing file' });
    if (!(await allowed(ref))) return send(res, 403, { error: 'Not your business unit' });
    const b64 = String(b.data).replace(/^data:[^,]*,/, ''); const size = Math.floor(b64.length * 3 / 4);
    if (size > MAX_BYTES) return send(res, 413, { error: 'File is larger than 3 MB. Please upload a smaller file or a photo.' });
    const type = String(b.type || ''); if (!OK_TYPES.test(type)) return send(res, 400, { error: 'Only PDF, Word or photo files are accepted.' });
    const row = (await q(`INSERT INTO files (ref, kind, name, type, size, b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, ref, kind, name, type, size, uploaded_by, created_at`,
      [ref, String(b.kind || 'document').slice(0, 60), String(b.name).slice(0, 120), type, size, b64, me.name]))[0];
    return send(res, 200, { file: row });
  }
  if (req.method === 'DELETE') {
    const id = fid; const f = (await q(`SELECT ref FROM files WHERE id=$1`, [id]))[0];
    if (!f) return send(res, 404, { error: 'File not found' });
    if (!(await allowed(f.ref))) return send(res, 403, { error: 'Not your business unit' });
    await q(`DELETE FROM files WHERE id=$1`, [id]); return send(res, 200, { ok: true });
  }
  send(res, 405, { error: 'Method not allowed' });
});

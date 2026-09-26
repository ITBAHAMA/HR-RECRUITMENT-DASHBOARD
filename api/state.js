import { q, handle, body, send, requireUser } from './_lib.js';
// Shared recruitment data. GET returns the data + new applications inbox; PUT saves with a version check.
export default handle(async (req, res) => {
  const me = await requireUser(req);
  if (req.method === 'GET') {
    const s = (await q(`SELECT data, version, updated_at, updated_by FROM app_state WHERE id='main'`))[0];
    const inbox = await q(`SELECT id, ref, job, data, created_at FROM applications ORDER BY id`);
    return send(res, 200, { data: s.data, version: s.version, updatedAt: s.updated_at, updatedBy: s.updated_by, inbox });
  }
  if (req.method === 'PUT') {
    if (me.role === 'viewer') return send(res, 403, { error: 'Viewers cannot make changes' });
    const b = body(req); if (!b.data || typeof b.data !== 'object') return send(res, 400, { error: 'Missing data' });
    const consumed = (Array.isArray(b.consumed) ? b.consumed : []).map(Number).filter(Number.isFinite);
    const upd = await q(`WITH u AS (UPDATE app_state SET data=$1::jsonb, version=version+1, updated_at=now(), updated_by=$2 WHERE id='main' AND version=$3 RETURNING version),
      d AS (DELETE FROM applications WHERE id = ANY($4::int[]) AND EXISTS (SELECT 1 FROM u) RETURNING id)
      SELECT (SELECT version FROM u) AS version, (SELECT count(*) FROM d)::int AS removed`, [JSON.stringify(b.data), me.u, Number(b.version) || 0, consumed]);
    if (upd[0].version == null) upd.length = 0;
    if (!upd.length) { const cur = (await q(`SELECT version, updated_by FROM app_state WHERE id='main'`))[0]; return send(res, 409, { error: 'Someone else saved changes first', version: cur.version, updatedBy: cur.updated_by }); }
    return send(res, 200, { version: upd[0].version });
  }
  send(res, 405, { error: 'Method not allowed' });
});

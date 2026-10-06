import { q, handle, body, send, requireUser } from './_lib.js';
import { scopeOf, viewFor, mergeFor, maxIds, jobBuOf } from './_scope.js';
// Shared recruitment data. GET returns the data + new applications inbox; PUT saves with a version check.
// Accounts limited to some business units only receive and change those units' records.
export default handle(async (req, res) => {
  const me = await requireUser(req);
  const S = scopeOf(me);
  if (req.method === 'GET') {
    const s = (await q(`SELECT data, version, updated_at, updated_by FROM app_state WHERE id='main'`))[0];
    let inbox = await q(`SELECT id, ref, job, data, created_at FROM applications ORDER BY id`);
    if (S) inbox = inbox.filter((a) => S.has(jobBuOf(s.data, a.job)));
    const files = await q(`SELECT ref, count(*)::int AS n FROM files GROUP BY ref`);
    const view = viewFor(s.data, S); const refs = new Set((view.CANDS || []).map((c) => c.ref || 'C-' + (2000 + c.id)));
    const forms = Object.fromEntries((await q(`SELECT ref, updated_at FROM forms`)).filter((f) => refs.has(f.ref)).map((f) => [f.ref, new Date(f.updated_at).toISOString()]));
    return send(res, 200, { data: view, forms, version: s.version, updatedAt: s.updated_at, updatedBy: s.updated_by, inbox,
      scope: S ? [...S] : null, maxIds: maxIds(s.data), files: Object.fromEntries(files.map((f) => [f.ref, f.n])) });
  }
  if (req.method === 'PUT') {
    if (me.role === 'viewer') return send(res, 403, { error: 'Viewers cannot make changes' });
    const b = body(req); if (!b.data || typeof b.data !== 'object') return send(res, 400, { error: 'Missing data' });
    let consumed = (Array.isArray(b.consumed) ? b.consumed : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 2147483647);
    let data = b.data;
    if (S) {
      const cur = (await q(`SELECT data, version FROM app_state WHERE id='main'`))[0];
      if (cur.version !== (Number(b.version) || 0)) return send(res, 409, { error: 'Someone else saved changes first', version: cur.version });
      const m = mergeFor(cur.data, data, S);
      if (m.conflict) return send(res, 409, { error: 'Someone else saved changes first', version: cur.version });
      data = m.data;
      if (consumed.length) { const rows = await q(`SELECT id, job FROM applications WHERE id = ANY($1::int[])`, [consumed]); consumed = rows.filter((r) => S.has(jobBuOf(data, r.job))).map((r) => r.id); }
    }
    const upd = await q(`WITH u AS (UPDATE app_state SET data=$1::jsonb, version=version+1, updated_at=now(), updated_by=$2 WHERE id='main' AND version=$3 RETURNING version),
      d AS (DELETE FROM applications WHERE id = ANY($4::int[]) AND EXISTS (SELECT 1 FROM u) RETURNING id)
      SELECT (SELECT version FROM u) AS version, (SELECT count(*) FROM d)::int AS removed`, [JSON.stringify(data), me.u, Number(b.version) || 0, consumed]);
    if (upd[0].version == null) { const cur = (await q(`SELECT version, updated_by FROM app_state WHERE id='main'`))[0]; return send(res, 409, { error: 'Someone else saved changes first', version: cur.version, updatedBy: cur.updated_by }); }
    return send(res, 200, { version: upd[0].version, maxIds: maxIds(data) });
  }
  send(res, 405, { error: 'Method not allowed' });
});

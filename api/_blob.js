// Uploaded files (resumes, photos, IDs, signatures) live in Vercel Blob when BLOB_READ_WRITE_TOKEN is set;
// the database only keeps a pointer. Without the token they stay in the database (old behaviour).
import { q } from './_lib.js';
export const blobOn = () => !!(process.env.BLOB_READ_WRITE_TOKEN || globalThis.__mockBlob);
const sdk = async () => globalThis.__mockBlob || await import('@vercel/blob');
let ACCESS = process.env.BLOB_ACCESS || null; // 'private' (preferred) or 'public' — learned on first upload
const safe = (s) => String(s || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80);
async function putBuf(path, buf, type) {
  const m = await sdk(); const go = (a) => m.put(path, buf, { access: a, addRandomSuffix: true, contentType: type || 'application/octet-stream' });
  if (ACCESS) return { r: await go(ACCESS), a: ACCESS };
  try { const r = await go('private'); ACCESS = 'private'; return { r, a: 'private' }; }
  catch (e) { if (!/access|private|public|store/i.test(String(e && e.message || e))) throw e; const r = await go('public'); ACCESS = 'public'; return { r, a: 'public' }; }
}
/* Save a file for a candidate. Falls back to the database if Blob is not set up or the upload fails. */
export async function saveFile({ ref, kind, name, type, b64, by }) {
  const size = Math.floor(String(b64).length * 3 / 4);
  if (blobOn()) {
    try {
      const { r, a } = await putBuf(`candidates/${safe(ref)}/${safe(kind)}-${safe(name)}`, Buffer.from(b64, 'base64'), type);
      return (await q(`INSERT INTO files (ref, kind, name, type, size, b64, blob_url, blob_access, uploaded_by) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8) RETURNING id, ref, kind, name, type, size, uploaded_by, created_at`,
        [ref, kind, name, type, size, r.url, a, by]))[0];
    } catch (e) { console.error('blob upload failed, keeping file in the database:', e && e.message); }
  }
  return (await q(`INSERT INTO files (ref, kind, name, type, size, b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, ref, kind, name, type, size, uploaded_by, created_at`,
    [ref, kind, name, type, size, b64, by]))[0];
}
/* File bytes for a row from the files table. */
export async function fileBuffer(row) {
  if (!row.blob_url) return Buffer.from(row.b64 || '', 'base64');
  const m = await sdk(); const g = await m.get(row.blob_url, { access: row.blob_access || 'public' });
  if (!g || !g.stream) throw new Error('File not found in storage');
  return Buffer.from(await new Response(g.stream).arrayBuffer());
}
/* Remove blobs that belonged to deleted rows (never blocks the delete). */
export async function dropBlobs(urls) { urls = (urls || []).filter(Boolean); if (!urls.length || !blobOn()) return; try { const m = await sdk(); await m.del(urls); } catch (e) { console.error('blob delete failed:', e && e.message); } }
/* Move files still kept in the database to Blob, a few at a time. */
export async function moveToBlob(n = 15) {
  if (!blobOn()) return { configured: false };
  const rows = await q(`SELECT id, ref, kind, name, type, b64 FROM files WHERE blob_url IS NULL AND b64 IS NOT NULL ORDER BY id LIMIT $1`, [n]);
  let moved = 0; const errors = [];
  for (const f of rows) {
    try { const { r, a } = await putBuf(`candidates/${safe(f.ref)}/${safe(f.kind)}-${safe(f.name)}`, Buffer.from(f.b64, 'base64'), f.type);
      await q(`UPDATE files SET blob_url=$1, blob_access=$2, b64=NULL WHERE id=$3`, [r.url, a, f.id]); moved++; }
    catch (e) { errors.push(`#${f.id}: ${String(e && e.message || e).slice(0, 100)}`); break; }
  }
  const left = (await q(`SELECT count(*)::int n FROM files WHERE blob_url IS NULL AND b64 IS NOT NULL`))[0].n;
  const inBlob = (await q(`SELECT count(*)::int n FROM files WHERE blob_url IS NOT NULL`))[0].n;
  return { configured: true, moved, left, inBlob, errors };
}
export async function blobStatus() {
  const left = (await q(`SELECT count(*)::int n FROM files WHERE blob_url IS NULL AND b64 IS NOT NULL`))[0].n;
  const inBlob = (await q(`SELECT count(*)::int n FROM files WHERE blob_url IS NOT NULL`))[0].n;
  return { configured: blobOn(), left, inBlob };
}

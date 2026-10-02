// Application for Employment: clean the submitted answers and keep sensitive parts from view-only accounts.
const MAX_JSON = 80 * 1024;
function clean(v, depth = 0) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim().slice(0, 1500);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1));
  if (typeof v === 'object') { const o = {}; Object.keys(v).slice(0, 200).forEach((k) => { if (/^[\w.-]{1,40}$/.test(k)) o[k] = clean(v[k], depth + 1); }); return o; }
  return null;
}
export function cleanForm(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const c = clean(f); if (JSON.stringify(c).length > MAX_JSON) throw Object.assign(new Error('The application form is too long. Please shorten some answers.'), { status: 413 });
  return c;
}
const SENSITIVE = /^(sss|tin|philhealth|pagibig|passport|gid_type|gid_no|med_.*|sex|gender|gender_other|religion)$/;
export function redact(f, role) {
  if (!f || role !== 'viewer') return f;
  const o = {}; Object.keys(f).forEach((k) => { o[k] = SENSITIVE.test(k) ? '•••' : f[k]; }); return o;
}
export const UP_KINDS = ['photo', 'valid_id', 'location_map', 'resume', 'signature'];

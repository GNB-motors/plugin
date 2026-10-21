/**
 * Plain-language times for the popup: "just now", "4 min ago", "in 25 min".
 * Never a ticking clock — the popup is glanced at, not watched.
 */

const toTime = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

function span(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** "just now" / "4 min ago" / "3 h ago" / "2 days ago"; null when unknown. */
export function ago(input, now = Date.now()) {
  const t = toTime(input);
  if (t == null) return null;
  const ms = now - t;
  if (ms < 60000) return 'just now';
  return `${span(ms)} ago`;
}

/** "in 25 min" / "in 3 h"; "now" when due or past; null when unknown. */
export function until(input, now = Date.now()) {
  const t = toTime(input);
  if (t == null) return null;
  const ms = t - now;
  if (ms < 60000) return 'now';
  return `in ${span(ms)}`;
}

/** Minutes until `input` (negative once past); null when unknown. */
export function minutesUntil(input, now = Date.now()) {
  const t = toTime(input);
  return t == null ? null : Math.floor((t - now) / 60000);
}

/** Long guidance needs longer on screen: ~60 ms a character, between 3 and 9 s. */
export function toastDurationMs(message) {
  const n = String(message || '').length;
  return Math.min(9000, Math.max(3000, n * 60));
}

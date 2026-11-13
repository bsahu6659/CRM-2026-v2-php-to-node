/** Display formatting. Locale and currency come from the signed-in org. */

let locale = 'en-IN';
let currency = 'INR';

export function configureFormatting(org) {
  if (org?.locale) locale = org.locale;
  if (org?.currency) currency = org.currency;
}

const numberFmt = () => new Intl.NumberFormat(locale);

export function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? numberFmt().format(n) : '0';
}

export function money(value, { compact = false } = {}) {
  const n = Number(value) || 0;
  if (compact) return `${currencySymbol()}${compactNumber(n)}`;
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(n);
}

export function currencySymbol() {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 })
      .formatToParts(0).find((p) => p.type === 'currency')?.value || '';
  } catch { return ''; }
}

/**
 * Compact numbers. Indian locales get lakh/crore because "₹1.2Cr" is what a
 * sales manager in this market actually reads; everyone else gets K/M/B.
 */
export function compactNumber(value) {
  const n = Math.abs(Number(value) || 0);
  const sign = value < 0 ? '-' : '';
  if (locale.endsWith('IN')) {
    if (n >= 1e7) return `${sign}${trim(n / 1e7)}Cr`;
    if (n >= 1e5) return `${sign}${trim(n / 1e5)}L`;
    if (n >= 1e3) return `${sign}${trim(n / 1e3)}K`;
  } else {
    if (n >= 1e9) return `${sign}${trim(n / 1e9)}B`;
    if (n >= 1e6) return `${sign}${trim(n / 1e6)}M`;
    if (n >= 1e3) return `${sign}${trim(n / 1e3)}K`;
  }
  return `${sign}${Math.round(n)}`;
}
const trim = (n) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);

export const percent = (value, digits = 1) => `${(Number(value) || 0).toFixed(digits).replace(/\.0$/, '')}%`;

export function date(value, opts = {}) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric', ...opts });
}

export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function time(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** "3 days ago" / "in 2 hours". Past and future both read naturally. */
export function relative(value) {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units = [
    ['year', 31536e6], ['month', 2592e6], ['week', 6048e5],
    ['day', 864e5], ['hour', 36e5], ['minute', 6e4],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') return rtf.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

/** Date value for <input type="date"> / "datetime-local". */
export function inputDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
export function inputDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function duration(seconds) {
  const s = Number(seconds) || 0;
  if (!s) return '—';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m ? `${m}m ${r}s` : `${r}s`;
}

export function initials(...parts) {
  const text = parts.filter(Boolean).join(' ').trim();
  if (!text) return '?';
  const words = text.split(/\s+/);
  return ((words[0]?.[0] || '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

/** Stable per-name avatar colour, so the same person is always the same hue.
 *  All of these are deep enough to carry white initials — the bright brand
 *  green is not, so the deep logo green stands in for it here. */
const AVATAR_COLORS = ['#0f833b', '#0891b2', '#0a5c2b', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0284c7', '#65a30d', '#c2410c'];
export function avatarColor(seed = '') {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 9973;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export const titleCase = (value) => String(value || '')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

export const fileSize = (bytes) => {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
};

export const PRIORITY_TONE = { LOW: 'badge', MEDIUM: 'badge badge-info', HIGH: 'badge badge-warning', URGENT: 'badge badge-danger' };
export const SCORE_TONE = { COLD: '#0284c7', WARM: '#d97706', HOT: '#ea580c', VERY_HOT: '#dc2626' };
export const TASK_TONE = { PENDING: 'badge', IN_PROGRESS: 'badge badge-info', COMPLETED: 'badge badge-success', CANCELLED: 'badge' };

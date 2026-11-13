/**
 * White-label repaint.
 *
 * Only the brand ramp is overridden - never the ink, surface or semantic
 * colours - because those carry the contrast guarantees the palette was built
 * around, and a client picking a pale brand colour must not be able to make
 * their own text unreadable. `--on-brand` is recomputed from the chosen colour
 * so button labels stay legible whichever brand is loaded.
 *
 * Called by AuthProvider every time the session loads, and with `null` when it
 * ends, so the sign-in screen after a sign-out is Growvanta's own colours
 * rather than the previous tenant's.
 */
export function applyBranding(branding) {
  const root = document.documentElement;
  const tokens = ['--brand-500', '--brand-600', '--on-brand'];
  if (!branding?.primary) {
    tokens.forEach((t) => root.style.removeProperty(t));
    return;
  }
  root.style.setProperty('--brand-500', branding.primary);
  root.style.setProperty('--brand-600', shade(branding.primary, -0.28));
  root.style.setProperty('--on-brand', readableOn(branding.primary));
}

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));

function parseHex(hex) {
  const clean = String(hex || '').replace('#', '');
  if (clean.length !== 6) return null;
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
}

function shade(hex, amount) {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const shifted = rgb.map((c) => clamp255(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount));
  return `#${shifted.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance, used to pick dark or light text over the brand. */
function readableOn(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return '#0d1b2a';
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // 0.45 is where white-on-colour and near-black-on-colour cross over for
  // 4.5:1; above it the dark ink wins, below it white does.
  return luminance > 0.45 ? '#0d1b2a' : '#ffffff';
}

/**
 * Display labels and data-scope names for the permission catalogue.
 *
 * These mirror `server/src/lib/permissions.js`. They are labels only — the
 * server decides what is grantable, and /api/roles/catalogue is the
 * authoritative list once the roles module is ported. Keeping a copy here lets
 * the profile screen name a module without a second round trip.
 */
export const MODULE_LABELS = {
  dashboard: 'Dashboard',
  leads: 'Leads',
  projects: 'Projects',
  activities: 'Activities',
  documents: 'Documents',
  forms: 'Web Forms',
  reports: 'Reports & Analytics',
  targets: 'Targets & Performance',
  imports: 'Import / Export',
  users: 'Users',
  teams: 'Teams',
  roles: 'Roles & Permissions',
  settings: 'Organisation Settings',
  automation: 'Automation & Rules',
  integrations: 'Integrations',
  apikeys: 'API Keys',
  webhooks: 'Webhooks',
  audit: 'Audit Logs',
  templates: 'Message Templates',
  whatsapp: 'WhatsApp',
  email: 'Email',
  clients: 'Client Companies',
  global_projects: 'Global Project Master',
};

/**
 * Turns a stored enum into something readable: ORGANIZATION becomes
 * "Organization", CLOSED_WON becomes "Closed won". `titleCase` in format.js
 * deliberately leaves existing capitals alone — it is shared with free text —
 * so SCREAMING_CASE needs its own pass.
 */
export function enumLabel(value) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  const spaced = text.replace(/[_-]+/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const SCOPE_LABELS = {
  OWN: 'Own records only',
  TEAM: 'Own + direct team',
  TEAM_AND_BELOW: 'Own team and all teams below',
  REGION: 'Entire region',
  ORGANIZATION: 'Entire organisation',
  ALL: 'All organisations (platform owner)',
};

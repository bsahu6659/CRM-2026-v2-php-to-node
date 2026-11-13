/**
 * Shared condition evaluator for assignment rules and automation workflows —
 * port of services/Conditions.php. Stored shape is unchanged:
 * { match: "ALL"|"ANY", conditions: [{ field, operator, value }] }, so rules
 * created under either backend evaluate identically here.
 *
 * Everything in this module is pure (no I/O), so it stays synchronous.
 */

import { safeJson } from '../lib/util.js';

export const GV_OPERATORS = [
  { key: 'eq', label: 'is' },
  { key: 'neq', label: 'is not' },
  { key: 'contains', label: 'contains' },
  { key: 'not_contains', label: 'does not contain' },
  { key: 'starts_with', label: 'starts with' },
  { key: 'in', label: 'is any of' },
  { key: 'not_in', label: 'is none of' },
  { key: 'gt', label: 'greater than' },
  { key: 'gte', label: 'greater or equal' },
  { key: 'lt', label: 'less than' },
  { key: 'lte', label: 'less or equal' },
  { key: 'is_empty', label: 'is empty' },
  { key: 'is_not_empty', label: 'is not empty' },
  { key: 'changed', label: 'changed' },
];

export const GV_LEAD_FIELDS = [
  { key: 'projectId', label: 'Project', type: 'project' },
  { key: 'project.city', label: 'Project City', type: 'text' },
  { key: 'project.projectType', label: 'Project Type', type: 'enum',
    options: ['RESIDENTIAL', 'COMMERCIAL', 'MIXED_USE', 'PLOTTED', 'VILLA'] },
  { key: 'configuration', label: 'Configuration', type: 'text' },
  { key: 'budgetMax', label: 'Budget (max)', type: 'number' },
  { key: 'purpose', label: 'Purpose', type: 'enum', options: ['END_USE', 'INVESTMENT'] },
  { key: 'source.key', label: 'Lead Source', type: 'source' },
  { key: 'utmCampaign', label: 'UTM Campaign', type: 'text' },
  { key: 'status.key', label: 'Lead Status', type: 'status' },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'pincode', label: 'Pincode', type: 'text' },
  { key: 'company', label: 'Company', type: 'text' },
  { key: 'jobTitle', label: 'Job Title', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'medium', label: 'Medium', type: 'text' },
  { key: 'utmSource', label: 'UTM Source', type: 'text' },
  { key: 'utmCampaign', label: 'UTM Campaign', type: 'text' },
  { key: 'utmMedium', label: 'UTM Medium', type: 'text' },
  { key: 'landingPage', label: 'Landing Page', type: 'text' },
  { key: 'score', label: 'Lead Score', type: 'number' },
  { key: 'scoreBand', label: 'Score Band', type: 'enum', options: ['COLD', 'WARM', 'HOT', 'VERY_HOT'] },
  { key: 'priority', label: 'Priority', type: 'enum', options: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
  { key: 'expectedValue', label: 'Expected Value', type: 'number' },
  { key: 'product', label: 'Product / Interest', type: 'text' },
  { key: 'ownerId', label: 'Owner', type: 'user' },
  { key: 'teamId', label: 'Team', type: 'team' },
];

const OPERATOR_KEYS = GV_OPERATORS.map((o) => o.key);

// ---------------------------------------------------------------------------
// PHP scalar semantics. Rules were authored against PHP's loose string/number
// casts, so the evaluator reproduces them rather than JavaScript's: (string)
// of a boolean is "1"/"", (float) of "12abc" is 12, and so on.
// ---------------------------------------------------------------------------
function isRecord(value) {
  return value !== null && typeof value === 'object';
}

function phpStr(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  if (typeof value === 'object') return 'Array';
  return String(value);
}

function phpFloat(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return Object.keys(value).length ? 1 : 0;
  const n = Number.parseFloat(String(value).trim());
  return Number.isNaN(n) ? 0 : n;
}

function phpEmpty(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function gvGetPath(record, path) {
  if (path.startsWith('customFields.')) {
    const cf = safeJson(record?.customFields ?? [], []);
    if (!isRecord(cf)) return null;
    const key = path.slice(13);
    return Object.prototype.hasOwnProperty.call(cf, key) ? cf[key] ?? null : null;
  }
  const segments = path.split('.');
  let value = record;
  for (const seg of segments) {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, seg)) {
      return null;
    }
    value = value[seg];
  }
  return value === undefined ? null : value;
}

export function gvNorm(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export function gvToList(value) {
  if (Array.isArray(value)) {
    return value.map(gvNorm);
  }
  if (isRecord(value)) {
    return Object.values(value).map(gvNorm);
  }
  return phpStr(value)
    .split(',')
    .map((v) => gvNorm(v.trim()))
    .filter((v) => v !== '');
}

export function evaluateCondition(record, condition, context = {}) {
  const field = condition?.field ?? null;
  const operator = condition?.operator ?? null;
  const value = condition?.value ?? null;
  if (phpEmpty(field) || !OPERATOR_KEYS.includes(operator)) {
    return false;
  }

  const actual = gvGetPath(record, String(field));
  const a = gvNorm(actual);
  const b = gvNorm(value);

  switch (operator) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'contains': return b !== '' && phpStr(a).includes(phpStr(b));
    case 'not_contains': return !phpStr(a).includes(phpStr(b));
    case 'starts_with': return b !== '' && phpStr(a).startsWith(phpStr(b));
    case 'in': return gvToList(value).includes(a);
    case 'not_in': return !gvToList(value).includes(a);
    case 'gt': return phpFloat(actual) > phpFloat(value);
    case 'gte': return phpFloat(actual) >= phpFloat(value);
    case 'lt': return phpFloat(actual) < phpFloat(value);
    case 'lte': return phpFloat(actual) <= phpFloat(value);
    case 'is_empty': return actual === null || phpStr(actual).trim() === '';
    case 'is_not_empty': return !(actual === null || phpStr(actual).trim() === '');
    case 'changed': {
      const changes = context?.changes ?? {};
      return isRecord(changes) && Object.prototype.hasOwnProperty.call(changes, field);
    }
    default: return false;
  }
}

/** An empty group matches everything. */
export function evaluateGroup(record, group, context = {}) {
  const parsed = isRecord(group) ? group : safeJson(group, { match: 'ALL', conditions: [] });
  const conditions = isRecord(parsed) ? parsed.conditions ?? [] : [];
  if (phpEmpty(conditions) || (isRecord(conditions) && Object.keys(conditions).length === 0)) {
    return true;
  }
  if (!isRecord(conditions)) {
    // PHP's array_map() throws on a scalar here; failing loudly beats quietly
    // treating a corrupt rule as a catch-all.
    throw new TypeError('conditions must be an array');
  }
  const list = Array.isArray(conditions) ? conditions : Object.values(conditions);
  const results = list.map((c) => evaluateCondition(record, c, context));
  return String(parsed.match ?? 'ALL').toUpperCase() === 'ANY'
    ? results.includes(true)
    : !results.includes(false);
}

export function validateConditionGroup(group) {
  const parsed = isRecord(group) ? group : safeJson(group, null);
  if (!isRecord(parsed)) {
    return { ok: false, message: 'Conditions must be an object' };
  }
  const match = phpStr(parsed.match ?? 'ALL').toUpperCase();
  if (!['ALL', 'ANY'].includes(match)) {
    return { ok: false, message: 'match must be ALL or ANY' };
  }
  // Reject anything we do not understand rather than ignoring it. A typo in
  // the payload key would otherwise leave `conditions` empty, and an empty
  // group matches every record - silently converting a targeted rule into a
  // catch-all that misroutes the whole pipeline.
  const unknown = Object.keys(parsed).filter((k) => !['match', 'conditions'].includes(k));
  if (unknown.length) {
    return { ok: false, message: `Unexpected key in conditions: ${unknown.join(', ')}` };
  }
  const conditions = parsed.conditions ?? [];
  if (!isRecord(conditions)) {
    return { ok: false, message: 'conditions must be a list' };
  }
  for (const c of Array.isArray(conditions) ? conditions : Object.values(conditions)) {
    const cField = isRecord(c) ? c.field : undefined;
    if (phpEmpty(cField) || typeof cField !== 'string') {
      return { ok: false, message: 'Every condition needs a field' };
    }
    const cOperator = isRecord(c) ? c.operator ?? null : null;
    if (!OPERATOR_KEYS.includes(cOperator)) {
      return { ok: false, message: `Unsupported operator: ${phpStr(cOperator)}` };
    }
  }
  return { ok: true, value: { match, conditions } };
}

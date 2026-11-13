/**
 * Workflow automation engine — port of services/Automation.php.
 *
 * A workflow is: trigger (a domain event) + condition group + ordered action
 * list. Anything that calls emitDomainEvent() gets automation for free once
 * the event is dispatched (after the response has gone out).
 *
 * Two safety properties carried over:
 *  - Actions run one at a time and every run is logged, so a partial run is
 *    visible in workflow_runs rather than silently half-applied.
 *  - `depth` guards re-entrancy (an action that eventually re-emits an event
 *    could otherwise loop forever); GV_AUTOMATION_MAX_DEPTH mirrors the original.
 */

import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { addDays, gvBool, gvId, safeJson, toCamelCase, toJson } from '../lib/util.js';
import { resolveAssignment } from './assignment.js';
import { evaluateGroup } from './conditions.js';
import { onDomainEvent } from './events.js';
import { leadBuildContext } from './leadService.js';
import { notifyUser } from './notifications.js';
import { scoreBandFor } from './scoring.js';

export const GV_AUTOMATION_MAX_DEPTH = 3;

export const GV_AUTOMATION_TRIGGERS = [
  { key: 'lead.created', label: 'Lead is created', entity: 'LEAD' },
  { key: 'lead.updated', label: 'Lead is updated', entity: 'LEAD' },
  { key: 'lead.status_changed', label: 'Lead status changes', entity: 'LEAD' },
  { key: 'lead.assigned', label: 'Lead is assigned', entity: 'LEAD' },
  { key: 'lead.converted', label: 'Lead is converted', entity: 'LEAD' },
];

export const GV_AUTOMATION_ACTIONS = [
  { key: 'assign_owner', label: 'Assign to a specific user', params: [{ key: 'userId', type: 'user', required: true }] },
  { key: 'assign_team', label: 'Assign to a team', params: [{ key: 'teamId', type: 'team', required: true }] },
  { key: 'run_assignment_rules', label: 'Run the assignment rule chain', params: [] },
  { key: 'set_status', label: 'Set lead status', params: [{ key: 'statusKey', type: 'status', required: true }] },
  { key: 'set_priority', label: 'Set priority', params: [{ key: 'priority', type: 'enum', options: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], required: true }] },
  { key: 'set_field', label: 'Set a field value', params: [{ key: 'field', type: 'text', required: true }, { key: 'value', type: 'text' }] },
  { key: 'add_tag', label: 'Add a tag', params: [{ key: 'tag', type: 'text', required: true }] },
  { key: 'adjust_score', label: 'Adjust lead score', params: [{ key: 'points', type: 'number', required: true }] },
  { key: 'set_follow_up', label: 'Schedule next follow-up', params: [{ key: 'inDays', type: 'number', required: true }] },
  { key: 'notify', label: 'Send a notification', params: [
    { key: 'target', type: 'enum', options: ['OWNER', 'MANAGER', 'TEAM_MANAGER', 'USER'], required: true },
    { key: 'userId', type: 'user' },
    { key: 'title', type: 'text', required: true },
    { key: 'body', type: 'text' },
  ] },
  { key: 'log_activity', label: 'Log a timeline note', params: [{ key: 'subject', type: 'text', required: true }, { key: 'body', type: 'text' }] },
];

const ACTION_MAP = Object.fromEntries(GV_AUTOMATION_ACTIONS.map((a) => [a.key, a]));

// ---------------------------------------------------------------------------
// PHP semantics. Workflow params are free-form JSON authored in the UI, so a
// number-as-string or a missing key must behave as it did under PHP's casts.
// ---------------------------------------------------------------------------
function isRecord(value) {
  return value !== null && typeof value === 'object';
}

function phpEmpty(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
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

function phpInt(value) {
  return Math.trunc(phpFloat(value));
}

/** A request value as PDO would have bound it (mysql2 expands arrays/objects). */
function scalarParam(value) {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object') return 'Array';
  if (typeof value === 'boolean') return value ? '1' : '';
  return value;
}

/**
 * PHP's camelize() over an event payload. The payload is a lead context —
 * scalars plus flat source/status/project sub-rows — so PHP renamed two
 * levels of keys and never looked inside JSON columns, which were strings to
 * it. mysql2 decodes those columns, so a blind deep camelize would rename
 * custom-field keys and break `customFields.some_key` conditions.
 */
function camelizeContext(data) {
  if (!isRecord(data) || Array.isArray(data)) return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    const key = toCamelCase(k);
    if (key === 'customFields' || !isRecord(v) || Array.isArray(v)) {
      out[key] = v;
    } else {
      const nested = {};
      for (const [nk, nv] of Object.entries(v)) nested[toCamelCase(nk)] = nv;
      out[key] = nested;
    }
  }
  return out;
}

export function gvAutomationActionMap() {
  return ACTION_MAP;
}

export function validateActions(actions) {
  const parsed = isRecord(actions) ? actions : safeJson(actions, null);
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'Actions must be an array' };
  }
  const map = gvAutomationActionMap();
  for (const action of parsed) {
    const type = isRecord(action) ? action.type : undefined;
    if (!isRecord(action) || typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(map, type)) {
      return { ok: false, message: `Unsupported action: ${phpStr(type ?? '')}` };
    }
    const spec = map[type];
    for (const p of spec.params) {
      const supplied = isRecord(action.params) ? action.params[p.key] : undefined;
      if (!phpEmpty(p.required) && (supplied ?? '') === '') {
        return { ok: false, message: `Action "${spec.label}" needs "${p.key}"` };
      }
    }
  }
  return { ok: true, value: parsed };
}

// ----------------------------------------------------------------------------
// Action implementations
// ----------------------------------------------------------------------------

export const GV_SETTABLE_LEAD_FIELDS = {
  priority: 'priority', medium: 'medium', company: 'company', jobTitle: 'job_title',
  city: 'city', state: 'state', country: 'country', expectedValue: 'expected_value',
  notes: 'notes', lostReason: 'lost_reason', rating: 'rating',
};

export async function automationResolveNotifyTarget(target, params, record) {
  switch (target) {
    case 'USER':
      return params.userId ?? null;
    case 'OWNER':
      return record.ownerId ?? null;
    case 'CREATOR':
      return record.createdById ?? null;
    case 'MANAGER':
      if (phpEmpty(record.ownerId)) {
        return null;
      }
      return dbScalar('SELECT manager_id FROM users WHERE id = ?', [record.ownerId]);
    case 'TEAM_MANAGER':
      if (phpEmpty(record.teamId)) {
        return null;
      }
      return dbScalar('SELECT manager_id FROM teams WHERE id = ?', [record.teamId]);
    default:
      return null;
  }
}

/** Runs one action; appends a human-readable line to `log` (PHP's `array &$log`). */
export async function automationRunAction(action, orgId, entityType, record, log) {
  const params = isRecord(action.params) ? action.params : {};
  const type = action.type ?? '';

  switch (type) {
    case 'assign_owner': {
      if (entityType !== 'LEAD') {
        log.push('assign_owner skipped: not a lead');
        return;
      }
      const user = await dbOne(
        'SELECT * FROM users WHERE id = ? AND organization_id = ? AND is_active = 1',
        [scalarParam(params.userId ?? null), orgId]
      );
      if (!user) {
        log.push('assign_owner skipped: user not found');
        return;
      }
      await dbExec('UPDATE leads SET owner_id = ?, assigned_at = NOW() WHERE id = ?', [user.id, record.id]);
      await dbExec(
        'INSERT INTO activities (id, organization_id, type, subject, lead_id, occurred_at, created_at) VALUES (?,?,?,?,?,NOW(),NOW())',
        [gvId(), orgId, 'ASSIGNMENT', `Automation assigned to ${`${phpStr(user.first_name)} ${phpStr(user.last_name ?? '')}`.trim()}`, record.id]
      );
      await notifyUser(orgId, user.id, 'LEAD_ASSIGNED',
        `New lead assigned: ${`${phpStr(record.firstName ?? '')} ${phpStr(record.lastName ?? '')}`.trim()}`,
        'Assigned automatically by a workflow.', 'LEAD', record.id, `#/leads/${record.id}`);
      log.push(`assigned owner ${phpStr(user.email)}`);
      return;
    }

    case 'assign_team': {
      if (entityType !== 'LEAD') {
        log.push('assign_team skipped: not a lead');
        return;
      }
      const team = await dbOne('SELECT * FROM teams WHERE id = ? AND organization_id = ?', [scalarParam(params.teamId ?? null), orgId]);
      if (!team) {
        log.push('assign_team skipped: team not found');
        return;
      }
      await dbExec('UPDATE leads SET team_id = ? WHERE id = ?', [team.id, record.id]);
      log.push(`assigned team ${phpStr(team.name)}`);
      return;
    }

    case 'run_assignment_rules': {
      if (entityType !== 'LEAD') {
        log.push('run_assignment_rules skipped: not a lead');
        return;
      }
      const full = await dbOne('SELECT * FROM leads WHERE id = ?', [record.id]);
      if (!full) {
        log.push('run_assignment_rules skipped: lead not found');
        return;
      }
      const target = await resolveAssignment(await leadBuildContext(full));
      if (!target) {
        log.push('run_assignment_rules: no rule matched');
        return;
      }
      await dbExec(
        'UPDATE leads SET owner_id = ?, team_id = ?, assigned_at = NOW() WHERE id = ?',
        [target.ownerId ?? null, target.teamId ?? null, record.id]
      );
      if (target.ownerId) {
        await notifyUser(orgId, target.ownerId, 'LEAD_ASSIGNED',
          `New lead assigned: ${`${phpStr(record.firstName ?? '')} ${phpStr(record.lastName ?? '')}`.trim()}`,
          `Matched rule "${phpStr(target.ruleName)}".`, 'LEAD', record.id, `#/leads/${record.id}`);
      }
      log.push(`assignment rules matched "${phpStr(target.ruleName)}"`);
      return;
    }

    case 'set_status': {
      if (entityType !== 'LEAD') {
        log.push('set_status skipped: not a lead');
        return;
      }
      const status = await dbOne(
        'SELECT * FROM lead_statuses WHERE organization_id = ? AND `key` = ?',
        [orgId, scalarParam(params.statusKey ?? null)]
      );
      if (!status) {
        log.push(`set_status skipped: unknown status ${phpStr(params.statusKey ?? '')}`);
        return;
      }
      const extra = [];
      const vals = [status.id];
      if (gvBool(status.is_qualified)) {
        extra.push('qualified_at = NOW()');
      }
      if (gvBool(status.is_lost)) {
        extra.push('lost_at = NOW()');
      }
      const sql = `UPDATE leads SET status_id = ?${extra.length ? `, ${extra.join(', ')}` : ''} WHERE id = ?`;
      await dbExec(sql, [...vals, record.id]);
      await dbExec(
        'INSERT INTO activities (id, organization_id, type, subject, lead_id, occurred_at, created_at) VALUES (?,?,?,?,?,NOW(),NOW())',
        [gvId(), orgId, 'STATUS_CHANGE', `Automation set status to ${status.name}`, record.id]
      );
      log.push(`status set to ${status.name}`);
      return;
    }

    case 'set_priority':
      if (entityType !== 'LEAD') {
        log.push('set_priority skipped: not a lead');
        return;
      }
      await dbExec('UPDATE leads SET priority = ? WHERE id = ?', [scalarParam(params.priority ?? 'MEDIUM'), record.id]);
      log.push(`priority set to ${phpStr(params.priority ?? 'MEDIUM')}`);
      return;

    case 'set_field': {
      if (entityType !== 'LEAD') {
        log.push('set_field skipped: not a lead');
        return;
      }
      const field = phpStr(params.field ?? '');
      if (!Object.prototype.hasOwnProperty.call(GV_SETTABLE_LEAD_FIELDS, field)) {
        log.push(`set_field refused: ${field} is not settable`);
        return;
      }
      const column = GV_SETTABLE_LEAD_FIELDS[field];
      const value = field === 'expectedValue' ? phpFloat(params.value ?? 0) : scalarParam(params.value ?? null);
      await dbExec(`UPDATE leads SET \`${column}\` = ? WHERE id = ?`, [value, record.id]);
      log.push(`${field} set`);
      return;
    }

    case 'add_tag': {
      if (entityType !== 'LEAD') {
        log.push('add_tag skipped: not a lead');
        return;
      }
      const name = phpStr(params.tag ?? '').trim();
      if (name === '') {
        log.push('add_tag skipped: empty tag');
        return;
      }
      const tag = await dbOne('SELECT * FROM tags WHERE organization_id = ? AND name = ?', [orgId, name]);
      const tagId = tag?.id ?? gvId();
      if (!tag) {
        await dbExec('INSERT INTO tags (id, organization_id, name, created_at) VALUES (?,?,?,NOW())', [tagId, orgId, name]);
      }
      const existing = await dbOne('SELECT id FROM lead_tags WHERE lead_id = ? AND tag_id = ?', [record.id, tagId]);
      if (!existing) {
        await dbExec('INSERT INTO lead_tags (id, lead_id, tag_id) VALUES (?,?,?)', [gvId(), record.id, tagId]);
      }
      log.push(`tagged "${name}"`);
      return;
    }

    case 'adjust_score': {
      if (entityType !== 'LEAD') {
        log.push('adjust_score skipped: not a lead');
        return;
      }
      const current = phpInt(await dbScalar('SELECT score FROM leads WHERE id = ?', [record.id]));
      const score = Math.max(0, Math.min(100, current + phpInt(params.points ?? 0)));
      await dbExec('UPDATE leads SET score = ?, score_band = ? WHERE id = ?', [score, scoreBandFor(score), record.id]);
      log.push(`score adjusted by ${phpStr(params.points ?? 0)} to ${score}`);
      return;
    }

    case 'set_follow_up': {
      if (entityType !== 'LEAD') {
        log.push('set_follow_up skipped: not a lead');
        return;
      }
      const days = phpInt(params.inDays ?? 1);
      await dbExec('UPDATE leads SET next_follow_up_at = ? WHERE id = ?', [addDays(new Date(), days), record.id]);
      log.push(`follow-up scheduled in ${days} day(s)`);
      return;
    }

    case 'notify': {
      const userId = await automationResolveNotifyTarget(phpStr(params.target ?? ''), params, record);
      if (!userId) {
        log.push(`notify skipped: no ${phpStr(params.target ?? '')}`);
        return;
      }
      await notifyUser(orgId, scalarParam(userId), 'SYSTEM_ALERT', phpStr(params.title ?? ''),
        params.body === null || params.body === undefined ? null : phpStr(params.body), entityType, record.id,
        entityType === 'LEAD' ? `#/leads/${record.id}` : '#/opportunities');
      log.push(`notified ${phpStr(params.target ?? '')}`);
      return;
    }

    case 'log_activity':
      await dbExec(
        `INSERT INTO activities (id, organization_id, type, subject, body, lead_id, opportunity_id, occurred_at, created_at)
         VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
        [
          gvId(), orgId, 'SYSTEM', phpStr(params.subject ?? ''),
          params.body === null || params.body === undefined ? null : phpStr(params.body),
          entityType === 'LEAD' ? record.id : (record.leadId ?? null),
          entityType === 'OPPORTUNITY' ? record.id : null,
        ]
      );
      log.push('activity logged');
      return;

    default:
      log.push(`unknown action ${phpStr(type)}`);
  }
}

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

export async function runWorkflowsFor(trigger, payload) {
  const orgId = payload.organizationId ?? null;
  const data = camelizeContext(payload.data ?? null);
  if (!orgId || !isRecord(data) || phpEmpty(data.id)) {
    return;
  }
  const depth = payload.depth ?? 0;
  if (depth >= GV_AUTOMATION_MAX_DEPTH) {
    console.error(`[automation] depth limit reached for ${trigger}; not cascading further.`);
    return;
  }
  const entityType = payload.entityType ?? 'LEAD';
  const changes = payload.changes ?? [];

  const workflows = await dbAll(
    'SELECT * FROM workflows WHERE organization_id = ? AND trigger_key = ? AND is_active = 1 ORDER BY priority ASC, created_at ASC',
    [orgId, trigger]
  );
  if (!workflows.length) {
    return;
  }

  for (const workflow of workflows) {
    const log = [];
    let status = 'SUCCESS';
    let error = null;
    try {
      if (!evaluateGroup(data, workflow.conditions, { changes })) {
        status = 'SKIPPED';
        log.push('conditions not met');
      } else {
        const actions = safeJson(workflow.actions, []);
        for (const action of Array.isArray(actions) ? actions : Object.values(actions ?? {})) {
          if (!isRecord(action)) {
            // PHP's `array $action` parameter rejected this with a TypeError,
            // which failed the run; mirrored rather than skipped silently.
            throw new TypeError('workflow action must be an object');
          }
          await automationRunAction(action, orgId, entityType, data, log);
        }
      }
    } catch (err) {
      status = 'FAILED';
      const message = err?.message ?? String(err);
      error = message.slice(0, 500);
      console.error(`[automation] workflow "${workflow.name}" failed: ${message}`);
    }

    try {
      await dbExec(
        'INSERT INTO workflow_runs (id, workflow_id, organization_id, entity_type, entity_id, status, log, error, created_at) VALUES (?,?,?,?,?,?,?,?,NOW())',
        [gvId(), workflow.id, orgId, entityType, data.id, status, toJson(log), error]
      );
      if (status !== 'SKIPPED') {
        await dbExec('UPDATE workflows SET run_count = run_count + 1, last_run_at = NOW() WHERE id = ?', [workflow.id]);
      }
    } catch (err) {
      console.error(`[automation] failed to record workflow run: ${err?.message ?? err}`);
    }
  }
}

export function registerAutomationListeners() {
  for (const t of GV_AUTOMATION_TRIGGERS) {
    onDomainEvent(t.key, async (payload) => {
      try {
        await runWorkflowsFor(t.key, { entityType: t.entity, ...payload });
      } catch (err) {
        console.error(`[automation] runner error: ${err?.message ?? err}`);
      }
    });
  }
}

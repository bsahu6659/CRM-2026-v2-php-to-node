/**
 * /api/automation/* — assignment rules, scoring rules, workflows and follow-up
 * sequences (port of api/automation.php).
 */

import express from 'express';
import { dbAll, dbExec, dbOne } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { camelize, gvDiff, gvId, safeJson, toJson } from '../lib/util.js';
import { boolVal, validate } from '../lib/validate.js';
import { GV_LEAD_FIELDS, GV_OPERATORS, evaluateGroup, validateConditionGroup } from '../services/conditions.js';
import { GV_AUTOMATION_ACTIONS, GV_AUTOMATION_TRIGGERS, validateActions } from '../services/automation.js';
import { GV_ASSIGNMENT_STRATEGIES } from '../services/assignment.js';
import { GV_SCORE_BANDS, GV_SCORING_KINDS, computeScore } from '../services/scoring.js';
import { leadBuildContext } from '../services/leadService.js';
import { projectVisibleWhere } from '../services/projects.js';

const router = express.Router();

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** PHP's empty(). */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** `$x ?: null` */
const orNull = (value) => (isEmpty(value) ? null : value);

/** PHP's (int) cast. */
function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const m = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(value);
    return m ? Math.trunc(Number(m[0])) || 0 : 0;
  }
  return 0;
}

/** What PHP's foreach walks: a list by index, a map by key, nothing otherwise. */
function phpEntries(value) {
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  if (value !== null && typeof value === 'object') return Object.entries(value);
  return [];
}

const keysOf = (list) => list.map((item) => item.key);

const EMPTY_GROUP = () => ({ match: 'ALL', conditions: [] });

async function automationValidateAssignmentPayload(input) {
  const group = await validateConditionGroup(input.conditions ?? EMPTY_GROUP());
  if (!group.ok) {
    throw badRequest(group.message);
  }
  const strategy = input.strategy ?? '';
  const targetUserIds = input.targetUserIds ?? [];
  const targetTeamId = input.targetTeamId ?? null;

  if (strategy === 'USER' && isEmpty(targetUserIds)) {
    throw badRequest('Choose the user this rule assigns to.');
  }
  if (['TEAM', 'TEAM_ROUND_ROBIN', 'MANAGER'].includes(strategy) && isEmpty(targetTeamId)) {
    throw badRequest('Choose the team this rule routes to.');
  }
  if (strategy === 'ROUND_ROBIN' && isEmpty(targetUserIds) && isEmpty(targetTeamId)) {
    throw badRequest('Round robin needs either a list of users or a team.');
  }
  return group.value;
}

function automationShapeRule(r) {
  const out = camelize(r);
  out.conditions = safeJson(r.conditions ?? '{}', EMPTY_GROUP());
  out.targetUserIds = safeJson(r.target_user_ids ?? '[]', []);
  return out;
}

function automationShapeWorkflow(r) {
  const out = camelize(r);
  out.conditions = safeJson(r.conditions ?? '{}', EMPTY_GROUP());
  out.actions = safeJson(r.actions ?? '[]', []);
  // The column is trigger_key (TRIGGER is reserved in MySQL); the API keeps the Node field name.
  out.trigger = r.trigger_key;
  delete out.triggerKey;
  return out;
}

async function automationLoadSequence(id) {
  const seq = await dbOne('SELECT * FROM followup_sequences WHERE id = ?', [id]);
  const steps = await dbAll('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY day_offset ASC, sort_order ASC', [id]);
  return { ...camelize(seq), steps: steps.map((s) => camelize(s)) };
}

async function insertSequenceSteps(sequenceId, steps) {
  for (const [i, raw] of phpEntries(steps)) {
    const s = raw !== null && typeof raw === 'object' ? raw : {};
    await dbExec(
      'INSERT INTO sequence_steps (id, sequence_id, day_offset, task_type, title, description, priority, sort_order) VALUES (?,?,?,?,?,?,?,?)',
      [
        gvId(), sequenceId, toInt(s.dayOffset ?? 1), s.taskType ?? 'FOLLOW_UP', s.title ?? null,
        s.description ?? null, s.priority ?? 'MEDIUM', i,
      ]
    );
  }
}

// ---------------------------------------------------------------------------
// GET /automation/metadata — everything the rule-builder UI needs to render itself.
// ---------------------------------------------------------------------------
router.get(
  '/metadata',
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const vis = await projectVisibleWhere(orgId);
    return jsonOk(res, {
      operators: GV_OPERATORS,
      leadFields: GV_LEAD_FIELDS,
      strategies: GV_ASSIGNMENT_STRATEGIES,
      triggers: GV_AUTOMATION_TRIGGERS,
      actions: GV_AUTOMATION_ACTIONS,
      scoringKinds: GV_SCORING_KINDS,
      scoreBands: GV_SCORE_BANDS,
      options: {
        sources: (await dbAll('SELECT id, `key`, name FROM lead_sources WHERE organization_id = ?', [orgId])).map((r) => camelize(r)),
        statuses: (await dbAll('SELECT id, `key`, name, color FROM lead_statuses WHERE organization_id = ?', [orgId])).map((r) =>
          camelize(r)
        ),
        teams: (await dbAll('SELECT id, name FROM teams WHERE organization_id = ?', [orgId])).map((r) => camelize(r)),
        users: (
          await dbAll(
            'SELECT id, first_name, last_name, email FROM users WHERE organization_id = ? AND is_active = 1 ORDER BY first_name ASC',
            [orgId]
          )
        ).map((r) => camelize(r)),
        sequences: (await dbAll('SELECT id, name FROM followup_sequences WHERE organization_id = ?', [orgId])).map((r) => camelize(r)),
        // Includes shared and global projects, because a broker routes
        // leads for stock they do not own.
        projects: (
          await dbAll(
            `SELECT projects.id, projects.name, projects.location FROM projects
              WHERE ${vis.sql} AND projects.is_active = 1 AND projects.is_archived = 0
              ORDER BY projects.name ASC`,
            vis.params
          )
        ).map((r) => camelize(r)),
      },
    });
  })
);

// ---------------------------------------------------------------------------
// Assignment rules
// ---------------------------------------------------------------------------
router.get(
  '/assignment-rules',
  requirePermission('automation', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll('SELECT * FROM assignment_rules WHERE organization_id = ? ORDER BY priority ASC, created_at ASC', [
      req.actor.organizationId,
    ]);
    return jsonOk(res, rows.map(automationShapeRule));
  })
);

// Dry run: shows which rule a hypothetical lead would match, changing nothing.
router.post(
  '/assignment-rules/test',
  requirePermission('automation', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    const sample = body.lead ?? {};
    const candidate = { ...sample, organizationId: orgId };
    if (!isEmpty(sample.sourceId)) {
      candidate.source = camelize(
        (await dbOne('SELECT * FROM lead_sources WHERE organization_id = ? AND id = ?', [orgId, sample.sourceId])) ?? []
      );
    }
    if (!isEmpty(sample.statusId)) {
      candidate.status = camelize(
        (await dbOne('SELECT * FROM lead_statuses WHERE organization_id = ? AND id = ?', [orgId, sample.statusId])) ?? []
      );
    }
    const rules = await dbAll(
      'SELECT * FROM assignment_rules WHERE organization_id = ? AND is_active = 1 ORDER BY priority ASC, created_at ASC',
      [orgId]
    );
    const evaluation = [];
    for (const r of rules) {
      evaluation.push({
        id: r.id,
        name: r.name,
        priority: toInt(r.priority),
        strategy: r.strategy,
        matched: await evaluateGroup(candidate, r.conditions),
      });
    }
    const firstMatch = evaluation.find((e) => e.matched) ?? null;
    return jsonOk(res, { evaluation, firstMatch, note: 'Dry run only - no rotation counters were advanced.' });
  })
);

router.post(
  '/assignment-rules',
  requirePermission('automation', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    validate(body)
      .required('name', 'Rule name').maxLength('name', 120)
      .required('strategy', 'Strategy').in('strategy', keysOf(GV_ASSIGNMENT_STRATEGIES))
      .validate();

    const conditions = await automationValidateAssignmentPayload(body);
    const ruleId = gvId();
    await dbExec(
      `INSERT INTO assignment_rules (id, organization_id, name, description, priority, is_active, conditions, strategy, target_user_ids, target_team_id, stop_on_match, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        ruleId, orgId, body.name, body.description ?? null, toInt(body.priority ?? 10),
        has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1,
        toJson(conditions), body.strategy, toJson(body.targetUserIds ?? []), body.targetTeamId ?? null,
        has(body, 'stopOnMatch') ? (boolVal(body.stopOnMatch) ? 1 : 0) : 1,
      ]
    );
    const row = await dbOne('SELECT * FROM assignment_rules WHERE id = ?', [ruleId]);
    await auditRecord(
      orgId,
      a,
      'assignment_rule.created',
      { entityType: 'ASSIGNMENT_RULE', entityId: ruleId, entityLabel: row.name },
      req
    );
    return jsonCreated(res, automationShapeRule(row));
  })
);

router.patch(
  '/assignment-rules/:id',
  requirePermission('automation', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM assignment_rules WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!before) throw notFound('Rule not found');

    const merged = {
      strategy: body.strategy ?? before.strategy,
      targetUserIds: body.targetUserIds ?? safeJson(before.target_user_ids, []),
      targetTeamId: has(body, 'targetTeamId') ? body.targetTeamId : before.target_team_id,
      conditions: body.conditions ?? safeJson(before.conditions, []),
    };
    const conditions = await automationValidateAssignmentPayload(merged);

    const data = {
      conditions: toJson(conditions),
      strategy: merged.strategy,
      target_user_ids: toJson(merged.targetUserIds),
      target_team_id: orNull(merged.targetTeamId),
    };
    if (has(body, 'name')) {
      data.name = body.name;
    }
    if (has(body, 'description')) {
      data.description = orNull(body.description);
    }
    if (has(body, 'priority')) {
      data.priority = toInt(body.priority);
    }
    if (has(body, 'isActive')) {
      data.is_active = boolVal(body.isActive) ? 1 : 0;
    }
    if (has(body, 'stopOnMatch')) {
      data.stop_on_match = boolVal(body.stopOnMatch) ? 1 : 0;
    }
    const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
    await dbExec(`UPDATE assignment_rules SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);

    const row = await dbOne('SELECT * FROM assignment_rules WHERE id = ?', [before.id]);
    await auditRecord(
      orgId,
      a,
      'assignment_rule.updated',
      {
        entityType: 'ASSIGNMENT_RULE',
        entityId: row.id,
        entityLabel: row.name,
        changes: gvDiff(before, row, ['name', 'priority', 'is_active', 'strategy', 'target_team_id']),
      },
      req
    );
    return jsonOk(res, automationShapeRule(row));
  })
);

router.delete(
  '/assignment-rules/:id',
  requirePermission('automation', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const row = await dbOne('SELECT * FROM assignment_rules WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!row) throw notFound('Rule not found');
    await dbExec('DELETE FROM assignment_rules WHERE id = ?', [row.id]);
    await auditRecord(
      orgId,
      a,
      'assignment_rule.deleted',
      { entityType: 'ASSIGNMENT_RULE', entityId: row.id, entityLabel: row.name },
      req
    );
    return jsonOk(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Scoring rules
// ---------------------------------------------------------------------------
router.get(
  '/scoring-rules',
  requirePermission('automation', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll('SELECT * FROM scoring_rules WHERE organization_id = ? ORDER BY sort_order ASC, created_at ASC', [
      req.actor.organizationId,
    ]);
    return jsonOk(res, rows.map((r) => camelize(r)));
  })
);

// Recomputes every lead's score, batched so a large org does not blow memory.
router.post(
  '/scoring-rules/recalculate',
  requirePermission('automation', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    let processed = 0;
    let changed = 0;
    let cursor = '';
    for (;;) {
      const batch = await dbAll(
        'SELECT * FROM leads WHERE organization_id = ? AND is_duplicate = 0 AND id > ? ORDER BY id ASC LIMIT 200',
        [orgId, cursor]
      );
      if (!batch.length) {
        break;
      }
      for (const lead of batch) {
        const scored = await computeScore(orgId, await leadBuildContext(lead));
        if (scored.score !== toInt(lead.score)) {
          await dbExec('UPDATE leads SET score = ?, score_band = ? WHERE id = ?', [scored.score, scored.band, lead.id]);
          changed++;
        }
        processed++;
      }
      cursor = batch[batch.length - 1].id;
      if (batch.length < 200) {
        break;
      }
    }
    await auditRecord(orgId, a, 'scoring.recalculated', { changes: { processed, changed } }, req);
    return jsonOk(res, { processed, changed });
  })
);

router.post(
  '/scoring-rules',
  requirePermission('automation', 'create'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    validate(body)
      .required('name', 'Rule name').maxLength('name', 120)
      .required('kind', 'Kind').in('kind', keysOf(GV_SCORING_KINDS))
      .validate();

    const ruleId = gvId();
    await dbExec(
      'INSERT INTO scoring_rules (id, organization_id, name, kind, field, operator, value, points, is_active, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())',
      [
        ruleId, orgId, body.name, body.kind, body.field ?? null, body.operator ?? null, body.value ?? null,
        toInt(body.points ?? 0), has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1, toInt(body.sortOrder ?? 0),
      ]
    );
    return jsonCreated(res, camelize(await dbOne('SELECT * FROM scoring_rules WHERE id = ?', [ruleId])));
  })
);

router.patch(
  '/scoring-rules/:id',
  requirePermission('automation', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM scoring_rules WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!before) throw notFound('Scoring rule not found');

    const data = {};
    for (const [camel, col] of [['name', 'name'], ['kind', 'kind'], ['field', 'field'], ['operator', 'operator'], ['value', 'value']]) {
      if (has(body, camel)) {
        data[col] = orNull(body[camel]);
      }
    }
    for (const [camel, col] of [['points', 'points'], ['sortOrder', 'sort_order']]) {
      if (has(body, camel)) {
        data[col] = toInt(body[camel]);
      }
    }
    if (has(body, 'isActive')) {
      data.is_active = boolVal(body.isActive) ? 1 : 0;
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE scoring_rules SET ${sets} WHERE id = ?`, [...Object.values(data), before.id]);
    }
    return jsonOk(res, camelize(await dbOne('SELECT * FROM scoring_rules WHERE id = ?', [before.id])));
  })
);

router.delete(
  '/scoring-rules/:id',
  requirePermission('automation', 'delete'),
  ah(async (req, res) => {
    const row = await dbOne('SELECT * FROM scoring_rules WHERE id = ? AND organization_id = ?', [
      req.params.id,
      req.actor.organizationId,
    ]);
    if (!row) throw notFound('Scoring rule not found');
    await dbExec('DELETE FROM scoring_rules WHERE id = ?', [row.id]);
    return jsonOk(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------
router.get(
  '/workflows',
  requirePermission('automation', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll('SELECT * FROM workflows WHERE organization_id = ? ORDER BY priority ASC, created_at DESC', [
      req.actor.organizationId,
    ]);
    return jsonOk(res, rows.map(automationShapeWorkflow));
  })
);

router.get(
  '/workflows/:id/runs',
  requirePermission('automation', 'read'),
  ah(async (req, res) => {
    const workflow = await dbOne('SELECT * FROM workflows WHERE id = ? AND organization_id = ?', [
      req.params.id,
      req.actor.organizationId,
    ]);
    if (!workflow) throw notFound('Workflow not found');
    const runs = await dbAll('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 100', [workflow.id]);
    return jsonOk(
      res,
      runs.map((r) => ({ ...camelize(r), log: safeJson(r.log ?? '[]', []) }))
    );
  })
);

router.post(
  '/workflows',
  requirePermission('automation', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    validate(body)
      .required('name', 'Workflow name').maxLength('name', 120)
      .required('trigger', 'Trigger').in('trigger', keysOf(GV_AUTOMATION_TRIGGERS))
      .validate();

    const group = await validateConditionGroup(body.conditions ?? EMPTY_GROUP());
    if (!group.ok) {
      throw badRequest(group.message);
    }
    const actions = await validateActions(body.actions ?? []);
    if (!actions.ok) {
      throw badRequest(actions.message);
    }
    if (isEmpty(actions.value)) {
      throw badRequest('A workflow needs at least one action.');
    }

    const workflowId = gvId();
    await dbExec(
      `INSERT INTO workflows (id, organization_id, name, description, trigger_key, conditions, actions, is_active, priority, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        workflowId, orgId, body.name, body.description ?? null, body.trigger, toJson(group.value), toJson(actions.value),
        has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1, toInt(body.priority ?? 10),
      ]
    );
    const row = await dbOne('SELECT * FROM workflows WHERE id = ?', [workflowId]);
    await auditRecord(
      orgId,
      a,
      'workflow.created',
      { entityType: 'WORKFLOW', entityId: workflowId, entityLabel: row.name },
      req
    );
    return jsonCreated(res, automationShapeWorkflow(row));
  })
);

router.patch(
  '/workflows/:id',
  requirePermission('automation', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM workflows WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!before) throw notFound('Workflow not found');

    const data = {};
    if (has(body, 'name')) {
      data.name = body.name;
    }
    if (has(body, 'description')) {
      data.description = orNull(body.description);
    }
    if (has(body, 'trigger')) {
      data.trigger_key = body.trigger;
    }
    if (has(body, 'isActive')) {
      data.is_active = boolVal(body.isActive) ? 1 : 0;
    }
    if (has(body, 'priority')) {
      data.priority = toInt(body.priority);
    }
    if (has(body, 'conditions')) {
      const group = await validateConditionGroup(body.conditions);
      if (!group.ok) {
        throw badRequest(group.message);
      }
      data.conditions = toJson(group.value);
    }
    if (has(body, 'actions')) {
      const actions = await validateActions(body.actions);
      if (!actions.ok) {
        throw badRequest(actions.message);
      }
      data.actions = toJson(actions.value);
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE workflows SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);
    }
    const row = await dbOne('SELECT * FROM workflows WHERE id = ?', [before.id]);
    await auditRecord(
      orgId,
      a,
      'workflow.updated',
      {
        entityType: 'WORKFLOW',
        entityId: row.id,
        entityLabel: row.name,
        changes: gvDiff(before, row, ['name', 'trigger_key', 'is_active', 'priority', 'conditions', 'actions']),
      },
      req
    );
    return jsonOk(res, automationShapeWorkflow(row));
  })
);

router.delete(
  '/workflows/:id',
  requirePermission('automation', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const row = await dbOne('SELECT * FROM workflows WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!row) throw notFound('Workflow not found');
    await dbExec('DELETE FROM workflows WHERE id = ?', [row.id]);
    await auditRecord(
      orgId,
      a,
      'workflow.deleted',
      { entityType: 'WORKFLOW', entityId: row.id, entityLabel: row.name },
      req
    );
    return jsonOk(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Follow-up sequences
// ---------------------------------------------------------------------------
router.get(
  '/sequences',
  requirePermission('automation', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll('SELECT id FROM followup_sequences WHERE organization_id = ? ORDER BY created_at ASC', [
      req.actor.organizationId,
    ]);
    const out = [];
    for (const r of rows) out.push(await automationLoadSequence(r.id));
    return jsonOk(res, out);
  })
);

router.post(
  '/sequences',
  requirePermission('automation', 'create'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    validate(body).required('name', 'Sequence name').maxLength('name', 120).validate();

    const seqId = gvId();
    await dbExec(
      'INSERT INTO followup_sequences (id, organization_id, name, description, is_active, apply_on_create, trigger_status_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,NOW(),NOW())',
      [
        seqId, orgId, body.name, body.description ?? null,
        has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1,
        !isEmpty(body.applyOnCreate) ? 1 : 0, body.triggerStatusKey ?? null,
      ]
    );
    await insertSequenceSteps(seqId, body.steps ?? []);
    return jsonCreated(res, await automationLoadSequence(seqId));
  })
);

router.patch(
  '/sequences/:id',
  requirePermission('automation', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM followup_sequences WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!before) throw notFound('Sequence not found');

    const data = {};
    if (has(body, 'name')) {
      data.name = body.name;
    }
    if (has(body, 'description')) {
      data.description = orNull(body.description);
    }
    if (has(body, 'isActive')) {
      data.is_active = boolVal(body.isActive) ? 1 : 0;
    }
    if (has(body, 'applyOnCreate')) {
      data.apply_on_create = boolVal(body.applyOnCreate) ? 1 : 0;
    }
    if (has(body, 'triggerStatusKey')) {
      data.trigger_status_key = orNull(body.triggerStatusKey);
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE followup_sequences SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);
    }
    if (has(body, 'steps') && body.steps !== null && typeof body.steps === 'object') {
      // Replacing steps wholesale is safe: tasks already created keep their own
      // copy of title/type and only reference the step id for de-duplication.
      await dbExec('DELETE FROM sequence_steps WHERE sequence_id = ?', [before.id]);
      await insertSequenceSteps(before.id, body.steps);
    }
    return jsonOk(res, await automationLoadSequence(before.id));
  })
);

router.delete(
  '/sequences/:id',
  requirePermission('automation', 'delete'),
  ah(async (req, res) => {
    const row = await dbOne('SELECT * FROM followup_sequences WHERE id = ? AND organization_id = ?', [
      req.params.id,
      req.actor.organizationId,
    ]);
    if (!row) throw notFound('Sequence not found');
    await dbExec('DELETE FROM followup_sequences WHERE id = ?', [row.id]);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown automation route')));

export default router;

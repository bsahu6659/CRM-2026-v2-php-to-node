/**
 * Multi-tenancy: which company's data does this request operate on?
 *
 * Route handlers all scope their queries with `actor.organizationId`, so that
 * key means "the tenant this request is acting inside" rather than "the tenant
 * this user belongs to":
 *
 *   normal user    -> always their own organisation, full stop
 *   platform admin -> the tenant selected on their session, else the platform
 *                     organisation (which owns no leads, so an unselected
 *                     session sees nothing rather than everything)
 *
 * The user's real home is kept as homeOrganizationId, which is what user and
 * profile lookups use. A tenant id arriving in a request body or URL is never
 * trusted: it is checked against the active context by tenantGuard().
 */

import { dbExec, dbOne, dbScalar, dbTransaction } from './db.js';
import { forbidden, notFound, unauthenticated } from './errors.js';
import { gvBool, toSqlDate } from './util.js';

let cachedPlatformOrgId;

export async function platformOrganizationId() {
  if (cachedPlatformOrgId !== undefined) return cachedPlatformOrgId;
  cachedPlatformOrgId = (await dbScalar('SELECT id FROM organizations WHERE is_platform = 1 LIMIT 1')) ?? null;
  return cachedPlatformOrgId;
}

export function isPlatformAdmin(actor) {
  return Boolean(actor?.isPlatformAdmin);
}

/**
 * Platform routes are gated twice: the `clients`/`global_projects` permission
 * must be granted AND the user must actually be a platform admin. A tenant
 * admin who edits their own role to grant `clients:read` still gets nothing.
 */
export function requirePlatformAdmin(req) {
  if (!req.actor) throw unauthenticated();
  if (!isPlatformAdmin(req.actor)) {
    throw forbidden('This area is restricted to platform administrators.');
  }
  return req.actor;
}

/** The organisation whose data the current request reads and writes. */
export function activeOrgId(req) {
  if (!req.actor) throw unauthenticated();
  return req.actor.organizationId;
}

/**
 * Asserts that a tenant id supplied by the client is the one already in
 * context. Call this anywhere a route accepts an organizationId, so a crafted
 * id cannot redirect a write into another company.
 */
export function tenantGuard(req, orgId) {
  const active = activeOrgId(req);
  if (orgId !== null && orgId !== undefined && orgId !== '' && orgId !== active) {
    throw forbidden('You do not have access to that company.');
  }
  return active;
}

/**
 * Resolves the tenant a platform admin is asking to act inside. Tenant users
 * never reach the second branch: their own organisation is the only answer.
 */
export async function resolveTenantParam(req, requested) {
  const actor = req.actor;
  if (!actor) throw unauthenticated();
  if (!requested || requested === actor.organizationId) return actor.organizationId;
  if (!isPlatformAdmin(actor)) throw forbidden('You do not have access to that company.');

  const org = await dbOne('SELECT id FROM organizations WHERE id = ?', [requested]);
  if (!org) throw notFound('Company not found.');
  return org.id;
}

/** Points a platform admin's session at a tenant (or back at the platform). */
export async function switchActiveTenant(sessionId, orgId) {
  await dbExec('UPDATE sessions SET active_organization_id = ? WHERE id = ?', [orgId, sessionId]);
}

/**
 * Branding for the tenant, falling back to the platform's own theme when a
 * client has not supplied their own. Returned on every /auth/me so the shell
 * can repaint per tenant.
 */
export function orgBranding(org) {
  return {
    name: org.name,
    legalName: org.legal_name ?? null,
    companyType: org.company_type ?? null,
    logoUrl: org.logo_url || null,
    faviconUrl: org.favicon_url || null,
    primary: org.brand_primary || null,
    accent: org.brand_accent || null,
    loginHeadline: org.login_headline || null,
  };
}

export const COMPANY_TYPES = [
  { key: 'DEVELOPER', label: 'Developer', description: 'Builds and sells its own projects.' },
  { key: 'BROKER', label: 'Broker', description: 'Sells other developers projects; works from the global project master.' },
  { key: 'CHANNEL_PARTNER', label: 'Channel Partner', description: 'Authorised sales partner for selected projects.' },
  { key: 'AGENCY', label: 'Agency', description: 'Marketing agency running campaigns and routing leads.' },
];

export function isValidCompanyType(type) {
  return COMPANY_TYPES.some((t) => t.key === type);
}

/**
 * Developers work their own stock; brokers, channel partners and agencies sell
 * other people's, so they are the ones the global project master exists for.
 */
export function orgUsesGlobalProjects(companyType) {
  return ['BROKER', 'CHANNEL_PARTNER', 'AGENCY'].includes(companyType);
}

/**
 * Deletes a tenant and everything it owns.
 *
 * Most tables fall away through ON DELETE CASCADE, but `users.role_id`
 * references `roles` with the default RESTRICT — correct on its own, since
 * deleting a role must not orphan the people holding it. The consequence is
 * that cascading an organisation delete can hit that restriction before the
 * users are gone, depending on the order the engine chooses. So users go
 * first, explicitly, and the rest cascades from the organisation.
 */
export async function deleteOrganization(orgId) {
  await dbTransaction(async () => {
    // Self-referencing manager_id would restrict too, so break the chain
    // before removing the rows.
    await dbExec('UPDATE users SET manager_id = NULL WHERE organization_id = ?', [orgId]);
    await dbExec('UPDATE teams SET manager_id = NULL WHERE organization_id = ?', [orgId]);
    await dbExec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id = ?)', [orgId]);
    await dbExec('DELETE FROM users WHERE organization_id = ?', [orgId]);
    await dbExec('DELETE FROM organizations WHERE id = ?', [orgId]);
  });
}

export const BILLING_STATUSES = [
  { key: 'ACTIVE', label: 'Active', tone: 'success' },
  { key: 'TRIAL', label: 'Trial', tone: 'info' },
  { key: 'PAST_DUE', label: 'Payment overdue', tone: 'warning' },
  { key: 'CANCELLED', label: 'Cancelled', tone: 'danger' },
];

export function isValidBillingStatus(status) {
  return BILLING_STATUSES.some((s) => s.key === status);
}

/**
 * Why a company cannot sign in, or null if it can.
 *
 * Three separate reasons, kept separate because they are undone by different
 * people: an operational suspension, a deactivated record, and a billing
 * block. The message is shown to the person trying to sign in, so it says what
 * to do rather than just refusing.
 */
export function orgAccessDenial(org) {
  if (gvBool(org.access_blocked ?? 0)) {
    const reason = String(org.access_blocked_reason ?? '').trim();
    return reason !== ''
      ? `Access to this workspace is paused: ${reason}`
      : 'Access to this workspace is paused pending payment. Please contact your account manager.';
  }
  if ((org.status ?? 'ACTIVE') === 'SUSPENDED') {
    return 'This company account is suspended. Please contact your account manager.';
  }
  if (!gvBool(org.is_active ?? 1)) {
    return 'This company account is inactive. Please contact your account manager.';
  }
  return null;
}

/**
 * Billing summary for one company, including whether the period has lapsed.
 * `overdue` is derived, so a renewal date that slipped past shows up without
 * anyone having to remember to change the status by hand.
 */
export function orgBilling(org) {
  const renewsAt = org.renews_at ?? null;
  const trialEndsAt = org.trial_ends_at ?? null;
  const today = toSqlDate(new Date());

  const lapsed =
    (renewsAt && String(renewsAt) < today) ||
    (trialEndsAt && String(trialEndsAt) < today && (org.billing_status ?? '') === 'TRIAL');

  return {
    status: org.billing_status ?? 'ACTIVE',
    planName: org.plan_name ?? null,
    seats: org.seats !== null && org.seats !== undefined ? Number(org.seats) : null,
    monthlyFee: org.monthly_fee !== null && org.monthly_fee !== undefined ? Number(org.monthly_fee) : null,
    trialEndsAt,
    renewsAt,
    lastPaymentAt: org.last_payment_at ?? null,
    accessBlocked: gvBool(org.access_blocked ?? 0),
    accessBlockedAt: org.access_blocked_at ?? null,
    accessBlockedReason: org.access_blocked_reason ?? null,
    notes: org.billing_notes ?? null,
    // True when money is late, whether or not anyone has blocked access yet.
    overdue: (org.billing_status ?? '') === 'PAST_DUE' || Boolean(lapsed),
    daysUntilRenewal: renewsAt
      ? Math.floor((new Date(`${renewsAt}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000)
      : null,
  };
}

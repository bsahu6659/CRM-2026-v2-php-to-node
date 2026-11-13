/**
 * /api/auth/* — registration, sign-in, sessions, password and 2FA.
 *
 * These are the only routes reachable without a session, so each one that
 * accepts a credential is rate limited by IP before it touches the database.
 */

import express from 'express';
import config from '../config/index.js';
import { dbAll, dbExec, dbOne, dbTransaction } from '../lib/db.js';
import { badRequest, forbidden, notFound, unauthenticated } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requireAuth, scopeInfo } from '../middleware/index.js';
import {
  clearSessionCookie,
  clientIp,
  issueSession,
  permissionScope,
  requireActor,
} from '../lib/auth.js';
import { auditRecord } from '../lib/audit.js';
import { rateLimitAuth } from '../lib/rateLimit.js';
import {
  checkPasswordStrength,
  hashPassword,
  randomToken,
  sha256,
  totpGenerateSecret,
  totpOtpauthUri,
  totpVerify,
  verifyPassword,
} from '../lib/security.js';
import { effectivePermissions, userPermissionOverrides } from '../lib/permissions.js';
import { isPlatformAdmin, orgAccessDenial, orgBranding, orgUsesGlobalProjects } from '../lib/tenancy.js';
import { sendSystemMail } from '../services/mailer.js';
import { camelize, gvBool, gvId, safeJson, toSqlDateTime } from '../lib/util.js';
import { provisionOrganization } from '../services/provisioning.js';
import { validate } from '../lib/validate.js';

const router = express.Router();

/**
 * The browser must be told the EFFECTIVE permission set, not the role's raw
 * grant. If the UI worked from the role alone, a user with a special grant
 * would be shown no button for a thing the server would happily let them do —
 * and a user with a REVOKE would be shown a button that 403s.
 */
async function publicUser(req, user, role) {
  const eff = role
    ? effectivePermissions(
        safeJson(role.permissions, {}),
        role.data_scope,
        role.scope_overrides ?? null,
        await userPermissionOverrides(user.id)
      )
    : { permissions: {}, inherited: {}, special: [], scopes: {} };

  const actor = req.actor;
  const isSelf = Boolean(actor && actor.id === user.id);

  return {
    id: user.id,
    // For the signed-in user this is the ACTIVE tenant, which differs from
    // their home organisation while a platform admin is inside a client.
    organizationId: isSelf ? actor.organizationId : user.organization_id,
    homeOrganizationId: user.organization_id,
    isPlatformAdmin: gvBool(user.is_platform_admin ?? 0),
    isImpersonating: isSelf ? Boolean(actor.isImpersonating) : false,
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatar_url,
    jobTitle: user.job_title,
    designation: user.designation ?? null,
    region: user.region,
    managerId: user.manager_id,
    twoFactorEnabled: gvBool(user.two_factor_enabled),
    // The profile screen shows verification status; without this every
    // account read as "Not verified", including ones that had verified.
    emailVerifiedAt: user.email_verified_at ?? null,
    lastLoginAt: user.last_login_at,
    role: role
      ? {
          id: role.id,
          key: role.key,
          name: role.name,
          level: Number(role.level),
          dataScope: role.data_scope,
        }
      : null,
    permissions: eff.permissions,
    inheritedPermissions: eff.inherited,
    specialPermissions: eff.special,
    permissionScopes: eff.scopes,
  };
}

function actorStub(user) {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name ?? '',
    email: user.email,
  };
}

// ---------------------------------------------------------------------------
// POST /auth/register — self-service signup; creates a whole tenant.
// ---------------------------------------------------------------------------
router.post(
  '/register',
  ah(async (req, res) => {
    await rateLimitAuth(req);
    const body = req.body ?? {};

    validate(body)
      .required('organizationName', 'Organisation name').maxLength('organizationName', 120)
      .required('firstName', 'First name').maxLength('firstName', 60)
      .required('email', 'Email').email('email')
      .required('password', 'Password')
      .validate();

    const strength = checkPasswordStrength(String(body.password));
    if (!strength.ok) throw badRequest(strength.message);

    const email = String(body.email).trim().toLowerCase();
    if (await dbOne('SELECT id FROM users WHERE email = ?', [email])) {
      throw badRequest('That email address is already registered.');
    }

    const result = await dbTransaction(async () => {
      const prov = await provisionOrganization(String(body.organizationName).trim());
      const userId = gvId();
      await dbExec(
        `INSERT INTO users (id, organization_id, role_id, first_name, last_name, email, password_hash, email_verified_at, job_title, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,NOW(),?,NOW(),NOW())`,
        [
          userId,
          prov.organizationId,
          prov.roleIds.super_admin ?? prov.roleIds.admin,
          String(body.firstName).trim(),
          String(body.lastName ?? '').trim(),
          email,
          await hashPassword(String(body.password)),
          'Founder',
        ]
      );
      const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [prov.organizationId]);
      const user = await dbOne('SELECT * FROM users WHERE id = ?', [userId]);
      return { org, user };
    });

    await issueSession(req, res, result.user, false);
    await auditRecord(
      result.org.id,
      actorStub(result.user),
      'organization.created',
      { entityType: 'ORGANIZATION', entityId: result.org.id, entityLabel: result.org.name },
      req
    );

    const role = await dbOne('SELECT * FROM roles WHERE id = ?', [result.user.role_id]);
    return jsonCreated(res, {
      user: await publicUser(req, result.user, role),
      organization: { id: result.org.id, name: result.org.name, slug: result.org.slug },
    });
  })
);

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
router.post(
  '/login',
  ah(async (req, res) => {
    await rateLimitAuth(req);
    const body = req.body ?? {};

    validate(body)
      .required('email', 'Email').email('email')
      .required('password', 'Password')
      .validate();

    const email = String(body.email).trim().toLowerCase();
    const user = await dbOne('SELECT * FROM users WHERE email = ?', [email]);

    if (!user) {
      // Hash a throwaway value anyway so a missing account and a wrong
      // password take the same time — otherwise the response time alone
      // enumerates valid email addresses.
      await verifyPassword(String(body.password), '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
      throw unauthenticated('Email or password is incorrect');
    }
    if (!(await verifyPassword(String(body.password), user.password_hash))) {
      await auditRecord(
        user.organization_id,
        null,
        'auth.login_failed',
        { entityType: 'USER', entityId: user.id, entityLabel: user.email },
        req
      );
      throw unauthenticated('Email or password is incorrect');
    }
    if (!gvBool(user.is_active)) {
      throw forbidden('This account has been deactivated. Contact your administrator.');
    }

    const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [user.organization_id]);
    const denial = org ? orgAccessDenial(org) : 'This organisation no longer exists.';
    if (denial !== null) {
      // Logged so a Super Admin can see that people are being turned away,
      // which is usually the first sign an invoice was missed.
      await auditRecord(
        org?.id ?? '',
        null,
        'auth.blocked',
        { entityType: 'USER', entityId: user.id, entityLabel: user.email, changes: { reason: denial } },
        req
      );
      throw forbidden(denial);
    }

    if (gvBool(user.two_factor_enabled)) {
      const code = body.twoFactorCode ?? null;
      if (!code) return jsonOk(res, { twoFactorRequired: true });
      if (!totpVerify(user.two_factor_secret, String(code))) {
        throw unauthenticated('That verification code is not valid.');
      }
    }

    await issueSession(req, res, user, body.rememberMe === true || body.rememberMe === 'true');
    await dbExec('UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?', [clientIp(req), user.id]);
    await auditRecord(
      user.organization_id,
      actorStub(user),
      'auth.login',
      { entityType: 'USER', entityId: user.id, entityLabel: user.email },
      req
    );

    const role = await dbOne('SELECT * FROM roles WHERE id = ?', [user.role_id]);
    return jsonOk(res, { user: await publicUser(req, user, role) });
  })
);

// ---------------------------------------------------------------------------
// POST /auth/logout  &  /auth/logout-all
// ---------------------------------------------------------------------------
router.post(
  '/logout',
  ah(async (req, res) => {
    if (req.session) {
      await dbExec('UPDATE sessions SET revoked_at = NOW() WHERE id = ?', [req.session.id]);
      await auditRecord(
        req.actor.organizationId,
        req.actor,
        'auth.logout',
        { entityType: 'USER', entityId: req.actor.id, entityLabel: req.actor.email },
        req
      );
    }
    clearSessionCookie(res);
    return jsonOk(res, { loggedOut: true });
  })
);

router.post(
  '/logout-all',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const count = await dbExec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [actor.id]);
    clearSessionCookie(res);
    await auditRecord(
      actor.organizationId,
      actor,
      'auth.logout_all',
      { entityType: 'USER', entityId: actor.id, changes: { sessionsRevoked: count } },
      req
    );
    return jsonOk(res, { sessionsRevoked: count });
  })
);

// ---------------------------------------------------------------------------
// GET /auth/me — everything the shell needs to render, in one round trip.
// ---------------------------------------------------------------------------
router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const user = await dbOne('SELECT * FROM users WHERE id = ?', [actor.id]);
    if (!user) throw notFound('User not found');

    const role = await dbOne('SELECT * FROM roles WHERE id = ?', [user.role_id]);
    const teams = await dbAll(
      'SELECT t.id, t.name, tm.team_role FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ?',
      [actor.id]
    );
    const orgRow = await dbOne('SELECT * FROM organizations WHERE id = ?', [actor.organizationId]);

    return jsonOk(res, {
      user: await publicUser(req, user, role),
      organization: {
        id: orgRow.id,
        name: orgRow.name,
        slug: orgRow.slug,
        currency: orgRow.currency,
        timezone: orgRow.timezone,
        companyType: orgRow.company_type,
        isPlatform: gvBool(orgRow.is_platform),
        usesGlobalProjects: orgUsesGlobalProjects(String(orgRow.company_type)),
        logoUrl: orgRow.logo_url,
        // Drives the per-tenant white-label repaint in the browser.
        branding: orgBranding(orgRow),
        settings: safeJson(orgRow.settings, {}),
      },
      teams: teams.map((t) => ({ id: t.id, name: t.name, role: t.team_role })),
      scope: await scopeInfo(req),
      // Only populated for a platform admin; the shell uses it to render the
      // tenant switcher without a second round trip.
      platform: isPlatformAdmin(actor)
        ? {
            homeOrganizationId: actor.homeOrganizationId,
            activeOrganizationId: actor.organizationId,
            isImpersonating: Boolean(actor.isImpersonating),
            clients: camelize(
              await dbAll(
                `SELECT id, name, company_type, status, logo_url FROM organizations
                  WHERE is_platform = 0 ORDER BY name ASC LIMIT 200`
              )
            ),
          }
        : null,
    });
  })
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
router.get(
  '/sessions',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const sessions = await dbAll(
      `SELECT id, user_agent, ip, remember_me, created_at, last_seen_at, expires_at FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW() ORDER BY last_seen_at DESC`,
      [actor.id]
    );
    const currentId = req.session?.id ?? null;
    return jsonOk(
      res,
      sessions.map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        rememberMe: gvBool(s.remember_me),
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
        current: s.id === currentId,
      }))
    );
  })
);

router.delete(
  '/sessions/:id',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const session = await dbOne('SELECT * FROM sessions WHERE id = ? AND user_id = ?', [req.params.id, actor.id]);
    if (!session) throw notFound('Session not found');
    await dbExec('UPDATE sessions SET revoked_at = NOW() WHERE id = ?', [session.id]);
    return jsonOk(res, { revoked: true });
  })
);

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------
router.post(
  '/forgot-password',
  ah(async (req, res) => {
    await rateLimitAuth(req);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const user = email ? await dbOne('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]) : null;

    // The same answer either way: a different response for a missing account
    // would turn this endpoint into an address-enumeration oracle.
    const response = { message: 'If that account exists, a reset link has been sent.' };

    if (user) {
      const token = randomToken(32);
      await dbExec(
        'INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,NOW())',
        [gvId(), user.id, 'PASSWORD_RESET', sha256(token), toSqlDateTime(new Date(Date.now() + 3600_000))]
      );
      await auditRecord(
        user.organization_id,
        actorStub(user),
        'auth.password_reset_requested',
        { entityType: 'USER', entityId: user.id },
        req
      );

      const link = `${config.clientUrl}/reset-password?token=${token}`;
      const sent = await sendSystemMail({
        to: user.email,
        subject: 'Reset your Growvanta CRM password',
        text: `Hello ${user.first_name},\n\nUse this link to set a new password. It expires in one hour.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      });
      if (!sent.ok) console.error(`[auth] reset email not sent (${sent.reason}). Link for ${email}: ${link}`);
      // Never in production: it would hand the token to anyone who can call
      // the endpoint, which is everyone.
      if (config.env !== 'production') response.resetUrl = link;
    }

    return jsonOk(res, response);
  })
);

router.post(
  '/reset-password',
  ah(async (req, res) => {
    await rateLimitAuth(req);
    const { token, password } = req.body ?? {};
    if (!token || !password) throw badRequest('Token and new password are required');

    const strength = checkPasswordStrength(String(password));
    if (!strength.ok) throw badRequest(strength.message);

    const row = await dbOne('SELECT * FROM auth_tokens WHERE token_hash = ?', [sha256(String(token))]);
    if (!row || row.type !== 'PASSWORD_RESET' || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      throw badRequest('That reset link is invalid or has expired.');
    }
    const user = await dbOne('SELECT * FROM users WHERE id = ?', [row.user_id]);
    const newHash = await hashPassword(String(password));

    await dbTransaction(async () => {
      await dbExec('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, row.user_id]);
      await dbExec('UPDATE auth_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
      // Whoever changed the password now owns the account; anyone else holding
      // a live session is exactly who this is protecting against.
      await dbExec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [row.user_id]);
    });

    await auditRecord(
      user.organization_id,
      actorStub(user),
      'auth.password_reset',
      { entityType: 'USER', entityId: row.user_id },
      req
    );
    return jsonOk(res, { message: 'Password updated. Please sign in.' });
  })
);

router.post(
  '/change-password',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) throw badRequest('Current and new password are required');

    const strength = checkPasswordStrength(String(newPassword));
    if (!strength.ok) throw badRequest(strength.message);

    const user = await dbOne('SELECT * FROM users WHERE id = ?', [actor.id]);
    if (!(await verifyPassword(String(currentPassword), user.password_hash))) {
      throw badRequest('Your current password is not correct.');
    }

    await dbExec('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(String(newPassword)), user.id]);
    await dbExec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL AND id != ?', [
      user.id,
      req.session?.id ?? '',
    ]);
    await auditRecord(user.organization_id, actor, 'auth.password_changed', { entityType: 'USER', entityId: user.id }, req);
    return jsonOk(res, { message: 'Password updated. Other sessions were signed out.' });
  })
);

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------
router.post(
  '/send-verification',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const token = randomToken(24);
    await dbExec(
      'INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,NOW())',
      [gvId(), actor.id, 'EMAIL_VERIFY', sha256(token), toSqlDateTime(new Date(Date.now() + 86400_000))]
    );

    const link = `${config.clientUrl}/verify-email?token=${token}`;
    const sent = await sendSystemMail({
      to: actor.email,
      subject: 'Confirm your email address',
      text: `Hello ${actor.firstName},\n\nConfirm your email address by opening this link:\n\n${link}`,
    });
    if (!sent.ok) console.error(`[auth] verification email not sent (${sent.reason}). Link: ${link}`);

    const response = { message: 'Verification email queued.' };
    if (config.env !== 'production') response.verifyUrl = link;
    return jsonOk(res, response);
  })
);

router.post(
  '/verify-email',
  ah(async (req, res) => {
    const token = req.body?.token ?? '';
    const row = token ? await dbOne('SELECT * FROM auth_tokens WHERE token_hash = ?', [sha256(String(token))]) : null;
    if (!row || row.type !== 'EMAIL_VERIFY' || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      throw badRequest('That verification link is invalid or has expired.');
    }
    await dbTransaction(async () => {
      await dbExec('UPDATE users SET email_verified_at = NOW() WHERE id = ?', [row.user_id]);
      await dbExec('UPDATE auth_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
    });
    return jsonOk(res, { verified: true });
  })
);

// ---------------------------------------------------------------------------
// Two-factor authentication
// ---------------------------------------------------------------------------
router.post(
  '/2fa/setup',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const secret = totpGenerateSecret();
    // Stored but not yet enabled: the secret is useless until /2fa/enable
    // proves the user's authenticator actually produces matching codes.
    await dbExec('UPDATE users SET two_factor_secret = ? WHERE id = ?', [secret, actor.id]);
    return jsonOk(res, {
      secret,
      otpauthUri: totpOtpauthUri(secret, actor.email, `Growvanta CRM (${actor.organization.name})`),
    });
  })
);

router.post(
  '/2fa/enable',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const user = await dbOne('SELECT * FROM users WHERE id = ?', [actor.id]);
    if (!user.two_factor_secret) throw badRequest('Start the setup step first.');
    if (!totpVerify(user.two_factor_secret, String(req.body?.code ?? ''))) {
      throw badRequest('That code is not valid. Try the next one.');
    }
    await dbExec('UPDATE users SET two_factor_enabled = 1 WHERE id = ?', [user.id]);
    await auditRecord(user.organization_id, actor, 'auth.2fa_enabled', { entityType: 'USER', entityId: user.id }, req);
    return jsonOk(res, { twoFactorEnabled: true });
  })
);

router.post(
  '/2fa/disable',
  requireAuth,
  ah(async (req, res) => {
    const actor = requireActor(req);
    const user = await dbOne('SELECT * FROM users WHERE id = ?', [actor.id]);
    if (!(await verifyPassword(String(req.body?.password ?? ''), user.password_hash))) {
      throw badRequest('Confirm your password to turn off two-factor authentication.');
    }
    await dbExec('UPDATE users SET two_factor_enabled = 0, two_factor_secret = NULL WHERE id = ?', [user.id]);
    await auditRecord(user.organization_id, actor, 'auth.2fa_disabled', { entityType: 'USER', entityId: user.id }, req);
    return jsonOk(res, { twoFactorEnabled: false });
  })
);

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------
router.post(
  '/accept-invite',
  ah(async (req, res) => {
    await rateLimitAuth(req);
    const body = req.body ?? {};
    const { token, password } = body;
    if (!token || !password) throw badRequest('Token and password are required');

    const strength = checkPasswordStrength(String(password));
    if (!strength.ok) throw badRequest(strength.message);

    const row = await dbOne('SELECT * FROM auth_tokens WHERE token_hash = ?', [sha256(String(token))]);
    if (!row || row.type !== 'INVITE' || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      throw badRequest('That invitation is invalid or has expired.');
    }

    const existing = await dbOne('SELECT * FROM users WHERE id = ?', [row.user_id]);
    await dbExec(
      'UPDATE users SET password_hash = ?, first_name = ?, last_name = ?, email_verified_at = NOW(), is_active = 1 WHERE id = ?',
      [
        await hashPassword(String(password)),
        String(body.firstName ?? existing.first_name).trim(),
        Object.prototype.hasOwnProperty.call(body, 'lastName') ? String(body.lastName).trim() : existing.last_name,
        row.user_id,
      ]
    );
    await dbExec('UPDATE auth_tokens SET used_at = NOW() WHERE id = ?', [row.id]);

    const user = await dbOne('SELECT * FROM users WHERE id = ?', [row.user_id]);
    await issueSession(req, res, user, false);
    await auditRecord(
      user.organization_id,
      actorStub(user),
      'auth.invite_accepted',
      { entityType: 'USER', entityId: user.id, entityLabel: user.email },
      req
    );

    const role = await dbOne('SELECT * FROM roles WHERE id = ?', [user.role_id]);
    return jsonOk(res, { user: await publicUser(req, user, role) });
  })
);

export { publicUser, actorStub, permissionScope };
export default router;

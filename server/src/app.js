/**
 * Express application — port of api/index.php plus the .htaccess rewrites.
 *
 *   /api/health            - no auth
 *   /api/public/*          - public lead-capture surface, its own rate limit
 *   /f/:key, /embed/:key.js - short public form URLs, rewritten onto /api/public
 *   /api/v1/*              - API-key authenticated external ingestion
 *   /api/auth/*            - session issuing; rate limited, CSRF-protected
 *   /webhooks/*            - signed third-party callbacks (Meta); no session
 *   everything else        - requires a session + resolved visibility scope
 */

import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

import config, { SERVER_ROOT } from './config/index.js';
import { dbScalar } from './lib/db.js';
import { requestContext } from './lib/context.js';
import { jsonOk } from './lib/response.js';
import {
  ah,
  apiRateLimit,
  attachActor,
  csrfProtect,
  errorHandler,
  issueCsrfCookie,
  notFoundHandler,
  requireAuth,
  scopeInfo,
  securityHeaders,
} from './middleware/index.js';
import { registerDomainListeners } from './services/listeners.js';

import authRoutes from './routes/auth.js';
import activitiesRoutes from './routes/activities.js';
import apikeysRoutes from './routes/apikeys.js';
import auditRoutes from './routes/audit.js';
import automationRoutes from './routes/automation.js';
import documentsRoutes from './routes/documents.js';
import emailRoutes from './routes/email.js';
import formsRoutes from './routes/forms.js';
import importsRoutes from './routes/imports.js';
import integrationsRoutes from './routes/integrations.js';
import leadsRoutes from './routes/leads.js';
import metaFormsRoutes from './routes/metaForms.js';
import metaInboundRoutes from './routes/metaInbound.js';
import notificationsRoutes from './routes/notifications.js';
import platformRoutes from './routes/platform.js';
import projectsRoutes from './routes/projects.js';
import publicApiRoutes from './routes/publicApi.js';
import publicCaptureRoutes from './routes/publicCapture.js';
import reportsRoutes from './routes/reports.js';
import rolesRoutes from './routes/roles.js';
import savedViewsRoutes from './routes/savedViews.js';
import searchRoutes from './routes/search.js';
import settingsRoutes from './routes/settings.js';
import targetsRoutes from './routes/targets.js';
import teamsRoutes from './routes/teams.js';
import templatesRoutes from './routes/templates.js';
import usersRoutes from './routes/users.js';
import webhooksRoutes from './routes/webhooks.js';
import whatsappRoutes from './routes/whatsapp.js';

// Guarded resource prefix -> router (mirrors GV_GUARDED_ROUTES in api/index.php).
//
// Contacts, accounts, opportunities, pipelines, tasks and campaigns were
// removed in the PHP edition: this is a real-estate CRM, where the buyer is
// the lead and the deal is a booking recorded as a lead status. They are not
// mounted here either, so /api/accounts is a 404 with no code path behind it.
const GUARDED_ROUTES = {
  leads: leadsRoutes,
  activities: activitiesRoutes,
  forms: formsRoutes,
  users: usersRoutes,
  roles: rolesRoutes,
  teams: teamsRoutes,
  reports: reportsRoutes,
  notifications: notificationsRoutes,
  automation: automationRoutes,
  settings: settingsRoutes,
  'api-keys': apikeysRoutes,
  webhooks: webhooksRoutes,
  imports: importsRoutes,
  documents: documentsRoutes,
  search: searchRoutes,
  'audit-logs': auditRoutes,
  'saved-views': savedViewsRoutes,
  targets: targetsRoutes,
  integrations: integrationsRoutes,
  'meta-forms': metaFormsRoutes,
  projects: projectsRoutes,
  templates: templatesRoutes,
  whatsapp: whatsappRoutes,
  email: emailRoutes,
  // Super Admin only; the router re-checks with requirePlatformAdmin().
  platform: platformRoutes,
};

/** Every guarded route needs the actor's visibility, so it is resolved up front. */
const resolveScope = ah(async (req, res, next) => {
  await scopeInfo(req);
  next();
});

export function createApp() {
  registerDomainListeners();

  const app = express();

  // Behind nginx/PM2 the client IP arrives in X-Forwarded-For; rate limiting
  // and audit rows are worthless without it.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // The short public form URLs (.htaccess: /f/KEY and /embed/KEY.js). Only
  // the unauthenticated /api/public surface can be reached this way.
  app.use((req, res, next) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const pathname = req.path;
    let m = /^\/f\/([A-Za-z0-9_.-]+)\/?$/.exec(pathname);
    if (m) {
      req.url = `/api/public/hosted/${m[1]}${qs}`;
      req.gvEmbeddable = true;
    } else if ((m = /^\/embed\/([A-Za-z0-9_.-]+)\.js$/.exec(pathname))) {
      req.url = `/api/public/embed/${m[1]}${qs}`;
      req.gvEmbeddable = true;
    }
    next();
  });

  // Meta signs the raw request body; it has to be verified before JSON
  // parsing re-serialises it, so the inbound webhooks get the raw bytes.
  app.use('/webhooks', express.raw({ type: '*/*', limit: '2mb' }), requestContext, metaInboundRoutes);

  // The script that the embed snippet and hosted page load. Served by the API
  // so a form embedded on a third-party site never depends on the SPA host.
  app.get('/public-form.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(SERVER_ROOT, 'public', 'public-form.js'));
  });

  // Public lead capture runs its own per-form CORS allow-list, so it is
  // mounted before the global cors() below. Anything that is not a classic
  // form post arrives as text and the router decodes it the way PHP decoded
  // php://input: a page posting JSON as text/plain (the no-preflight trick)
  // still works, and malformed JSON is an empty body rather than a 400 that
  // would go out without the form's CORS headers.
  app.use(
    '/api/public',
    express.urlencoded({ extended: false, limit: '2mb' }),
    express.text({
      type: (req) => !req.is('application/x-www-form-urlencoded') && !req.is('multipart/form-data'),
      limit: '2mb',
    }),
    requestContext,
    publicCaptureRoutes
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser callers (curl, Meta's webhook) send no
        // Origin header at all; they are not what CORS is protecting.
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-API-Key'],
      exposedHeaders: ['Content-Disposition'],
    })
  );

  // API-key authenticated ingestion; no cookies, no CSRF. The PHP edition
  // decoded the raw body as JSON whatever Content-Type the caller sent
  // (`curl -d` defaults to form-urlencoded), so this mount takes the body as
  // text before the global parsers can consume it, and the router decodes it.
  app.use(
    '/api/v1',
    securityHeaders,
    express.text({ type: () => true, limit: '2mb' }),
    requestContext,
    publicApiRoutes
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(cookieParser());
  app.use(securityHeaders);
  app.use(requestContext);

  // -------------------------------------------------------------------------
  // Unauthenticated
  // -------------------------------------------------------------------------
  app.get(
    '/api/health',
    ah(async (req, res) => {
      let dbOk = true;
      try {
        await dbScalar('SELECT 1');
      } catch {
        dbOk = false;
      }
      return jsonOk(res, {
        status: dbOk ? 'ok' : 'degraded',
        database: dbOk ? 'up' : 'down',
        environment: config.env,
        time: new Date().toISOString(),
      });
    })
  );

  // -------------------------------------------------------------------------
  // Session-bearing surface
  // -------------------------------------------------------------------------
  const guarded = express.Router();
  guarded.use(apiRateLimit);
  guarded.use(issueCsrfCookie);
  guarded.use(attachActor);
  guarded.use(csrfProtect);

  // /auth/login has to be reachable without a session, so requireAuth is
  // applied inside the auth router per endpoint.
  guarded.use('/auth', authRoutes);

  for (const [prefix, router] of Object.entries(GUARDED_ROUTES)) {
    guarded.use(`/${prefix}`, requireAuth, resolveScope, router);
  }

  app.use('/api', guarded);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;

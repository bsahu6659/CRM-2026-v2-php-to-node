-- ===========================================================================
-- 001_realestate_saas.sql
--
-- Turns the single-tenant CRM into a multi-tenant REAL ESTATE SaaS platform.
--
-- Written for MySQL 5.7+ / MariaDB 10.3+ (the realistic cPanel floor), so:
--   * no `ADD COLUMN IF NOT EXISTS` (MariaDB-only syntax)
--   * no DEFAULT on JSON columns (MySQL 5.7 rejects it)
--   * no recursive CTEs anywhere in the code that reads these tables
--
-- Existing data is preserved: every ALTER adds nullable columns or columns
-- with defaults, and the backfill section at the bottom gives the existing
-- organisation a company type and a lifecycle status.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. ORGANISATIONS become tenants with identity, branding and lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN is_platform     TINYINT(1)   NOT NULL DEFAULT 0 AFTER slug,
  ADD COLUMN company_type    VARCHAR(20)  NOT NULL DEFAULT 'DEVELOPER' AFTER is_platform,
  ADD COLUMN legal_name      VARCHAR(191) NULL AFTER name,
  ADD COLUMN status          VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' AFTER is_active,
  ADD COLUMN website         VARCHAR(300) NULL,
  ADD COLUMN email           VARCHAR(191) NULL,
  ADD COLUMN phone           VARCHAR(30)  NULL,
  ADD COLUMN address         VARCHAR(400) NULL,
  ADD COLUMN city            VARCHAR(80)  NULL,
  ADD COLUMN state           VARCHAR(80)  NULL,
  ADD COLUMN country         VARCHAR(80)  NULL,
  ADD COLUMN pincode         VARCHAR(20)  NULL,
  -- White-label surface. Nulls fall back to the platform's own Growvanta brand.
  ADD COLUMN brand_primary   VARCHAR(9)   NULL,
  ADD COLUMN brand_accent    VARCHAR(9)   NULL,
  ADD COLUMN favicon_url     VARCHAR(500) NULL,
  ADD COLUMN login_headline  VARCHAR(300) NULL,
  ADD COLUMN created_by_id   CHAR(25)     NULL,
  ADD COLUMN suspended_at    DATETIME     NULL,
  ADD COLUMN suspend_reason  VARCHAR(300) NULL,
  ADD COLUMN project_seq     INT          NOT NULL DEFAULT 100,
  ADD KEY idx_org_type (company_type),
  ADD KEY idx_org_status (status);

-- ---------------------------------------------------------------------------
-- 2. Platform administrators + tenant switching
--
-- A platform admin is an ordinary user row inside the platform organisation
-- carrying is_platform_admin = 1. Reusing `users` means sessions, 2FA, audit,
-- password policy and permission checks all keep working unchanged; the only
-- new concept is which tenant the session is currently looking at.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN is_platform_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active,
  ADD COLUMN designation       VARCHAR(120) NULL AFTER job_title;

ALTER TABLE sessions
  ADD COLUMN active_organization_id CHAR(25) NULL;

-- ---------------------------------------------------------------------------
-- 3. Permissions v2: per-action scope overrides + user-specific grants
-- ---------------------------------------------------------------------------
-- {"leads":{"read":"TEAM_AND_BELOW","export":"OWN"}} -- absent keys fall back
-- to the role's own data_scope, so existing rows need no backfill.
ALTER TABLE roles
  ADD COLUMN scope_overrides JSON NULL AFTER data_scope;

CREATE TABLE user_permissions (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  user_id         CHAR(25) NOT NULL,
  module          VARCHAR(40) NOT NULL,
  action          VARCHAR(20) NOT NULL,
  -- GRANT adds a permission the role lacks; REVOKE removes one the role has.
  -- Storing both directions means "special access" is auditable in one place.
  effect          VARCHAR(10) NOT NULL DEFAULT 'GRANT',
  data_scope      VARCHAR(20) NULL,
  reason          VARCHAR(300) NULL,
  granted_by_id   CHAR(25) NULL,
  expires_at      DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_perm (user_id, module, action),
  KEY idx_user_perm_org (organization_id),
  CONSTRAINT fk_uperm_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_uperm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_uperm_by   FOREIGN KEY (granted_by_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. PROJECTS -- the central real-estate entity
--
-- organization_id is the OWNER. A global project is owned by the platform
-- organisation and shared outward via `visibility`; a developer's own project
-- is owned by that developer and stays PRIVATE. This one column plus
-- `visibility` expresses every case in the spec without a second table.
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  code            VARCHAR(30) NOT NULL,
  name            VARCHAR(191) NOT NULL,
  slug            VARCHAR(191) NOT NULL,
  -- Mandatory per spec section 20
  location        VARCHAR(191) NOT NULL,
  developer_name  VARCHAR(191) NOT NULL,
  project_type    VARCHAR(20) NOT NULL DEFAULT 'RESIDENTIAL',
  -- GLOBAL = every tenant; SELECTED = tenants listed in project_access;
  -- PRIVATE = the owning tenant only.
  visibility      VARCHAR(12) NOT NULL DEFAULT 'PRIVATE',

  city            VARCHAR(80)  NULL,
  state           VARCHAR(80)  NULL,
  country         VARCHAR(80)  NULL,
  pincode         VARCHAR(20)  NULL,
  address         VARCHAR(400) NULL,
  description     TEXT NULL,
  rera_number     VARCHAR(120) NULL,
  status          VARCHAR(30) NOT NULL DEFAULT 'ONGOING',
  possession_date DATE NULL,

  price_min       DECIMAL(14,2) NULL,
  price_max       DECIMAL(14,2) NULL,
  area_min        INT NULL,
  area_max        INT NULL,
  area_unit       VARCHAR(12) NOT NULL DEFAULT 'SQFT',
  configurations  JSON NULL,
  amenities       JSON NULL,

  contact_name    VARCHAR(160) NULL,
  contact_phone   VARCHAR(30)  NULL,
  contact_email   VARCHAR(191) NULL,

  logo_url        VARCHAR(500) NULL,
  cover_image_url VARCHAR(500) NULL,

  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_archived     TINYINT(1) NOT NULL DEFAULT 0,
  created_by_id   CHAR(25) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_project_org_code (organization_id, code),
  UNIQUE KEY uq_project_org_slug (organization_id, slug),
  KEY idx_project_org (organization_id),
  KEY idx_project_visibility (visibility, is_active),
  KEY idx_project_city (city),
  CONSTRAINT fk_project_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_creator FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE project_images (
  id          CHAR(25) PRIMARY KEY,
  project_id  CHAR(25) NOT NULL,
  url         VARCHAR(500) NOT NULL,
  caption     VARCHAR(300) NULL,
  is_cover    TINYINT(1) NOT NULL DEFAULT 0,
  sort_order  INT NOT NULL DEFAULT 0,
  file_size   INT NULL,
  mime_type   VARCHAR(60) NULL,
  uploaded_by_id CHAR(25) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pimg_project (project_id, sort_order),
  CONSTRAINT fk_pimg_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_pimg_user FOREIGN KEY (uploaded_by_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which tenants a SELECTED-visibility project is shared with.
CREATE TABLE project_access (
  id              CHAR(25) PRIMARY KEY,
  project_id      CHAR(25) NOT NULL,
  organization_id CHAR(25) NOT NULL,
  granted_by_id   CHAR(25) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_access (project_id, organization_id),
  KEY idx_paccess_org (organization_id),
  CONSTRAINT fk_paccess_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_paccess_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_paccess_by FOREIGN KEY (granted_by_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 5. LEADS gain their real-estate shape
--
-- The lead stays tenant-owned even when project_id points at a global project
-- -- that is the section 24 rule, and it holds structurally because
-- leads.organization_id is never derived from the project.
-- ---------------------------------------------------------------------------
ALTER TABLE leads
  ADD COLUMN project_id          CHAR(25) NULL AFTER campaign_id,
  ADD COLUMN budget_min          DECIMAL(14,2) NULL,
  ADD COLUMN budget_max          DECIMAL(14,2) NULL,
  ADD COLUMN configuration       VARCHAR(60) NULL,
  ADD COLUMN possession_timeline VARCHAR(40) NULL,
  ADD COLUMN purpose             VARCHAR(20) NULL,
  ADD COLUMN funding             VARCHAR(20) NULL,
  ADD COLUMN site_visit_at       DATETIME NULL,
  ADD KEY idx_lead_org_project (organization_id, project_id),
  ADD CONSTRAINT fk_lead_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE opportunities
  ADD COLUMN project_id CHAR(25) NULL,
  ADD KEY idx_opp_org_project (organization_id, project_id),
  ADD CONSTRAINT fk_opp_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

-- Assignment rules can now target a project directly (spec section 17).
ALTER TABLE assignment_rules
  ADD COLUMN project_id CHAR(25) NULL,
  ADD CONSTRAINT fk_rule_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. COMMUNICATION: templates, per-tenant channel config, delivery log
-- ---------------------------------------------------------------------------
CREATE TABLE message_templates (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  channel         VARCHAR(12) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  `key`           VARCHAR(80) NOT NULL,
  -- The name the template is registered under at the provider (Meta requires
  -- pre-approval for WhatsApp), kept separate from our own display name.
  provider_name   VARCHAR(160) NULL,
  language        VARCHAR(12) NOT NULL DEFAULT 'en',
  subject         VARCHAR(300) NULL,
  body            TEXT NOT NULL,
  variables       JSON NULL,
  category        VARCHAR(30) NOT NULL DEFAULT 'UTILITY',
  status          VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_by_id   CHAR(25) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_template_org_key (organization_id, `key`),
  KEY idx_template_org_channel (organization_id, channel, is_active),
  CONSTRAINT fk_template_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_template_by FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Secrets in *_enc columns are AES-256-GCM ciphertext (lib/security.php), never
-- plaintext, and never returned to the browser.
CREATE TABLE whatsapp_settings (
  id                 CHAR(25) PRIMARY KEY,
  organization_id    CHAR(25) NOT NULL,
  provider           VARCHAR(30) NOT NULL DEFAULT 'META_CLOUD',
  is_enabled         TINYINT(1) NOT NULL DEFAULT 0,
  welcome_enabled    TINYINT(1) NOT NULL DEFAULT 0,
  access_token_enc   TEXT NULL,
  phone_number_id    VARCHAR(64) NULL,
  waba_id            VARCHAR(64) NULL,
  sender_number      VARCHAR(30) NULL,
  api_base_url       VARCHAR(300) NULL,
  welcome_template_id CHAR(25) NULL,
  variable_map       JSON NULL,
  credentials_valid  TINYINT(1) NOT NULL DEFAULT 0,
  verified_at        DATETIME NULL,
  last_test_at       DATETIME NULL,
  last_test_status   VARCHAR(20) NULL,
  last_test_error    VARCHAR(500) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wa_org (organization_id),
  CONSTRAINT fk_wa_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_wa_template FOREIGN KEY (welcome_template_id) REFERENCES message_templates(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE email_settings (
  id                 CHAR(25) PRIMARY KEY,
  organization_id    CHAR(25) NOT NULL,
  mode               VARCHAR(12) NOT NULL DEFAULT 'SMTP',
  provider           VARCHAR(30) NULL,
  is_enabled         TINYINT(1) NOT NULL DEFAULT 0,
  welcome_enabled    TINYINT(1) NOT NULL DEFAULT 0,
  smtp_host          VARCHAR(191) NULL,
  smtp_port          INT NULL,
  smtp_encryption    VARCHAR(10) NULL,
  smtp_username      VARCHAR(191) NULL,
  smtp_password_enc  TEXT NULL,
  api_key_enc        TEXT NULL,
  from_email         VARCHAR(191) NULL,
  from_name          VARCHAR(160) NULL,
  reply_to           VARCHAR(191) NULL,
  welcome_template_id CHAR(25) NULL,
  variable_map       JSON NULL,
  credentials_valid  TINYINT(1) NOT NULL DEFAULT 0,
  verified_at        DATETIME NULL,
  last_test_at       DATETIME NULL,
  last_test_status   VARCHAR(20) NULL,
  last_test_error    VARCHAR(500) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_org (organization_id),
  CONSTRAINT fk_emailset_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_emailset_template FOREIGN KEY (welcome_template_id) REFERENCES message_templates(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every send attempt, including the ones deliberately NOT made: `status`
-- SKIPPED plus `reason` is how "automation ran but configuration was
-- incomplete" becomes visible instead of failing silently (spec 37, 54).
CREATE TABLE message_logs (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  channel         VARCHAR(12) NOT NULL,
  lead_id         CHAR(25) NULL,
  template_id     CHAR(25) NULL,
  recipient       VARCHAR(191) NULL,
  subject         VARCHAR(300) NULL,
  body_preview    VARCHAR(500) NULL,
  status          VARCHAR(20) NOT NULL,
  reason          VARCHAR(300) NULL,
  provider_message_id VARCHAR(191) NULL,
  provider_response   TEXT NULL,
  is_test         TINYINT(1) NOT NULL DEFAULT 0,
  triggered_by    VARCHAR(40) NULL,
  user_id         CHAR(25) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_msglog_org_created (organization_id, created_at),
  KEY idx_msglog_org_channel (organization_id, channel, status),
  KEY idx_msglog_lead (lead_id),
  CONSTRAINT fk_msglog_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_msglog_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_msglog_template FOREIGN KEY (template_id) REFERENCES message_templates(id) ON DELETE SET NULL,
  CONSTRAINT fk_msglog_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 7. EXPORT AUDIT (spec 18) -- who took what data out, and under what filters
-- ---------------------------------------------------------------------------
CREATE TABLE export_jobs (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  user_id         CHAR(25) NULL,
  actor_label     VARCHAR(200) NULL,
  entity          VARCHAR(40) NOT NULL,
  format          VARCHAR(10) NOT NULL DEFAULT 'XLSX',
  row_count       INT NOT NULL DEFAULT 0,
  filters         JSON NULL,
  data_scope      VARCHAR(20) NULL,
  ip              VARCHAR(64) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_export_org_created (organization_id, created_at),
  CONSTRAINT fk_export_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_export_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 8. BACKFILL -- keep the existing tenant working
-- ---------------------------------------------------------------------------
-- The pre-existing organisation becomes a DEVELOPER tenant. The platform
-- organisation and its owner are created by database/platform_bootstrap.php,
-- which runs after this file because it needs PHP to hash a password.
UPDATE organizations SET company_type = 'DEVELOPER' WHERE company_type = '';
UPDATE organizations SET status = CASE WHEN is_active = 1 THEN 'ACTIVE' ELSE 'INACTIVE' END;

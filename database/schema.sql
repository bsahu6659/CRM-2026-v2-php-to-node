-- ============================================================================
-- Growvanta CRM — MySQL schema (PHP/PDO edition)
--
-- Ported from the Prisma/SQLite schema. Differences from the Node version:
--   - IDs are CHAR(25) cuid-style strings generated in PHP (lib/util.php::cuid),
--     kept as strings rather than switched to AUTO_INCREMENT so foreign keys,
--     API responses and the untouched frontend JS never have to know the
--     storage engine changed.
--   - JSON columns use native MySQL JSON (5.7+/8.0+) instead of TEXT-as-JSON.
--   - Booleans are TINYINT(1), matching PDO's normal binding.
--   - InnoDB throughout, utf8mb4 for full emoji/unicode support in notes.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------------------------------------------------------
CREATE TABLE organizations (
  id            CHAR(25) PRIMARY KEY,
  name          VARCHAR(191) NOT NULL,
  slug          VARCHAR(191) NOT NULL UNIQUE,
  domain        VARCHAR(191) NULL,
  logo_url      VARCHAR(500) NULL,
  timezone      VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  currency      VARCHAR(8) NOT NULL DEFAULT 'INR',
  locale        VARCHAR(16) NOT NULL DEFAULT 'en-IN',
  plan          VARCHAR(32) NOT NULL DEFAULT 'enterprise',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  settings      JSON NOT NULL,
  lead_seq      INT NOT NULL DEFAULT 1000,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE roles (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  `key`           VARCHAR(80) NOT NULL,
  description     VARCHAR(500) NULL,
  parent_role_id  CHAR(25) NULL,
  level           INT NOT NULL DEFAULT 50,
  data_scope      VARCHAR(20) NOT NULL DEFAULT 'OWN',
  permissions     JSON NOT NULL,
  is_system       TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_role_org_key (organization_id, `key`),
  KEY idx_role_org (organization_id),
  CONSTRAINT fk_role_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_role_parent FOREIGN KEY (parent_role_id) REFERENCES roles(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id                  CHAR(25) PRIMARY KEY,
  organization_id     CHAR(25) NOT NULL,
  role_id             CHAR(25) NOT NULL,
  manager_id          CHAR(25) NULL,
  first_name          VARCHAR(80) NOT NULL,
  last_name           VARCHAR(80) NULL,
  email               VARCHAR(191) NOT NULL,
  phone               VARCHAR(30) NULL,
  password_hash       VARCHAR(255) NOT NULL,
  avatar_url          VARCHAR(500) NULL,
  job_title           VARCHAR(120) NULL,
  region              VARCHAR(80) NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  email_verified_at   DATETIME NULL,
  two_factor_enabled  TINYINT(1) NOT NULL DEFAULT 0,
  two_factor_secret   VARCHAR(64) NULL,
  last_login_at       DATETIME NULL,
  last_login_ip       VARCHAR(64) NULL,
  assignment_weight   INT NOT NULL DEFAULT 1,
  is_assignable       TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_org_email (organization_id, email),
  KEY idx_user_org (organization_id),
  KEY idx_user_org_manager (organization_id, manager_id),
  CONSTRAINT fk_user_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES roles(id),
  CONSTRAINT fk_user_manager FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  id            CHAR(25) PRIMARY KEY,
  user_id       CHAR(25) NOT NULL,
  token_hash    CHAR(64) NOT NULL UNIQUE,
  user_agent    VARCHAR(250) NULL,
  ip            VARCHAR(64) NULL,
  remember_me   TINYINT(1) NOT NULL DEFAULT 0,
  expires_at    DATETIME NOT NULL,
  revoked_at    DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_session_user (user_id),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE auth_tokens (
  id          CHAR(25) PRIMARY KEY,
  user_id     CHAR(25) NOT NULL,
  type        VARCHAR(20) NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_authtoken_user_type (user_id, type),
  CONSTRAINT fk_authtoken_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE teams (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  description     VARCHAR(500) NULL,
  parent_team_id  CHAR(25) NULL,
  manager_id      CHAR(25) NULL,
  region          VARCHAR(80) NULL,
  territory       JSON NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_team_org (organization_id),
  CONSTRAINT fk_team_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_team_parent FOREIGN KEY (parent_team_id) REFERENCES teams(id) ON DELETE SET NULL,
  CONSTRAINT fk_team_manager FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE team_members (
  id         CHAR(25) PRIMARY KEY,
  team_id    CHAR(25) NOT NULL,
  user_id    CHAR(25) NOT NULL,
  team_role  VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
  joined_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_teammember (team_id, user_id),
  KEY idx_teammember_user (user_id),
  CONSTRAINT fk_teammember_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_teammember_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Lead configuration
-- ----------------------------------------------------------------------------
CREATE TABLE lead_sources (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  `key`           VARCHAR(60) NOT NULL,
  category        VARCHAR(20) NOT NULL DEFAULT 'OTHER',
  cost_per_lead   DECIMAL(12,2) NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_source_org_key (organization_id, `key`),
  KEY idx_source_org (organization_id),
  CONSTRAINT fk_source_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lead_statuses (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(80) NOT NULL,
  `key`           VARCHAR(60) NOT NULL,
  color           VARCHAR(9) NOT NULL DEFAULT '#6366f1',
  sort_order      INT NOT NULL DEFAULT 0,
  probability     INT NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  is_converted    TINYINT(1) NOT NULL DEFAULT 0,
  is_lost         TINYINT(1) NOT NULL DEFAULT 0,
  is_junk         TINYINT(1) NOT NULL DEFAULT 0,
  is_qualified    TINYINT(1) NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_status_org_key (organization_id, `key`),
  KEY idx_status_org (organization_id),
  CONSTRAINT fk_status_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tags (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(80) NOT NULL,
  color           VARCHAR(9) NOT NULL DEFAULT '#64748b',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tag_org_name (organization_id, name),
  CONSTRAINT fk_tag_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Pipelines (declared before leads because opportunities reference both ways)
-- ----------------------------------------------------------------------------
CREATE TABLE pipelines (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  `key`           VARCHAR(60) NOT NULL,
  description     VARCHAR(400) NULL,
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pipeline_org_key (organization_id, `key`),
  KEY idx_pipeline_org (organization_id),
  CONSTRAINT fk_pipeline_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE pipeline_stages (
  id           CHAR(25) PRIMARY KEY,
  pipeline_id  CHAR(25) NOT NULL,
  name         VARCHAR(80) NOT NULL,
  `key`        VARCHAR(60) NOT NULL,
  color        VARCHAR(9) NOT NULL DEFAULT '#6366f1',
  probability  INT NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  is_won       TINYINT(1) NOT NULL DEFAULT 0,
  is_lost      TINYINT(1) NOT NULL DEFAULT 0,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_stage_pipeline_key (pipeline_id, `key`),
  KEY idx_stage_pipeline (pipeline_id),
  CONSTRAINT fk_stage_pipeline FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Marketing (campaigns before leads, which attribute to a campaign)
-- ----------------------------------------------------------------------------
CREATE TABLE campaigns (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  code            VARCHAR(60) NOT NULL,
  type            VARCHAR(20) NOT NULL DEFAULT 'DIGITAL',
  status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  channel         VARCHAR(80) NULL,
  medium          VARCHAR(80) NULL,
  source_id       CHAR(25) NULL,
  owner_id        CHAR(25) NULL,
  budget          DECIMAL(14,2) NOT NULL DEFAULT 0,
  actual_spend    DECIMAL(14,2) NOT NULL DEFAULT 0,
  target_leads    INT NOT NULL DEFAULT 0,
  target_revenue  DECIMAL(14,2) NOT NULL DEFAULT 0,
  start_date      DATE NULL,
  end_date        DATE NULL,
  description     TEXT NULL,
  -- Meta/Facebook Ads linkage: which ad-account/campaign/adset/ad this maps to,
  -- so inbound Lead Ads webhooks can be attributed automatically.
  meta_campaign_id VARCHAR(64) NULL,
  meta_adset_id    VARCHAR(64) NULL,
  meta_ad_id       VARCHAR(64) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_campaign_org_code (organization_id, code),
  KEY idx_campaign_org_status (organization_id, status),
  KEY idx_campaign_meta (meta_campaign_id, meta_adset_id, meta_ad_id),
  CONSTRAINT fk_campaign_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_campaign_source FOREIGN KEY (source_id) REFERENCES lead_sources(id) ON DELETE SET NULL,
  CONSTRAINT fk_campaign_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Leads
-- ----------------------------------------------------------------------------
CREATE TABLE leads (
  id                 CHAR(25) PRIMARY KEY,
  organization_id    CHAR(25) NOT NULL,
  code               VARCHAR(30) NOT NULL,
  first_name         VARCHAR(80) NOT NULL,
  last_name          VARCHAR(80) NULL,
  email              VARCHAR(191) NULL,
  phone              VARCHAR(30) NULL,
  alt_phone          VARCHAR(30) NULL,
  company            VARCHAR(160) NULL,
  job_title          VARCHAR(120) NULL,
  website            VARCHAR(300) NULL,

  country VARCHAR(80) NULL,
  state   VARCHAR(80) NULL,
  city    VARCHAR(80) NULL,
  address VARCHAR(400) NULL,
  pincode VARCHAR(20) NULL,

  source_id     CHAR(25) NULL,
  campaign_id   CHAR(25) NULL,
  medium        VARCHAR(80) NULL,
  landing_page  VARCHAR(500) NULL,
  referrer_url  VARCHAR(500) NULL,
  utm_source    VARCHAR(150) NULL,
  utm_medium    VARCHAR(150) NULL,
  utm_campaign  VARCHAR(150) NULL,
  utm_term      VARCHAR(150) NULL,
  utm_content   VARCHAR(150) NULL,
  gclid         VARCHAR(191) NULL,
  fbclid        VARCHAR(191) NULL,

  -- Meta Lead Ads linkage: exact ad the lead came from, and the platform's own
  -- lead id (used to de-duplicate webhook retries).
  meta_lead_id   VARCHAR(64) NULL,
  meta_form_id   VARCHAR(64) NULL,
  meta_page_id   VARCHAR(64) NULL,
  meta_ad_id     VARCHAR(64) NULL,
  meta_adset_id  VARCHAR(64) NULL,
  meta_campaign_id VARCHAR(64) NULL,

  first_touch_source   VARCHAR(120) NULL,
  first_touch_campaign VARCHAR(120) NULL,
  first_touch_at       DATETIME NULL,
  last_touch_source    VARCHAR(120) NULL,
  last_touch_campaign  VARCHAR(120) NULL,
  last_touch_at        DATETIME NULL,

  status_id  CHAR(25) NOT NULL,
  score      INT NOT NULL DEFAULT 0,
  score_band VARCHAR(12) NOT NULL DEFAULT 'COLD',
  priority   VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
  rating     VARCHAR(40) NULL,

  owner_id      CHAR(25) NULL,
  team_id       CHAR(25) NULL,
  created_by_id CHAR(25) NULL,

  expected_value DECIMAL(14,2) NULL,
  notes          TEXT NULL,
  custom_fields  JSON NOT NULL,

  last_contacted_at DATETIME NULL,
  next_follow_up_at DATETIME NULL,
  qualified_at      DATETIME NULL,
  converted_at      DATETIME NULL,
  lost_at           DATETIME NULL,
  lost_reason       VARCHAR(300) NULL,
  assigned_at       DATETIME NULL,

  is_converted  TINYINT(1) NOT NULL DEFAULT 0,
  is_duplicate  TINYINT(1) NOT NULL DEFAULT 0,
  merged_into_id CHAR(25) NULL,
  email_norm VARCHAR(191) NULL,
  phone_norm VARCHAR(20) NULL,

  converted_contact_id     CHAR(25) NULL,
  converted_account_id     CHAR(25) NULL,
  converted_opportunity_id CHAR(25) NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_lead_org_code (organization_id, code),
  UNIQUE KEY uq_lead_meta_id (meta_lead_id),
  KEY idx_lead_org_status (organization_id, status_id),
  KEY idx_lead_org_owner (organization_id, owner_id),
  KEY idx_lead_org_team (organization_id, team_id),
  KEY idx_lead_org_created (organization_id, created_at),
  KEY idx_lead_org_email (organization_id, email_norm),
  KEY idx_lead_org_phone (organization_id, phone_norm),
  KEY idx_lead_org_followup (organization_id, next_follow_up_at),
  KEY idx_lead_org_source (organization_id, source_id),
  KEY idx_lead_org_campaign (organization_id, campaign_id),
  CONSTRAINT fk_lead_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_status FOREIGN KEY (status_id) REFERENCES lead_statuses(id),
  CONSTRAINT fk_lead_source FOREIGN KEY (source_id) REFERENCES lead_sources(id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_creator FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_merged FOREIGN KEY (merged_into_id) REFERENCES leads(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lead_tags (
  id       CHAR(25) PRIMARY KEY,
  lead_id  CHAR(25) NOT NULL,
  tag_id   CHAR(25) NOT NULL,
  UNIQUE KEY uq_leadtag (lead_id, tag_id),
  KEY idx_leadtag_tag (tag_id),
  CONSTRAINT fk_leadtag_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_leadtag_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Accounts & contacts
-- ----------------------------------------------------------------------------
CREATE TABLE accounts (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  website         VARCHAR(300) NULL,
  industry        VARCHAR(120) NULL,
  employee_count  INT NULL,
  annual_revenue  DECIMAL(16,2) NULL,
  phone           VARCHAR(30) NULL,
  email           VARCHAR(191) NULL,
  country VARCHAR(80) NULL, state VARCHAR(80) NULL, city VARCHAR(80) NULL,
  address VARCHAR(400) NULL, pincode VARCHAR(20) NULL,
  owner_id        CHAR(25) NULL,
  description     TEXT NULL,
  custom_fields   JSON NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_account_org (organization_id),
  KEY idx_account_org_owner (organization_id, owner_id),
  CONSTRAINT fk_account_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_account_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE contacts (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  account_id      CHAR(25) NULL,
  lead_id         CHAR(25) NULL,
  first_name      VARCHAR(80) NOT NULL,
  last_name       VARCHAR(80) NULL,
  email           VARCHAR(191) NULL,
  phone           VARCHAR(30) NULL,
  alt_phone       VARCHAR(30) NULL,
  job_title       VARCHAR(120) NULL,
  department      VARCHAR(120) NULL,
  country VARCHAR(80) NULL, state VARCHAR(80) NULL, city VARCHAR(80) NULL,
  address VARCHAR(400) NULL, pincode VARCHAR(20) NULL,
  owner_id        CHAR(25) NULL,
  is_primary      TINYINT(1) NOT NULL DEFAULT 0,
  email_norm      VARCHAR(191) NULL,
  phone_norm      VARCHAR(20) NULL,
  custom_fields   JSON NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_contact_org (organization_id),
  KEY idx_contact_org_account (organization_id, account_id),
  KEY idx_contact_org_owner (organization_id, owner_id),
  KEY idx_contact_org_email (organization_id, email_norm),
  KEY idx_contact_org_phone (organization_id, phone_norm),
  CONSTRAINT fk_contact_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_contact_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_contact_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_contact_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Opportunities
-- ----------------------------------------------------------------------------
CREATE TABLE opportunities (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  code            VARCHAR(30) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  lead_id         CHAR(25) NULL,
  contact_id      CHAR(25) NULL,
  account_id      CHAR(25) NULL,
  owner_id        CHAR(25) NULL,
  team_id         CHAR(25) NULL,
  pipeline_id     CHAR(25) NOT NULL,
  stage_id        CHAR(25) NOT NULL,
  campaign_id     CHAR(25) NULL,
  source_id       CHAR(25) NULL,

  amount            DECIMAL(14,2) NOT NULL DEFAULT 0,
  probability       INT NOT NULL DEFAULT 0,
  expected_revenue  DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency          VARCHAR(8) NOT NULL DEFAULT 'INR',
  expected_close_date DATE NULL,
  actual_close_date   DATE NULL,
  product           VARCHAR(160) NULL,
  description       TEXT NULL,
  lost_reason       VARCHAR(300) NULL,
  is_won   TINYINT(1) NOT NULL DEFAULT 0,
  is_lost  TINYINT(1) NOT NULL DEFAULT 0,
  is_closed TINYINT(1) NOT NULL DEFAULT 0,
  stage_entered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  custom_fields JSON NOT NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_opp_org_code (organization_id, code),
  KEY idx_opp_org_stage (organization_id, stage_id),
  KEY idx_opp_org_owner (organization_id, owner_id),
  KEY idx_opp_org_pipeline (organization_id, pipeline_id),
  KEY idx_opp_org_close (organization_id, expected_close_date),
  CONSTRAINT fk_opp_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_opp_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_opp_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  CONSTRAINT fk_opp_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_opp_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_opp_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  CONSTRAINT fk_opp_pipeline FOREIGN KEY (pipeline_id) REFERENCES pipelines(id),
  CONSTRAINT fk_opp_stage FOREIGN KEY (stage_id) REFERENCES pipeline_stages(id),
  CONSTRAINT fk_opp_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Timeline: activities, tasks
-- ----------------------------------------------------------------------------
CREATE TABLE activities (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  type            VARCHAR(20) NOT NULL,
  direction       VARCHAR(10) NULL,
  subject         VARCHAR(200) NULL,
  body            TEXT NULL,
  outcome         VARCHAR(20) NULL,
  duration_sec    INT NULL,
  channel         VARCHAR(40) NULL,
  provider        VARCHAR(40) NULL,
  provider_message_id VARCHAR(120) NULL,
  status          VARCHAR(20) NULL,
  -- Nullable on purpose: most timeline entries carry no structured extra data,
  -- and MySQL 5.7 cannot put a DEFAULT on a JSON column. Readers go through
  -- safe_json(), which treats NULL as an empty object.
  meta            JSON NULL,

  lead_id         CHAR(25) NULL,
  contact_id      CHAR(25) NULL,
  account_id      CHAR(25) NULL,
  opportunity_id  CHAR(25) NULL,
  task_id         CHAR(25) NULL,
  user_id         CHAR(25) NULL,

  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_activity_org_lead (organization_id, lead_id, occurred_at),
  KEY idx_activity_org_user (organization_id, user_id, occurred_at),
  KEY idx_activity_org_type (organization_id, type, occurred_at),
  KEY idx_activity_opp (opportunity_id),
  KEY idx_activity_contact (contact_id),
  CONSTRAINT fk_activity_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_activity_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_activity_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  CONSTRAINT fk_activity_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_activity_opp FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
  CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tasks (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  description     TEXT NULL,
  type            VARCHAR(20) NOT NULL DEFAULT 'TASK',
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  priority        VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
  due_at          DATETIME NULL,
  reminder_at     DATETIME NULL,
  completed_at    DATETIME NULL,
  outcome         VARCHAR(500) NULL,

  assignee_id     CHAR(25) NULL,
  created_by_id   CHAR(25) NULL,
  lead_id         CHAR(25) NULL,
  contact_id      CHAR(25) NULL,
  account_id      CHAR(25) NULL,
  opportunity_id  CHAR(25) NULL,
  sequence_step_id CHAR(25) NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_task_org_assignee (organization_id, assignee_id, status),
  KEY idx_task_org_due (organization_id, due_at),
  KEY idx_task_org_lead (organization_id, lead_id),
  CONSTRAINT fk_task_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_assignee FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_task_creator FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_task_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_opp FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE activities ADD CONSTRAINT fk_activity_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- Capture: hosted / embeddable web forms + Meta Lead Ads forms
-- ----------------------------------------------------------------------------
CREATE TABLE web_forms (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  public_key      VARCHAR(80) NOT NULL UNIQUE,
  description     VARCHAR(500) NULL,
  fields          JSON NOT NULL,
  source_id       CHAR(25) NULL,
  campaign_id     CHAR(25) NULL,
  assign_to_user_id CHAR(25) NULL,
  assign_to_team_id CHAR(25) NULL,
  use_assignment_rules TINYINT(1) NOT NULL DEFAULT 1,
  redirect_url    VARCHAR(500) NULL,
  success_message VARCHAR(400) NOT NULL DEFAULT 'Thanks! Our team will contact you shortly.',
  submit_label    VARCHAR(60) NOT NULL DEFAULT 'Submit',
  allowed_origins VARCHAR(600) NOT NULL DEFAULT '',
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  submission_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_webform_org (organization_id),
  CONSTRAINT fk_webform_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_webform_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE form_submissions (
  id              CHAR(25) PRIMARY KEY,
  form_id         CHAR(25) NOT NULL,
  organization_id CHAR(25) NOT NULL,
  payload         JSON NOT NULL,
  lead_id         CHAR(25) NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'ACCEPTED',
  message         VARCHAR(300) NULL,
  ip              VARCHAR(64) NULL,
  user_agent      VARCHAR(250) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_submission_form (form_id, created_at),
  CONSTRAINT fk_submission_form FOREIGN KEY (form_id) REFERENCES web_forms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Meta/Facebook Lead Ads: a form the user has connected on the Meta side, mapped
-- to a CRM source/campaign/team so the webhook knows how to route it.
CREATE TABLE meta_lead_forms (
  id                CHAR(25) PRIMARY KEY,
  organization_id   CHAR(25) NOT NULL,
  meta_page_id      VARCHAR(64) NOT NULL,
  meta_form_id      VARCHAR(64) NOT NULL,
  form_name         VARCHAR(200) NULL,
  page_access_token TEXT NULL, -- encrypted at rest, see lib/security.php::encrypt
  source_id         CHAR(25) NULL,
  campaign_id       CHAR(25) NULL,
  assign_to_user_id CHAR(25) NULL,
  assign_to_team_id CHAR(25) NULL,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  last_synced_at    DATETIME NULL,
  last_error        VARCHAR(500) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_metaform (meta_page_id, meta_form_id),
  KEY idx_metaform_org (organization_id),
  CONSTRAINT fk_metaform_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_metaform_source FOREIGN KEY (source_id) REFERENCES lead_sources(id) ON DELETE SET NULL,
  CONSTRAINT fk_metaform_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Raw webhook deliveries from Meta, kept for audit/replay even after the lead
-- is created — mirrors what a real integration needs for support/debugging.
CREATE TABLE meta_webhook_events (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NULL,
  meta_page_id    VARCHAR(64) NULL,
  meta_form_id    VARCHAR(64) NULL,
  meta_lead_id    VARCHAR(64) NULL,
  raw_payload     JSON NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
  error           VARCHAR(500) NULL,
  lead_id         CHAR(25) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at    DATETIME NULL,
  KEY idx_metaevent_org (organization_id, created_at),
  KEY idx_metaevent_leadid (meta_lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Distribution, scoring & automation
-- ----------------------------------------------------------------------------
CREATE TABLE assignment_rules (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  description     VARCHAR(400) NULL,
  priority        INT NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  conditions      JSON NOT NULL,
  strategy        VARCHAR(20) NOT NULL DEFAULT 'ROUND_ROBIN',
  target_user_ids JSON NOT NULL,
  target_team_id  CHAR(25) NULL,
  cursor_pos      INT NOT NULL DEFAULT 0,
  stop_on_match   TINYINT(1) NOT NULL DEFAULT 1,
  assigned_count  INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_rule_org_priority (organization_id, priority),
  CONSTRAINT fk_rule_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE scoring_rules (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  kind            VARCHAR(30) NOT NULL,
  field           VARCHAR(80) NULL,
  operator        VARCHAR(20) NULL,
  value           VARCHAR(200) NULL,
  points          INT NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_scoring_org (organization_id),
  CONSTRAINT fk_scoring_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE workflows (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  description     VARCHAR(400) NULL,
  trigger_key     VARCHAR(60) NOT NULL,
  conditions      JSON NOT NULL,
  actions         JSON NOT NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  priority        INT NOT NULL DEFAULT 0,
  run_count       INT NOT NULL DEFAULT 0,
  last_run_at     DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_workflow_org_trigger (organization_id, trigger_key, is_active),
  CONSTRAINT fk_workflow_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE workflow_runs (
  id              CHAR(25) PRIMARY KEY,
  workflow_id     CHAR(25) NOT NULL,
  organization_id CHAR(25) NOT NULL,
  entity_type     VARCHAR(30) NOT NULL,
  entity_id       CHAR(25) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'SUCCESS',
  log             JSON NOT NULL,
  error           VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_wfrun_workflow (workflow_id, created_at),
  KEY idx_wfrun_org (organization_id, created_at),
  CONSTRAINT fk_wfrun_workflow FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE followup_sequences (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  description     VARCHAR(400) NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  trigger_status_key VARCHAR(60) NULL,
  apply_on_create TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_sequence_org (organization_id),
  CONSTRAINT fk_sequence_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sequence_steps (
  id           CHAR(25) PRIMARY KEY,
  sequence_id  CHAR(25) NOT NULL,
  day_offset   INT NOT NULL DEFAULT 1,
  task_type    VARCHAR(20) NOT NULL DEFAULT 'FOLLOW_UP',
  title        VARCHAR(200) NOT NULL,
  description  VARCHAR(500) NULL,
  priority     VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
  sort_order   INT NOT NULL DEFAULT 0,
  KEY idx_seqstep_sequence (sequence_id),
  CONSTRAINT fk_seqstep_sequence FOREIGN KEY (sequence_id) REFERENCES followup_sequences(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE tasks ADD CONSTRAINT fk_task_seqstep FOREIGN KEY (sequence_step_id) REFERENCES sequence_steps(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- Custom fields
-- ----------------------------------------------------------------------------
CREATE TABLE custom_fields (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  entity          VARCHAR(20) NOT NULL,
  `key`           VARCHAR(80) NOT NULL,
  label           VARCHAR(120) NOT NULL,
  type            VARCHAR(20) NOT NULL DEFAULT 'TEXT',
  options         JSON NOT NULL,
  is_required     TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  show_in_list    TINYINT(1) NOT NULL DEFAULT 0,
  default_value   VARCHAR(300) NULL,
  help_text       VARCHAR(300) NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customfield (organization_id, entity, `key`),
  KEY idx_customfield_org_entity (organization_id, entity),
  CONSTRAINT fk_customfield_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Files, notifications, audit, integrations
-- ----------------------------------------------------------------------------
CREATE TABLE documents (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  file_name       VARCHAR(255) NOT NULL,
  stored_name     VARCHAR(255) NOT NULL,
  mime_type       VARCHAR(120) NOT NULL,
  size_bytes      INT NOT NULL,
  uploaded_by_id  CHAR(25) NULL,
  lead_id         CHAR(25) NULL,
  contact_id      CHAR(25) NULL,
  account_id      CHAR(25) NULL,
  opportunity_id  CHAR(25) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_document_org_lead (organization_id, lead_id),
  CONSTRAINT fk_document_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_document_uploader FOREIGN KEY (uploaded_by_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_document_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_document_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  CONSTRAINT fk_document_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_document_opp FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE notifications (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  user_id         CHAR(25) NOT NULL,
  type            VARCHAR(40) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            VARCHAR(500) NULL,
  entity_type     VARCHAR(30) NULL,
  entity_id       CHAR(25) NULL,
  link            VARCHAR(300) NULL,
  severity        VARCHAR(10) NOT NULL DEFAULT 'INFO',
  is_read         TINYINT(1) NOT NULL DEFAULT 0,
  read_at         DATETIME NULL,
  email_queued_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notification_user (user_id, is_read, created_at),
  CONSTRAINT fk_notification_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_notification_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE audit_logs (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  user_id         CHAR(25) NULL,
  actor_label     VARCHAR(200) NULL,
  action          VARCHAR(80) NOT NULL,
  entity_type     VARCHAR(30) NULL,
  entity_id       CHAR(25) NULL,
  entity_label    VARCHAR(200) NULL,
  changes         JSON NOT NULL,
  ip              VARCHAR(64) NULL,
  user_agent      VARCHAR(250) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_org_created (organization_id, created_at),
  KEY idx_audit_org_entity (organization_id, entity_type, entity_id),
  KEY idx_audit_org_user (organization_id, user_id, created_at),
  CONSTRAINT fk_audit_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE api_keys (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  prefix          VARCHAR(20) NOT NULL,
  key_hash        CHAR(64) NOT NULL UNIQUE,
  scopes          JSON NOT NULL,
  created_by_id   CHAR(25) NULL,
  last_used_at    DATETIME NULL,
  use_count       INT NOT NULL DEFAULT 0,
  expires_at      DATETIME NULL,
  revoked_at      DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_apikey_org (organization_id),
  CONSTRAINT fk_apikey_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_apikey_creator FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE webhooks (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  url             VARCHAR(500) NOT NULL,
  secret          VARCHAR(120) NOT NULL,
  events          JSON NOT NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  failure_count   INT NOT NULL DEFAULT 0,
  last_status     INT NULL,
  last_fired_at   DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_webhook_org (organization_id),
  CONSTRAINT fk_webhook_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE webhook_deliveries (
  id          CHAR(25) PRIMARY KEY,
  webhook_id  CHAR(25) NOT NULL,
  event       VARCHAR(60) NOT NULL,
  payload     JSON NOT NULL,
  status_code INT NULL,
  response    VARCHAR(500) NULL,
  error       VARCHAR(500) NULL,
  duration_ms INT NULL,
  attempt     INT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_delivery_webhook (webhook_id, created_at),
  CONSTRAINT fk_delivery_webhook FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE integrations (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  provider        VARCHAR(40) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  is_enabled      TINYINT(1) NOT NULL DEFAULT 0,
  config          JSON NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'NOT_CONFIGURED',
  last_synced_at  DATETIME NULL,
  last_error      VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_integration (organization_id, provider),
  CONSTRAINT fk_integration_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE import_jobs (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  entity          VARCHAR(20) NOT NULL DEFAULT 'LEAD',
  file_name       VARCHAR(255) NOT NULL,
  total_rows      INT NOT NULL DEFAULT 0,
  created_rows    INT NOT NULL DEFAULT 0,
  updated_rows    INT NOT NULL DEFAULT 0,
  duplicate_rows  INT NOT NULL DEFAULT 0,
  error_rows      INT NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
  mapping         JSON NOT NULL,
  errors          JSON NOT NULL,
  created_by_id   CHAR(25) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  KEY idx_import_org_created (organization_id, created_at),
  CONSTRAINT fk_import_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_import_creator FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE saved_views (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  user_id         CHAR(25) NOT NULL,
  entity          VARCHAR(20) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  filters         JSON NOT NULL,
  columns         JSON NOT NULL,
  sort            JSON NOT NULL,
  is_shared       TINYINT(1) NOT NULL DEFAULT 0,
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_savedview_org_entity_user (organization_id, entity, user_id),
  CONSTRAINT fk_savedview_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_savedview_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE targets (
  id              CHAR(25) PRIMARY KEY,
  organization_id CHAR(25) NOT NULL,
  user_id         CHAR(25) NULL,
  team_id         CHAR(25) NULL,
  metric          VARCHAR(20) NOT NULL,
  period          VARCHAR(10) NOT NULL,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  target_value    DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_target_org_period (organization_id, period_start, period_end),
  CONSTRAINT fk_target_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_target_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_target_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- Rate limiting (see lib/rate_limit.php) — a DB-backed counter since shared
-- hosting often has no Redis/APCu shared across PHP-FPM workers.
CREATE TABLE rate_limit_hits (
  id      BIGINT AUTO_INCREMENT PRIMARY KEY,
  bucket  VARCHAR(20) NOT NULL,
  rkey    VARCHAR(64) NOT NULL,
  hit_at  DATETIME NOT NULL,
  KEY idx_ratelimit_lookup (bucket, rkey, hit_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

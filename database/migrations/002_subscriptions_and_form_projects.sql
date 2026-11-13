-- ===========================================================================
-- 002_subscriptions_and_form_projects.sql
--
-- Two additions:
--
--   1. Subscription / billing state per client company, and an explicit switch
--      the Super Admin can throw to stop a company signing in when they have
--      not paid. This is deliberately separate from `status`: a company can be
--      operationally fine and simply behind on an invoice, and the two are
--      undone by different people for different reasons.
--
--   2. A web form can be tied to a project, so a landing page for one tower
--      produces leads already attributed to it.
--
-- MySQL 5.7+ / MariaDB 10.3+ safe: nullable columns or columns with defaults.
-- ===========================================================================

ALTER TABLE organizations
  -- ACTIVE | TRIAL | PAST_DUE | CANCELLED
  ADD COLUMN billing_status        VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' AFTER status,
  ADD COLUMN plan_name             VARCHAR(60)  NULL,
  ADD COLUMN seats                 INT          NULL,
  ADD COLUMN monthly_fee           DECIMAL(12,2) NULL,
  ADD COLUMN trial_ends_at         DATE         NULL,
  ADD COLUMN renews_at             DATE         NULL,
  ADD COLUMN last_payment_at       DATETIME     NULL,
  -- The switch itself. Kept as its own flag rather than derived from
  -- billing_status so the Super Admin decides when a missed payment actually
  -- locks people out - being one day late should not lock out a sales floor.
  ADD COLUMN access_blocked        TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN access_blocked_at     DATETIME     NULL,
  ADD COLUMN access_blocked_reason VARCHAR(300) NULL,
  ADD COLUMN billing_notes         VARCHAR(500) NULL,
  ADD KEY idx_org_billing (billing_status, access_blocked);

ALTER TABLE web_forms
  ADD COLUMN project_id CHAR(25) NULL AFTER source_id,
  ADD KEY idx_form_project (project_id),
  ADD CONSTRAINT fk_form_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

-- ===========================================================================
-- 003_staff_lead_notifications.sql
--
-- Notifications aimed at the sales team, not the buyer.
--
-- The welcome message a buyer receives already exists and is governed by the
-- red / amber / green channel state. What was missing is the other direction:
-- telling the person who owns the lead that it arrived, and warning them
-- BEFORE a follow-up is due rather than after it has been missed.
--
-- These are separate switches from `welcome_enabled` on purpose. A company may
-- want its own people emailed about new business while it is still deciding
-- what to say to buyers - and the reverse. One switch could not express that.
--
-- MySQL 5.7+ / MariaDB 10.3+ safe: every column is nullable or has a default.
-- ===========================================================================

ALTER TABLE email_settings
  -- Email the lead's owner the moment a lead lands or is assigned to them.
  ADD COLUMN notify_new_lead        TINYINT(1)  NOT NULL DEFAULT 0,
  -- Email the owner ahead of a scheduled follow-up.
  ADD COLUMN notify_followup        TINYINT(1)  NOT NULL DEFAULT 0,
  -- How far ahead of the follow-up time the warning goes out. The sweep runs
  -- every 15 minutes, so anything below that would be unreliable.
  ADD COLUMN followup_lead_minutes  SMALLINT    NOT NULL DEFAULT 60,
  -- Copy every new-lead alert to one address as well - the sales head who
  -- wants to see the flow without owning any of it. Optional.
  ADD COLUMN notify_cc_email        VARCHAR(190) NULL;

-- No new index: the sweep walks one organisation at a time, so the existing
-- idx_lead_org_followup (organization_id, next_follow_up_at) already covers it.

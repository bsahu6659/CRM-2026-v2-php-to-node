-- ===========================================================================
-- 006_staff_alerts_on_by_default.sql
--
-- Staff alerts now send from the platform's own mailbox rather than each
-- company's SMTP, so there is nothing for a customer to configure before they
-- work. That changes what the sensible default is.
--
-- Added in 003 and 005 they defaulted to off, because switching them on before
-- a tenant had configured email would only have produced a log full of skips.
-- On the shared mailer they work from the first day of a company's life, so
-- they are on for everyone - existing companies included.
--
-- The switches stay: a company that does not want the email can still turn it
-- off. This only changes where the switch starts.
--
-- Deliberately NOT changing welcome_enabled: what a buyer receives is still the
-- customer's decision, and still gated on their own verified channel.
-- ===========================================================================

ALTER TABLE email_settings
  ALTER COLUMN notify_new_lead      SET DEFAULT 1,
  ALTER COLUMN notify_followup      SET DEFAULT 1,
  ALTER COLUMN notify_daily_summary SET DEFAULT 1;

UPDATE email_settings
   SET notify_new_lead      = 1,
       notify_followup      = 1,
       notify_daily_summary = 1
 WHERE notify_new_lead = 0
   AND notify_followup = 0
   AND notify_daily_summary = 0;

-- ===========================================================================
-- 005_daily_summary_email.sql
--
-- The morning digest: what each salesperson has to do today.
--
-- This is a different thing from the two alerts added in 003. Those fire at a
-- moment - a lead arrived, a follow-up is an hour away. This one answers the
-- question somebody asks while still holding their first cup of tea: what is
-- on me today? It lists their follow-ups due and their site visits booked, and
-- it is sent once, per person, per day.
--
-- Nobody is emailed an empty list. A digest that arrives every morning saying
-- "nothing today" is trained out of people within a fortnight, and then the one
-- that matters is ignored too.
--
-- MySQL 5.7+ / MariaDB 10.3+ safe: every column has a default.
-- ===========================================================================

ALTER TABLE email_settings
  -- Send the morning digest at all.
  ADD COLUMN notify_daily_summary  TINYINT(1) NOT NULL DEFAULT 0,
  -- Hour of the day it goes out, 0-23, in the organisation's own timezone. The
  -- sweep runs every 15 minutes, so the digest leaves within a quarter of an
  -- hour of this.
  ADD COLUMN daily_summary_hour    TINYINT    NOT NULL DEFAULT 8;

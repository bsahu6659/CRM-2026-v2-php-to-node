-- ===========================================================================
-- 008_staff_alert_columns_repair.sql
--
-- Brings email_settings to the state 003 + 005 + 006 together describe, on an
-- install where those three were run out of order, partially, or not at all.
--
-- Why this exists: 006 assumes the columns 003 and 005 added. Run 006 on a
-- database that never saw 003 and MySQL stops at
--
--     #1054 - Unknown column 'notify_new_lead' in 'email_settings'
--
-- leaving the migration half applied and no obvious way to tell how half.
-- Rather than ask an administrator to work out which of six columns exist,
-- this file asks the database and adds only what is missing.
--
-- SAFE TO RUN ON ANY INSTALL, INCLUDING ONE THAT IS ALREADY CORRECT, AND SAFE
-- TO RUN TWICE. It adds no data and deletes none.
--
-- After this, 003, 005 and 006 have nothing left to do. Skip them.
--
-- MySQL 5.7+ / MariaDB 10.3+.
-- ===========================================================================

-- --- from 003 -------------------------------------------------------------
-- Note the default: 003 shipped these as 0 because staff alerts then depended
-- on each company's own SMTP. They now send from the platform mailbox, so 006
-- turned them on for everybody. A column created here is created in its final
-- state rather than created wrong and then corrected.

SET @sql = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_settings'
    AND COLUMN_NAME = 'notify_new_lead') = 0,
  'ALTER TABLE email_settings ADD COLUMN notify_new_lead TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT ''notify_new_lead already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_settings'
    AND COLUMN_NAME = 'notify_followup') = 0,
  'ALTER TABLE email_settings ADD COLUMN notify_followup TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT ''notify_followup already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The sweep runs every 15 minutes, so a warning set closer than that would be
-- unreliable. 60 is the shipped default.
SET @sql = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_settings'
    AND COLUMN_NAME = 'followup_lead_minutes') = 0,
  'ALTER TABLE email_settings ADD COLUMN followup_lead_minutes SMALLINT NOT NULL DEFAULT 60',
  'SELECT ''followup_lead_minutes already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_settings'
    AND COLUMN_NAME = 'notify_cc_email') = 0,
  'ALTER TABLE email_settings ADD COLUMN notify_cc_email VARCHAR(190) NULL',
  'SELECT ''notify_cc_email already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- from 005 -------------------------------------------------------------

SET @sql = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_settings'
    AND COLUMN_NAME = 'notify_daily_summary') = 0,
  'ALTER TABLE email_settings ADD COLUMN notify_daily_summary TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT ''notify_daily_summary already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Hour of the day the digest goes out, 0-23, in the organisation's own
-- timezone.
SET @sql = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_settings'
    AND COLUMN_NAME = 'daily_summary_hour') = 0,
  'ALTER TABLE email_settings ADD COLUMN daily_summary_hour TINYINT NOT NULL DEFAULT 8',
  'SELECT ''daily_summary_hour already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- from 006 -------------------------------------------------------------
-- Every column above now exists, so this is plain SQL again. It corrects a
-- column that an earlier 003 or 005 created with the old default of 0.

ALTER TABLE email_settings
  ALTER COLUMN notify_new_lead      SET DEFAULT 1,
  ALTER COLUMN notify_followup      SET DEFAULT 1,
  ALTER COLUMN notify_daily_summary SET DEFAULT 1;

-- Companies that already existed when the switches were off. The three-way
-- test is deliberate: a company that turned ONE of them off made a choice, and
-- this must not undo it. Only a row with all three off was never asked.
UPDATE email_settings
   SET notify_new_lead      = 1,
       notify_followup      = 1,
       notify_daily_summary = 1
 WHERE notify_new_lead = 0
   AND notify_followup = 0
   AND notify_daily_summary = 0;

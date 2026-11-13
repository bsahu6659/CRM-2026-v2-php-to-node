-- ===========================================================================
-- 007_meta_oauth_connect.sql
--
-- Lets each client company connect its OWN Facebook page, instead of an
-- administrator pasting one page's token by hand.
--
-- The company's admin presses "Connect Facebook", authorises the app on their
-- own account, and picks their page. Nothing about that flow can live in the
-- session alone: the browser leaves for facebook.com and comes back to a fixed
-- callback URL, so the request that returns is a different one from the request
-- that left. This table is what carries the thread across.
--
--   state_hash      the unguessable value sent to Facebook and checked on the
--                   way back, stored hashed for the same reason a session token
--                   is - a leaked database row must not be replayable.
--   user_token_enc  the long-lived user token, held only between the callback
--                   and the moment the admin picks their pages, then cleared.
--                   It can list every page that person administers, so it is
--                   encrypted and short-lived by design.
--
-- Rows are disposable. Anything older than its expires_at is dead weight and
-- the sweep deletes it.
--
-- MySQL 5.7+ / MariaDB 10.3+ safe.
-- ===========================================================================

CREATE TABLE meta_oauth_states (
  id               CHAR(25) PRIMARY KEY,
  organization_id  CHAR(25) NOT NULL,
  user_id          CHAR(25) NOT NULL,
  state_hash       CHAR(64) NOT NULL,
  -- PENDING -> AUTHORISED (token held, pages not yet chosen) -> USED
  status           VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  user_token_enc   TEXT NULL,
  error            VARCHAR(400) NULL,
  expires_at       DATETIME NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_meta_state (state_hash),
  KEY idx_meta_state_org (organization_id, created_at),
  CONSTRAINT fk_meta_state_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_meta_state_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which page a connected form belongs to, in words. Without it the screen can
-- only show a numeric page id, which tells an admin nothing about whether they
-- connected the right one.
ALTER TABLE meta_lead_forms
  ADD COLUMN page_name VARCHAR(200) NULL AFTER meta_page_id,
  -- Set once the page is subscribed to the app's leadgen webhook. A page that
  -- is connected but not subscribed looks perfectly healthy and delivers
  -- nothing, which is the failure this column exists to make visible.
  ADD COLUMN subscribed_at DATETIME NULL;

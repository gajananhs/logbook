-- LOGBOOK task manager — schema
-- Run once against a fresh database: mysql -u USER -p DBNAME < schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(40)  PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  pin_hash      VARCHAR(255) NULL,
  is_admin      TINYINT(1)   NOT NULL DEFAULT 0,
  department    VARCHAR(100) NULL,
  phone         VARCHAR(30)  NULL,
  last_seen     DATETIME     NULL,
  last_lat      DECIMAL(10,7) NULL,
  last_lng      DECIMAL(10,7) NULL,
  location_at   DATETIME     NULL,
  created_at    DATETIME     NOT NULL,
  UNIQUE KEY uniq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS statuses (
  id            VARCHAR(40)  PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  color         VARCHAR(7)   NOT NULL,       -- hex, e.g. #22C55E
  is_done       TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order    INT          NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_status_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tasks (
  id              VARCHAR(40)  PRIMARY KEY,
  title           VARCHAR(255) NOT NULL,
  description     TEXT NULL,
  assigned_to     VARCHAR(40)  NOT NULL,
  assigned_by     VARCHAR(40)  NOT NULL,
  created_at      DATETIME     NOT NULL,
  due_date        DATE NULL,
  estimated_hours DECIMAL(6,2) NULL,
  status          VARCHAR(40)  NOT NULL,      -- references statuses(id)
  completed_at    DATETIME NULL,
  actual_hours    DECIMAL(6,2) NULL,
  FOREIGN KEY (assigned_to) REFERENCES users(id),
  FOREIGN KEY (assigned_by) REFERENCES users(id),
  FOREIGN KEY (status) REFERENCES statuses(id),
  INDEX idx_assigned_to (assigned_to),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed statuses (color-coded, matching your existing status list). Safe to re-run.
INSERT IGNORE INTO statuses (id, name, color, is_done, sort_order) VALUES
  ('st_closed',        'Closed',               '#22C55E', 1, 1),
  ('st_draft',         'Draft',                '#E8A8DE', 0, 2),
  ('st_pending',       'Pending',              '#F5A623', 0, 3),
  ('st_rejected',      'Rejected',             '#7A4B4B', 0, 4),
  ('st_underreview',   'Under Review',         '#14B8A6', 0, 5),
  ('st_10',            '10',                   '#7C3AED', 0, 6),
  ('st_accepted',      'Accepted',             '#B91C1C', 0, 7),
  ('st_approval',      'Approval',             '#7C3AED', 0, 8),
  ('st_clientpending', 'Client Side Pending',  '#EC4899', 0, 9),
  ('st_dispatch',      'Dispatch',             '#14B8A6', 0, 10),
  ('st_docspending',   'Documents Pending',    '#7C3AED', 0, 11),
  ('st_doing',         'Doing',                '#65A30D', 0, 12),
  ('st_followup',      'Email /Followup',      '#78716C', 0, 13),
  ('st_extendtime',    'Extend Time Line Req', '#B91C1C', 0, 14),
  ('st_idea',          'Idea',                 '#7C3AED', 0, 15);

CREATE TABLE IF NOT EXISTS task_updates (
  id              VARCHAR(40)  PRIMARY KEY,
  task_id         VARCHAR(40)  NOT NULL,
  ts              DATETIME     NOT NULL,
  progress_pct    TINYINT UNSIGNED NOT NULL,
  hours_logged    DECIMAL(6,2) NULL,
  note            TEXT NULL,
  by_user_id      VARCHAR(40)  NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user_id) REFERENCES users(id),
  INDEX idx_task_id (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attendance (
  id           VARCHAR(40)  PRIMARY KEY,
  user_id      VARCHAR(40)  NOT NULL,
  clock_in     DATETIME     NOT NULL,
  clock_out    DATETIME     NULL,
  lat_in       DECIMAL(10,7) NULL,
  lng_in       DECIMAL(10,7) NULL,
  lat_out      DECIMAL(10,7) NULL,
  lng_out      DECIMAL(10,7) NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_user_clockin (user_id, clock_in)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notifications (
  id           VARCHAR(40)  PRIMARY KEY,
  user_id      VARCHAR(40)  NOT NULL,
  message      VARCHAR(255) NOT NULL,
  task_id      VARCHAR(40)  NULL,
  is_read      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reports (
  id             VARCHAR(40)  PRIMARY KEY,
  generated_by   VARCHAR(40)  NOT NULL,
  type           VARCHAR(50)  NOT NULL,
  range_start    DATE         NULL,
  range_end      DATE         NULL,
  data           LONGTEXT     NOT NULL,   -- JSON snapshot, so history doesn't need to recompute
  created_at     DATETIME     NOT NULL,
  FOREIGN KEY (generated_by) REFERENCES users(id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Migration for existing installs (safe to skip on a fresh install):
-- ALTER TABLE users ADD COLUMN pin_hash VARCHAR(255) NULL AFTER name;
--
-- If you already deployed the earlier version (fixed open/in_progress/completed status),
-- run the block below to switch to custom color-coded statuses:
--
-- CREATE TABLE IF NOT EXISTS statuses (
--   id VARCHAR(40) PRIMARY KEY, name VARCHAR(100) NOT NULL, color VARCHAR(7) NOT NULL,
--   is_done TINYINT(1) NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0,
--   UNIQUE KEY uniq_status_name (name)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- INSERT INTO statuses (id, name, color, is_done, sort_order) VALUES
--   ('st_open', 'Open', '#5B7A94', 0, 1),
--   ('st_inprogress', 'In Progress', '#F2A93B', 0, 2),
--   ('st_completed', 'Completed', '#4FA8A0', 1, 3);
-- UPDATE tasks SET status = CONCAT('st_', status) WHERE status IN ('open','in_progress','completed');
--   -- (this maps old 'open' -> 'st_open' etc. to match the seed IDs above)
-- ALTER TABLE tasks MODIFY status VARCHAR(40) NOT NULL;
-- ALTER TABLE tasks ADD FOREIGN KEY (status) REFERENCES statuses(id);
--
-- If you already deployed the earlier version (no employees/attendance/notifications/reports),
-- run this block to add them:
--
-- ALTER TABLE users
--   ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER pin_hash,
--   ADD COLUMN department VARCHAR(100) NULL AFTER is_admin,
--   ADD COLUMN phone VARCHAR(30) NULL AFTER department,
--   ADD COLUMN last_seen DATETIME NULL AFTER phone,
--   ADD COLUMN last_lat DECIMAL(10,7) NULL AFTER last_seen,
--   ADD COLUMN last_lng DECIMAL(10,7) NULL AFTER last_lat,
--   ADD COLUMN location_at DATETIME NULL AFTER last_lng;
-- -- make your existing first user an admin so someone can manage employees:
-- UPDATE users SET is_admin = 1 ORDER BY created_at ASC LIMIT 1;
-- (then re-run this file — CREATE TABLE IF NOT EXISTS will add attendance/notifications/reports)

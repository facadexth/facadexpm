-- Lets a worker self-link via a one-time DM code (mirrors user_roles'
-- existing OWNER/ADMIN linking flow) -- the PRIMARY onboarding path,
-- not dependent on ever having posted in the crew group (group
-- membership is unreliable: people come and go).
ALTER TABLE workers ADD COLUMN line_link_code TEXT;
CREATE UNIQUE INDEX idx_workers_line_link_code ON workers(line_link_code) WHERE line_link_code IS NOT NULL;

-- Rate-limits the "a departed worker (status='inactive') is still
-- messaging the bot" alert to OWNER(s) -- without this, every message
-- from a still-in-the-group offboarded worker would re-fire it.
-- LINE bots have no "kick member from group" API, so this is the
-- closest to automatic offboarding available: the bot refuses to act
-- on anything an inactive worker sends, and tells an OWNER so a human
-- removes them from the group.
ALTER TABLE workers ADD COLUMN line_offboarding_alerted_at TIMESTAMPTZ;

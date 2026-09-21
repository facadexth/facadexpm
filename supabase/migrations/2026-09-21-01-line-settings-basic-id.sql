-- Communication Center page needs the bot's public "Basic ID" (the
-- @handle shown in LINE's console, e.g. @302yljzw) to build a tappable
-- "add friend + pre-filled linking code" link
-- (https://line.me/R/oaMessage/@{basic_id}/?{code}) for each worker --
-- previously only known to me, typed by hand when generating QR sheets.
alter table line_settings add column basic_id text;

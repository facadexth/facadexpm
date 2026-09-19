-- supabase/migrations/2026-09-19-03-enable-pg-cron-pg-net.sql
--
-- Prerequisite for 2026-09-19-02-line-push-cron.sql's cron.schedule() /
-- net.http_post() calls. Verified via
-- `select * from pg_extension where extname in ('pg_cron','pg_net');`
-- before this migration: zero rows -- neither extension was enabled on
-- this project yet.
create extension if not exists pg_cron;
create extension if not exists pg_net;

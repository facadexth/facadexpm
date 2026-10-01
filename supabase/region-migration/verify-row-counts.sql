SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname IN ('public', 'auth')
ORDER BY schemaname, relname;

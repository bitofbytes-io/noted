SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP INDEX IF EXISTS pieces_search_trgm_idx;
-- pg_trgm may predate Noted's index or serve other objects; retain it.

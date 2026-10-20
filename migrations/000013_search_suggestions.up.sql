-- The migration runner supplies the transaction. Bound lock acquisition and
-- index build time; CREATE INDEX CONCURRENTLY is not legal in this transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX pieces_search_trgm_idx ON pieces USING gin (search_text gin_trgm_ops);

-- Display names stay untouched. Go repairs keys in bounded batches; the source
-- and version markers let new readers detect writes from older API replicas.
ALTER TABLE pieces
    ADD COLUMN composer_sort TEXT NOT NULL DEFAULT '',
    ADD COLUMN composer_sort_source TEXT NOT NULL DEFAULT '',
    ADD COLUMN composer_sort_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX pieces_composer_sort_idx ON pieces (user_id, composer_sort, lower(title));

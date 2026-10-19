-- Search matches each word of a query against search_text: the piece's title,
-- composer, aliases and notes, folded by the API (foldSearch) to lower case
-- without accents or punctuation, so it needs no unaccent extension. The
-- backfill here is only lower-cased; search_index_state starts at fold version
-- 0, so the API refolds every row on its first start.
ALTER TABLE pieces
    ADD COLUMN aliases TEXT NOT NULL DEFAULT ''
        CONSTRAINT pieces_aliases_check CHECK (length(aliases) <= 1000),
    ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

UPDATE pieces SET search_text = lower(title || ' ' || composer || ' ' || notes);

CREATE TABLE search_index_state (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    fold_version INTEGER NOT NULL
);

INSERT INTO search_index_state (id, fold_version) VALUES (TRUE, 0);

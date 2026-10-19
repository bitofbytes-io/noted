-- Each piece is Learning, Playing or Shelved; existing pieces start as Playing.
-- The library opens on the filter its user last chose, so it follows them
-- across devices; 'current' is Learning and Playing together.
ALTER TABLE pieces
    ADD COLUMN status TEXT NOT NULL DEFAULT 'playing'
        CONSTRAINT pieces_status_check CHECK (status IN ('learning', 'playing', 'shelved'));

CREATE INDEX pieces_user_status_idx ON pieces (user_id, status);

ALTER TABLE users
    ADD COLUMN library_filter TEXT NOT NULL DEFAULT 'current'
        CONSTRAINT users_library_filter_check CHECK (
            library_filter IN ('current', 'all', 'favorites', 'learning', 'playing', 'shelved')
        );

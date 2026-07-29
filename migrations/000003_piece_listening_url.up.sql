ALTER TABLE pieces
    ADD COLUMN listening_url TEXT NOT NULL DEFAULT ''
    CHECK (length(listening_url) <= 2000);

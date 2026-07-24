CREATE TABLE pieces (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
    composer TEXT NOT NULL DEFAULT '' CHECK (length(composer) <= 300),
    favorite BOOLEAN NOT NULL DEFAULT FALSE,
    source_url TEXT NOT NULL DEFAULT '' CHECK (length(source_url) <= 2000),
    notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE piece_pdfs (
    piece_id UUID PRIMARY KEY REFERENCES pieces(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
    page_count INTEGER NOT NULL CHECK (page_count > 0),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reader_states (
    piece_id UUID PRIMARY KEY REFERENCES pieces(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'page' CHECK (mode IN ('page', 'scroll')),
    last_page INTEGER NOT NULL DEFAULT 1 CHECK (last_page > 0),
    scroll_position DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (scroll_position >= 0),
    zoom DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (zoom BETWEEN 0.5 AND 2.5),
    scroll_speed DOUBLE PRECISION NOT NULL DEFAULT 32 CHECK (scroll_speed BETWEEN 5 AND 120),
    scroll_paused BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pieces_title_lower_idx ON pieces (lower(title));
CREATE INDEX pieces_composer_lower_idx ON pieces (lower(composer));
CREATE INDEX pieces_favorite_idx ON pieces (favorite) WHERE favorite;

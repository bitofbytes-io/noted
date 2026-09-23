CREATE TABLE imslp_catalog_state (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    active_generation UUID,
    refreshed_at TIMESTAMPTZ,
    last_error TEXT
);
INSERT INTO imslp_catalog_state (id) VALUES (TRUE);

CREATE TABLE imslp_catalog_works (
    generation UUID NOT NULL,
    work_id TEXT NOT NULL,
    title TEXT NOT NULL,
    composer TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (generation, work_id)
);

ALTER TABLE editions ADD COLUMN archived_at timestamptz;

ALTER TABLE score_assets
    ADD COLUMN display_name text,
    ADD COLUMN archived_at timestamptz,
    ADD COLUMN replaces_asset_id uuid REFERENCES score_assets(id) ON DELETE SET NULL,
    ADD COLUMN derived_from_asset_id uuid REFERENCES score_assets(id) ON DELETE RESTRICT,
    ADD COLUMN verification_state text NOT NULL DEFAULT 'original'
        CHECK (verification_state IN ('original', 'unverified_ocr', 'verified'));

UPDATE score_assets SET display_name = original_filename WHERE display_name IS NULL;

CREATE TABLE recognition_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_asset_id uuid NOT NULL REFERENCES score_assets(id) ON DELETE CASCADE,
    output_asset_id uuid REFERENCES score_assets(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
    engine text NOT NULL DEFAULT 'audiveris',
    engine_version text NOT NULL DEFAULT '5.10.2',
    failure_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX recognition_jobs_active_source
    ON recognition_jobs(user_id, source_asset_id)
    WHERE status IN ('queued', 'processing');
CREATE INDEX recognition_jobs_source_created
    ON recognition_jobs(source_asset_id, created_at DESC);

CREATE TABLE development_seed_state (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

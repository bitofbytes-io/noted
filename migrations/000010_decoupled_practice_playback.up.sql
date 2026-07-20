ALTER TABLE score_assets
    DROP CONSTRAINT score_assets_asset_type_check,
    ADD CONSTRAINT score_assets_asset_type_check
        CHECK (asset_type IN ('pdf', 'musicxml', 'midi', 'audio', 'image'));

ALTER TABLE recognition_jobs
    ADD COLUMN job_kind text NOT NULL DEFAULT 'transcribe'
        CHECK (job_kind IN ('transcribe', 'measure_map')),
    ADD COLUMN hints jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(hints) = 'object');

DROP INDEX recognition_jobs_active_source;
CREATE UNIQUE INDEX recognition_jobs_active_source_kind
    ON recognition_jobs(user_id, source_asset_id, job_kind)
    WHERE status IN ('queued', 'processing');

CREATE TABLE media_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    edition_id uuid NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind = 'youtube'),
    video_id text NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
    title text NOT NULL DEFAULT '' CHECK (length(title) <= 300),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, edition_id, kind, video_id)
);

CREATE INDEX media_links_edition_created
    ON media_links(edition_id, created_at);

CREATE TABLE measure_anchors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_link_id uuid REFERENCES media_links(id) ON DELETE CASCADE,
    asset_id uuid REFERENCES score_assets(id) ON DELETE CASCADE,
    measure_number integer NOT NULL CHECK (measure_number > 0),
    position_ms bigint NOT NULL CHECK (position_ms >= 0 AND position_ms <= 86400000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((media_link_id IS NOT NULL)::integer + (asset_id IS NOT NULL)::integer = 1)
);

CREATE UNIQUE INDEX measure_anchors_media_measure
    ON measure_anchors(user_id, media_link_id, measure_number)
    WHERE media_link_id IS NOT NULL;
CREATE UNIQUE INDEX measure_anchors_asset_measure
    ON measure_anchors(user_id, asset_id, measure_number)
    WHERE asset_id IS NOT NULL;

CREATE TABLE measure_maps (
    asset_id uuid PRIMARY KEY REFERENCES score_assets(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    pages jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(pages) = 'array'),
    engine_version text NOT NULL DEFAULT '',
    failure_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX measure_maps_user_status
    ON measure_maps(user_id, status, updated_at);

INSERT INTO measure_maps(asset_id,user_id)
SELECT a.id,a.uploaded_by_user_id
FROM score_assets a
WHERE a.asset_type IN ('pdf','image')
ON CONFLICT (asset_id) DO NOTHING;

INSERT INTO recognition_jobs(user_id,source_asset_id,job_kind,engine,engine_version)
SELECT a.uploaded_by_user_id,a.id,'measure_map','audiveris-measures','audiveris-5.10.2-measures'
FROM score_assets a
WHERE a.asset_type IN ('pdf','image')
  AND NOT EXISTS (
      SELECT 1 FROM recognition_jobs r
      WHERE r.user_id=a.uploaded_by_user_id AND r.source_asset_id=a.id AND r.job_kind='measure_map'
  );

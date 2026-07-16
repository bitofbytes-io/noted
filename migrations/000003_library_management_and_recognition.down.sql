DROP TABLE IF EXISTS development_seed_state;
DROP TABLE IF EXISTS recognition_jobs;
ALTER TABLE score_assets
    DROP COLUMN IF EXISTS verification_state,
    DROP COLUMN IF EXISTS derived_from_asset_id,
    DROP COLUMN IF EXISTS replaces_asset_id,
    DROP COLUMN IF EXISTS archived_at,
    DROP COLUMN IF EXISTS display_name;
ALTER TABLE editions DROP COLUMN IF EXISTS archived_at;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM score_assets WHERE asset_type IN ('midi','audio','image'))
       OR EXISTS (SELECT 1 FROM media_links)
       OR EXISTS (SELECT 1 FROM measure_anchors) THEN
        RAISE EXCEPTION 'cannot roll back decoupled playback while user playback media or anchors exist';
    END IF;
END $$;

DROP TABLE measure_maps;
DROP TABLE measure_anchors;
DROP TABLE media_links;

DROP INDEX recognition_jobs_active_source_kind;
DELETE FROM recognition_jobs WHERE job_kind = 'measure_map';
ALTER TABLE recognition_jobs
    DROP COLUMN hints,
    DROP COLUMN job_kind;
CREATE UNIQUE INDEX recognition_jobs_active_source
    ON recognition_jobs(user_id, source_asset_id)
    WHERE status IN ('queued', 'processing');

ALTER TABLE score_assets
    DROP CONSTRAINT score_assets_asset_type_check,
    ADD CONSTRAINT score_assets_asset_type_check
        CHECK (asset_type IN ('pdf', 'musicxml'));

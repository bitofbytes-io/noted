ALTER TABLE recognition_jobs
    ADD COLUMN project_storage_key text
        CHECK (project_storage_key IS NULL OR project_storage_key ~ '^omr/[0-9a-f-]{36}$');

-- Musical inconsistencies in OCR output are review warnings. Only malformed
-- MusicXML remains blocked; the notation engine gets the final import attempt.
UPDATE score_assets
SET playback_capable = true,
    playback_validation_status = 'needs_review',
    updated_at = now()
WHERE asset_type = 'musicxml'
  AND playback_validation_status = 'blocked'
  AND NOT playback_validation_issues @> '[{"code":"invalid_musicxml"}]'::jsonb;

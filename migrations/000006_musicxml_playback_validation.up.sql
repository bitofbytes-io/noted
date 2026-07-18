ALTER TABLE score_assets
    ADD COLUMN playback_validation_status text NOT NULL DEFAULT 'not_checked'
        CHECK (playback_validation_status IN ('not_checked', 'ready', 'needs_review', 'blocked')),
    ADD COLUMN playback_validation_issues jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(playback_validation_issues) = 'array');

ALTER TABLE score_assets DROP CONSTRAINT score_assets_verification_state_check;
ALTER TABLE score_assets ADD CONSTRAINT score_assets_verification_state_check
    CHECK (verification_state IN ('original', 'unverified_ocr', 'verified', 'corrected'));

-- Existing MusicXML must be inspected by the revalidation command before the
-- UI can claim it is playable. PDF assets do not use this validation state.
UPDATE score_assets
SET playback_capable = false,
    playback_validation_status = 'not_checked',
    playback_validation_issues = '[]'::jsonb
WHERE asset_type = 'musicxml';

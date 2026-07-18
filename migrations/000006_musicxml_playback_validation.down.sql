UPDATE score_assets SET verification_state = 'verified' WHERE verification_state = 'corrected';
-- The pre-validation application derives playability directly from the asset
-- type, so restore that legacy behavior before removing the validation state.
UPDATE score_assets SET playback_capable = true WHERE asset_type = 'musicxml';
ALTER TABLE score_assets DROP CONSTRAINT score_assets_verification_state_check;
ALTER TABLE score_assets ADD CONSTRAINT score_assets_verification_state_check
    CHECK (verification_state IN ('original', 'unverified_ocr', 'verified'));

ALTER TABLE score_assets
    DROP COLUMN IF EXISTS playback_validation_issues,
    DROP COLUMN IF EXISTS playback_validation_status;

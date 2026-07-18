UPDATE score_assets SET verification_state = 'verified' WHERE verification_state = 'corrected';
ALTER TABLE score_assets DROP CONSTRAINT score_assets_verification_state_check;
ALTER TABLE score_assets ADD CONSTRAINT score_assets_verification_state_check
    CHECK (verification_state IN ('original', 'unverified_ocr', 'verified'));

ALTER TABLE score_assets
    DROP COLUMN IF EXISTS playback_validation_issues,
    DROP COLUMN IF EXISTS playback_validation_status;

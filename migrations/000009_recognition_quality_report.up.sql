ALTER TABLE recognition_jobs
    ADD COLUMN failure_code text
        CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,100}$'),
    ADD COLUMN flagged_measures integer
        CHECK (flagged_measures IS NULL OR flagged_measures >= 0),
    ADD COLUMN corrected_measures integer
        CHECK (corrected_measures IS NULL OR corrected_measures >= 0),
    ADD COLUMN quality_report jsonb
        CHECK (quality_report IS NULL OR jsonb_typeof(quality_report) = 'object');

ALTER TABLE recognition_jobs
    ALTER COLUMN engine SET DEFAULT 'audiveris+homr',
    ALTER COLUMN engine_version SET DEFAULT 'audiveris-5.10.2+homr-0.7.0+music21-10.3.0+alphatab-1.8.4';

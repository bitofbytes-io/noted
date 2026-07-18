ALTER TABLE recognition_jobs
    ALTER COLUMN engine SET DEFAULT 'audiveris',
    ALTER COLUMN engine_version SET DEFAULT '5.10.2';

ALTER TABLE recognition_jobs
    DROP COLUMN IF EXISTS quality_report,
    DROP COLUMN IF EXISTS corrected_measures,
    DROP COLUMN IF EXISTS flagged_measures,
    DROP COLUMN IF EXISTS failure_code;

DROP INDEX IF EXISTS recognition_jobs_claimable;

ALTER TABLE recognition_jobs
    DROP COLUMN IF EXISTS attempt_count,
    DROP COLUMN IF EXISTS lease_expires_at,
    DROP COLUMN IF EXISTS lease_owner;

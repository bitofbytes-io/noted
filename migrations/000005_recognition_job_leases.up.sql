ALTER TABLE recognition_jobs
    ADD COLUMN lease_owner text,
    ADD COLUMN lease_expires_at timestamptz,
    ADD COLUMN attempt_count integer NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0);

-- Jobs left processing by a pre-lease API process are immediately reclaimable.
UPDATE recognition_jobs
SET lease_expires_at = now()
WHERE status = 'processing';

CREATE INDEX recognition_jobs_claimable
    ON recognition_jobs(created_at)
    WHERE status IN ('queued', 'processing');

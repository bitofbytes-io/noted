-- The migration runner supplies the transaction. Adding columns and validating
-- their checks requires ACCESS EXCLUSIVE; bound waits during a rolling deploy.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE pieces
 ADD COLUMN opus text NOT NULL DEFAULT '' CHECK (octet_length(opus) <= 100),
 ADD COLUMN music_key text NOT NULL DEFAULT '' CHECK (octet_length(music_key) <= 100);

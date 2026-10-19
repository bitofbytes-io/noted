ALTER TABLE users DROP COLUMN library_filter;
DROP INDEX pieces_user_status_idx;
ALTER TABLE pieces DROP COLUMN status;

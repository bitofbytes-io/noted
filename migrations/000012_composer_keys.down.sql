DROP INDEX pieces_composer_sort_idx;
ALTER TABLE pieces DROP COLUMN composer_sort, DROP COLUMN composer_sort_source, DROP COLUMN composer_sort_version;

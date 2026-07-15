ALTER TABLE works DROP CONSTRAINT IF EXISTS works_composer_id_title_catalog_number_key;
ALTER TABLE works ADD CONSTRAINT works_composer_id_title_catalog_number_key
    UNIQUE (composer_id, title, catalog_number);

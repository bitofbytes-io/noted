DROP TABLE asset_deletion_queue;
DROP TABLE piece_sources;
DROP TABLE draft_sources;
DROP TABLE import_drafts;
DROP TABLE import_assets;
ALTER TABLE pieces DROP COLUMN preparation_manifest;
ALTER TABLE pieces DROP COLUMN content_revision;

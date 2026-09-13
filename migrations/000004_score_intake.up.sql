ALTER TABLE pieces ADD COLUMN content_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE pieces ADD COLUMN preparation_manifest JSONB;
CREATE TABLE import_assets (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 storage_key TEXT NOT NULL UNIQUE, original_filename TEXT NOT NULL,
 mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png')),
 size_bytes BIGINT NOT NULL CHECK (size_bytes>0), checksum_sha256 TEXT NOT NULL,
 page_count INTEGER NOT NULL CHECK (page_count>0), width INTEGER NOT NULL DEFAULT 0,
 height INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE import_drafts (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 piece_id UUID REFERENCES pieces(id) ON DELETE CASCADE, base_revision BIGINT NOT NULL DEFAULT 0,
 revision BIGINT NOT NULL DEFAULT 0, metadata JSONB NOT NULL, manifest JSONB NOT NULL,
 initial_manifest JSONB NOT NULL, finalized BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX import_drafts_owner_idx ON import_drafts(user_id,updated_at);
CREATE TABLE draft_sources (
 draft_id UUID NOT NULL REFERENCES import_drafts(id) ON DELETE CASCADE,
 asset_id UUID NOT NULL REFERENCES import_assets(id), PRIMARY KEY(draft_id,asset_id)
);
CREATE TABLE piece_sources (
 piece_id UUID NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
 asset_id UUID NOT NULL REFERENCES import_assets(id), PRIMARY KEY(piece_id,asset_id)
);
CREATE TABLE asset_deletion_queue (
 storage_key TEXT PRIMARY KEY, queued_at TIMESTAMPTZ NOT NULL DEFAULT now(), attempts INTEGER NOT NULL DEFAULT 0
);

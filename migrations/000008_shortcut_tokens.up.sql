-- One Send to Noted shortcut token per user. Only the SHA-256 of the token is
-- stored; replacing it deletes and inserts in one transaction.
CREATE TABLE shortcut_tokens (
    user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash   BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

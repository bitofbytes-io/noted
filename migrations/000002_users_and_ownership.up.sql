DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pieces) THEN
        RAISE EXCEPTION
            'cannot add user ownership while pieces exist; delete the existing binder pieces first so their PDF objects are cleaned up safely';
    END IF;
END
$$;

CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
    display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 300),
    avatar_url TEXT,
    auth_provider TEXT NOT NULL CHECK (auth_provider IN ('development', 'google')),
    auth_subject TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_auth_identity_unique
    ON users (auth_provider, auth_subject)
    WHERE auth_subject IS NOT NULL;

CREATE TABLE user_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    expires_at TIMESTAMPTZ NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions (expires_at);

CREATE TABLE oauth_login_states (
    state_hash BYTEA PRIMARY KEY CHECK (octet_length(state_hash) = 32),
    return_path TEXT NOT NULL DEFAULT '/' CHECK (
        return_path LIKE '/%' AND return_path NOT LIKE '//%'
    ),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX oauth_login_states_expires_at_idx ON oauth_login_states (expires_at);

ALTER TABLE pieces
    ADD COLUMN user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX pieces_user_title_idx ON pieces (user_id, lower(title));
CREATE INDEX pieces_user_composer_idx ON pieces (user_id, lower(composer));
CREATE INDEX pieces_user_favorite_idx ON pieces (user_id, favorite) WHERE favorite;

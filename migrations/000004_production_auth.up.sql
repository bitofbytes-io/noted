DO $$
DECLARE
    colliding_email text;
BEGIN
    SELECT lower(email)
    INTO colliding_email
    FROM users
    GROUP BY lower(email)
    HAVING count(*) > 1
    ORDER BY lower(email)
    LIMIT 1;

    IF colliding_email IS NOT NULL THEN
        RAISE EXCEPTION 'cannot normalize users.email: case-colliding accounts exist for %', colliding_email
            USING ERRCODE = 'unique_violation',
                  HINT = 'Merge or rename the colliding users before retrying migration 000004_production_auth.';
    END IF;
END
$$;

UPDATE users SET email = lower(email);

CREATE UNIQUE INDEX users_normalized_email_unique
    ON users (lower(email));

CREATE UNIQUE INDEX users_auth_identity_unique
    ON users (auth_provider, auth_subject)
    WHERE auth_subject IS NOT NULL;

CREATE TABLE user_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    expires_at timestamptz NOT NULL,
    user_agent text NOT NULL DEFAULT '',
    ip_address inet,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions (expires_at);

CREATE TABLE oauth_login_states (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
    return_path text NOT NULL DEFAULT '/' CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%'),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_login_states_expires_at_idx ON oauth_login_states (expires_at);

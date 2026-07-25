DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pieces) THEN
        RAISE EXCEPTION
            'cannot remove user ownership while pieces exist; rollback would expose private libraries';
    END IF;
END
$$;

DROP INDEX IF EXISTS pieces_user_favorite_idx;
DROP INDEX IF EXISTS pieces_user_composer_idx;
DROP INDEX IF EXISTS pieces_user_title_idx;

ALTER TABLE pieces DROP COLUMN user_id;

DROP TABLE oauth_login_states;
DROP TABLE user_sessions;
DROP TABLE users;

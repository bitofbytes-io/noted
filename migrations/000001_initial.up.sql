CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    display_name text NOT NULL,
    avatar_url text,
    auth_provider text NOT NULL DEFAULT 'development',
    auth_subject text,
    week_starts_on smallint NOT NULL DEFAULT 1 CHECK (week_starts_on = 1),
    metronome_bpm integer NOT NULL DEFAULT 96 CHECK (metronome_bpm BETWEEN 30 AND 240),
    metronome_accent boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

CREATE TABLE composers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name text NOT NULL,
    sort_name text NOT NULL,
    birth_year integer,
    death_year integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE works (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    composer_id uuid NOT NULL REFERENCES composers(id),
    title text NOT NULL,
    subtitle text,
    catalog_number text,
    key_signature text,
    form text,
    period text,
    published_difficulty_label text,
    notes text,
    created_by_user_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (composer_id, title, catalog_number)
);

CREATE TABLE movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    sequence_number integer NOT NULL CHECK (sequence_number > 0),
    title text NOT NULL,
    tempo_marking text,
    measure_count integer CHECK (measure_count > 0),
    UNIQUE (work_id, sequence_number)
);

CREATE TABLE editions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    name text NOT NULL,
    editor text,
    publisher text,
    publication_year integer,
    source_url text,
    rights_note text,
    created_by_user_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE score_assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    edition_id uuid NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    asset_type text NOT NULL CHECK (asset_type IN ('pdf', 'musicxml')),
    storage_key text NOT NULL UNIQUE,
    original_filename text NOT NULL,
    media_type text NOT NULL,
    byte_size bigint NOT NULL CHECK (byte_size > 0),
    sha256 text NOT NULL CHECK (length(sha256) = 64),
    source_url text,
    rights_note text NOT NULL,
    playback_capable boolean NOT NULL DEFAULT false,
    uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learner_works (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'Interested' CHECK (status IN ('Interested', 'Assigned', 'Learning', 'Playable', 'Polished', 'Memorized', 'Paused', 'Archived')),
    is_favorite boolean NOT NULL DEFAULT false,
    personal_difficulty text,
    personal_notes text,
    last_score_asset_id uuid REFERENCES score_assets(id) ON DELETE SET NULL,
    last_bpm integer CHECK (last_bpm BETWEEN 30 AND 300),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, work_id)
);

CREATE TABLE tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    normalized_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, normalized_name)
);

CREATE TABLE learner_work_tags (
    learner_work_id uuid NOT NULL REFERENCES learner_works(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (learner_work_id, tag_id)
);

CREATE TABLE practice_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    movement_id uuid REFERENCES movements(id) ON DELETE SET NULL,
    score_asset_id uuid REFERENCES score_assets(id) ON DELETE SET NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0 AND duration_seconds <= 86400),
    entry_method text NOT NULL CHECK (entry_method IN ('timer', 'manual')),
    start_measure integer CHECK (start_measure > 0),
    end_measure integer CHECK (end_measure > 0),
    hand_part text,
    starting_bpm integer CHECK (starting_bpm BETWEEN 30 AND 300),
    ending_bpm integer CHECK (ending_bpm BETWEEN 30 AND 300),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (end_measure IS NULL OR start_measure IS NOT NULL),
    CHECK (end_measure IS NULL OR end_measure >= start_measure),
    CHECK ((ended_at IS NULL AND entry_method = 'timer' AND duration_seconds = 0) OR (ended_at IS NOT NULL AND duration_seconds > 0))
);

CREATE UNIQUE INDEX one_running_timer_per_user ON practice_sessions(user_id) WHERE ended_at IS NULL;
CREATE INDEX learner_works_user_activity ON learner_works(user_id, updated_at DESC);
CREATE INDEX score_assets_edition_created ON score_assets(edition_id, created_at DESC);
CREATE INDEX practice_sessions_user_started ON practice_sessions(user_id, started_at DESC);
CREATE INDEX practice_sessions_work_started ON practice_sessions(work_id, started_at DESC);

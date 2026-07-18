ALTER TABLE users
    ADD COLUMN metronome_beats_per_bar smallint NOT NULL DEFAULT 4
        CHECK (metronome_beats_per_bar BETWEEN 1 AND 4),
    ADD COLUMN metronome_sound text NOT NULL DEFAULT 'classic'
        CHECK (metronome_sound IN ('classic', 'woodblock', 'soft_tick'));

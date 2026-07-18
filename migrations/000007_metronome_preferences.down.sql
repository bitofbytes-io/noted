ALTER TABLE users
    DROP COLUMN IF EXISTS metronome_sound,
    DROP COLUMN IF EXISTS metronome_beats_per_bar;

ALTER TABLE reader_states
    DROP CONSTRAINT reader_states_scroll_speed_check;

UPDATE reader_states
SET scroll_speed = GREATEST(5, LEAST(120, scroll_speed));

ALTER TABLE reader_states
    ALTER COLUMN scroll_speed SET DEFAULT 32,
    ADD CONSTRAINT reader_states_scroll_speed_check CHECK (scroll_speed BETWEEN 5 AND 120);

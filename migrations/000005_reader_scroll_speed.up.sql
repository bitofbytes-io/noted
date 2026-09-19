ALTER TABLE reader_states
    DROP CONSTRAINT reader_states_scroll_speed_check;

UPDATE reader_states
SET scroll_speed = GREATEST(1, LEAST(10, scroll_speed));

ALTER TABLE reader_states
    ALTER COLUMN scroll_speed SET DEFAULT 5,
    ADD CONSTRAINT reader_states_scroll_speed_check CHECK (scroll_speed BETWEEN 1 AND 10);

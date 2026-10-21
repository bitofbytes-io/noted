ALTER TABLE pieces
 ADD COLUMN opus text NOT NULL DEFAULT '' CHECK (octet_length(opus) <= 100),
 ADD COLUMN music_key text NOT NULL DEFAULT '' CHECK (octet_length(music_key) <= 100);

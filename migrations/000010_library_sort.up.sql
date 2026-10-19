-- The library opens on the sort its user last chose, next to their filter.
-- New and existing users start on Title.
ALTER TABLE users
    ADD COLUMN library_sort TEXT NOT NULL DEFAULT 'title'
        CONSTRAINT users_library_sort_check CHECK (
            library_sort IN ('title', 'composer', 'recent', 'added', 'fresh')
        );

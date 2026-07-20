#!/bin/sh
set -eu

go run ./cmd/migrate
playback_columns=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='recognition_jobs' AND column_name IN ('job_kind','hints')")
playback_tables=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('media_links','measure_anchors','measure_maps')")
if [ "$playback_columns" -ne 2 ] || [ "$playback_tables" -ne 3 ]; then
	echo "migration 000010 did not add playback/measure-map schema" >&2
	exit 1
fi
quality_columns=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='recognition_jobs' AND column_name IN ('failure_code','flagged_measures','corrected_measures','quality_report')")
if [ "$quality_columns" -ne 4 ]; then
	echo "migration 000009 did not add the recognition quality columns" >&2
	exit 1
fi
go run ./cmd/migrate down
playback_columns=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='recognition_jobs' AND column_name IN ('job_kind','hints')")
playback_tables=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('media_links','measure_anchors','measure_maps')")
if [ "$playback_columns" -ne 0 ] || [ "$playback_tables" -ne 0 ]; then
	echo "migration 000010 rollback left playback/measure-map schema behind" >&2
	exit 1
fi
quality_columns=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='recognition_jobs' AND column_name IN ('failure_code','flagged_measures','corrected_measures','quality_report')")
if [ "$quality_columns" -ne 4 ]; then
	echo "migration 000010 rollback damaged migration 000009 columns" >&2
	exit 1
fi
go run ./cmd/migrate down
quality_columns=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='recognition_jobs' AND column_name IN ('failure_code','flagged_measures','corrected_measures','quality_report')")
if [ "$quality_columns" -ne 0 ]; then
	echo "migration 000009 rollback left recognition quality columns behind" >&2
	exit 1
fi
go run ./cmd/migrate down

# A rollback from the validation-aware application must leave MusicXML playable
# for the preceding file-type-based application.
docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -v ON_ERROR_STOP=1 <<'SQL'
WITH learner AS (
    INSERT INTO users(id,email,display_name) VALUES ('30000000-0000-4000-8000-000000000001','migration-playback@example.test','Migration playback') RETURNING id
), composer AS (
    INSERT INTO composers(id,canonical_name,sort_name) VALUES ('30000000-0000-4000-8000-000000000002','Migration Composer','Migration Composer') RETURNING id
), work AS (
    INSERT INTO works(id,composer_id,title,created_by_user_id)
    SELECT '30000000-0000-4000-8000-000000000003', composer.id, 'Migration score', learner.id FROM composer, learner RETURNING id, created_by_user_id
), edition AS (
    INSERT INTO editions(id,work_id,name,created_by_user_id)
    SELECT '30000000-0000-4000-8000-000000000004', work.id, 'Migration edition', work.created_by_user_id FROM work RETURNING id, created_by_user_id
)
INSERT INTO score_assets(id,edition_id,asset_type,storage_key,original_filename,media_type,byte_size,sha256,rights_note,playback_capable,uploaded_by_user_id,playback_validation_status)
SELECT '30000000-0000-4000-8000-000000000005', edition.id, 'musicxml', 'musicxml/30000000-0000-4000-8000-000000000005', 'migration.musicxml', 'application/vnd.recordare.musicxml+xml', 1, repeat('a',64), 'CC0', false, edition.created_by_user_id, 'blocked' FROM edition;
SQL
go run ./cmd/migrate
warning_playback=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT playback_capable || ':' || playback_validation_status FROM score_assets WHERE id='30000000-0000-4000-8000-000000000005'")
if [ "$warning_playback" != "true:needs_review" ]; then
	echo "migration 000008 did not restore warning-only MusicXML playability" >&2
	exit 1
fi
go run ./cmd/migrate down
go run ./cmd/migrate down
go run ./cmd/migrate down
go run ./cmd/migrate down
go run ./cmd/migrate down
restored_playback=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT playback_capable FROM score_assets WHERE id='30000000-0000-4000-8000-000000000005'")
if [ "$restored_playback" != "t" ]; then
	echo "migration 000006 rollback did not restore MusicXML playability" >&2
	exit 1
fi

# Exercise the production-auth upgrade from the immediately preceding schema. The
# migration must reject case-colliding legacy accounts before changing either row.
go run ./cmd/migrate down
go run ./cmd/migrate down
docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO users (email, display_name) VALUES
    ('Migration.Collision@example.test', 'Migration collision upper'),
    ('migration.collision@example.test', 'Migration collision lower');
SQL
if collision_error=$(go run ./cmd/migrate 2>&1); then
	echo "expected migration 000004 to reject case-colliding emails" >&2
	exit 1
fi
case "$collision_error" in
	*"case-colliding accounts exist"*) ;;
	*)
		echo "migration 000004 failed without the expected case-collision diagnostic" >&2
		exit 1
		;;
esac
unchanged=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc "SELECT count(*) FROM users WHERE email = 'Migration.Collision@example.test'")
if [ "$unchanged" -ne 1 ]; then
	echo "migration 000004 changed a colliding email before rejecting the upgrade" >&2
	exit 1
fi
docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -v ON_ERROR_STOP=1 -c "DELETE FROM users WHERE lower(email) = 'migration.collision@example.test'" >/dev/null
go run ./cmd/migrate

expected=$(find migrations -name '*.up.sql' -type f | wc -l | tr -d ' ')
rolled_back=0
while [ "$rolled_back" -lt "$expected" ]; do
	go run ./cmd/migrate down
	rolled_back=$((rolled_back + 1))
done

remaining=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc 'SELECT count(*) FROM schema_migrations')
if [ "$remaining" -ne 0 ]; then
	echo "expected every migration to roll back; $remaining remain" >&2
	exit 1
fi

go run ./cmd/migrate
applied=$(docker compose -p noted -f compose.local.yml exec -T postgres psql -U noted -d "$TEST_DATABASE_NAME" -Atc 'SELECT count(*) FROM schema_migrations')
if [ "$applied" -ne "$expected" ]; then
	echo "expected $expected reapplied migrations; found $applied" >&2
	exit 1
fi

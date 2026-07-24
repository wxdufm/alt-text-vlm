-- Public dataset schema + data. This is the only migration in this repo --
-- running it against an empty Postgres database fully recreates the public
-- release_ids/discogs+musicbrainz dataset (524 releases, approved = true
-- and LENGTH(alt_text) < 131).
--
-- The \copy paths below are relative to the psql client's cwd, not this
-- file, so run this from the repo root:
--   psql "$PG_URI" -f migrations/001_public_schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE review_trigger_definitions (
    trigger             TEXT PRIMARY KEY,
    trigger_description TEXT NOT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT review_trigger_definitions_trigger_normalized
        CHECK (trigger = lower(btrim(trigger)) AND btrim(trigger) <> ''),
    CONSTRAINT review_trigger_definitions_description_present
        CHECK (btrim(trigger_description) <> '')
);

CREATE TRIGGER review_trigger_definitions_updated_at
    BEFORE UPDATE ON review_trigger_definitions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TABLE releases (
    id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    artist                  TEXT          NOT NULL,
    title                   TEXT          NOT NULL,
    cover_hash              bit(64)       UNIQUE,
    alt_text                TEXT,
    confidence              FLOAT         CHECK (confidence >= 0.0 AND confidence <= 1.0),
    review_triggers         JSONB,
    needs_review            BOOLEAN       NOT NULL DEFAULT false,
    approved                BOOLEAN       NOT NULL DEFAULT false,
    created_at              TIMESTAMP     NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMP     NOT NULL DEFAULT NOW(),
    confidence_explanation  TEXT
);

CREATE TRIGGER releases_updated_at
    BEFORE UPDATE ON releases
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TABLE release_ids (
    id              SERIAL      PRIMARY KEY,
    release_id      UUID        REFERENCES releases(id),
    discogs_id      TEXT        UNIQUE,
    musicbrainz_id  TEXT        UNIQUE,
    created_at      TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX ON release_ids (release_id);

CREATE TABLE release_claims (
    release_id  UUID        PRIMARY KEY REFERENCES releases(id),
    reviewer    TEXT        NOT NULL,
    claimed_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX ON release_claims (claimed_at);

CREATE TABLE reviews_history (
    id                            SERIAL PRIMARY KEY,
    release_id                    UUID NOT NULL REFERENCES releases(id),
    reviewed_at                   TIMESTAMP,
    decision                      TEXT,
    model_alt_text                TEXT,
    model_confidence              DOUBLE PRECISION,
    model_confidence_explanation  TEXT,
    model_review_triggers         JSONB,
    final_alt_text                TEXT,
    final_confidence              DOUBLE PRECISION,
    final_confidence_explanation  TEXT,
    final_review_triggers         JSONB,
    CONSTRAINT reviews_history_decision_valid
        CHECK (decision IN ('confirm', 'deny'))
);

CREATE INDEX ON reviews_history (release_id);

-- release_claims intentionally ships empty -- no seed file for it.

\copy review_trigger_definitions FROM 'migrations/seeds/review_trigger_definitions.csv' WITH (FORMAT csv, HEADER true)
\copy releases FROM 'migrations/seeds/releases.csv' WITH (FORMAT csv, HEADER true)
\copy release_ids FROM 'migrations/seeds/release_ids.csv' WITH (FORMAT csv, HEADER true)
\copy reviews_history FROM 'migrations/seeds/reviews_history.csv' WITH (FORMAT csv, HEADER true)

-- The CSVs carry explicit ids for release_ids/reviews_history, which
-- doesn't advance their SERIAL sequences -- fix that up so future inserts
-- don't collide.
SELECT setval(pg_get_serial_sequence('release_ids', 'id'), COALESCE((SELECT MAX(id) FROM release_ids), 1));
SELECT setval(pg_get_serial_sequence('reviews_history', 'id'), COALESCE((SELECT MAX(id) FROM reviews_history), 1));

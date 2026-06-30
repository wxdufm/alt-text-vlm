CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE releases (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    artist          TEXT          NOT NULL,
    title           TEXT          NOT NULL,
    cover_hash      bit(64)       UNIQUE,
    cover_url       TEXT,
    alt_text        TEXT,
    confidence      FLOAT         CHECK (confidence >= 0.0 AND confidence <= 1.0),
    review_triggers JSONB,
    needs_review    BOOLEAN       NOT NULL DEFAULT false,
    approved        BOOLEAN       NOT NULL DEFAULT false,
    created_at      TIMESTAMP     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE TABLE release_ids (
    id              SERIAL      PRIMARY KEY,
    release_id      UUID        REFERENCES releases(id),
    wxdu_release_id TEXT        UNIQUE,
    discogs_id      TEXT        UNIQUE,
    musicbrainz_id  TEXT        UNIQUE,
    created_at      TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE TABLE release_reviews (
    id              SERIAL      PRIMARY KEY,
    release_id      UUID        NOT NULL REFERENCES releases(id),
    reviewed        BOOLEAN     NOT NULL DEFAULT false,
    approved        BOOLEAN     NOT NULL DEFAULT false,
    notes           TEXT,
    reviewed_by     TEXT,
    reviewed_at     TIMESTAMP,
    CONSTRAINT approved_requires_reviewed
        CHECK (approved = false OR reviewed = true)
);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER releases_updated_at
    BEFORE UPDATE ON releases
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE INDEX ON release_ids (release_id);
CREATE INDEX ON release_reviews (release_id);

CREATE TABLE IF NOT EXISTS release_claims (
    release_id  UUID        PRIMARY KEY REFERENCES releases(id),
    reviewer    TEXT        NOT NULL,
    claimed_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS release_claims_claimed_at_idx
    ON release_claims (claimed_at);

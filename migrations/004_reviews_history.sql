DO $$
BEGIN
    IF to_regclass('public.reviews_history') IS NULL THEN
        IF to_regclass('public.release_reviews') IS NOT NULL THEN
            ALTER TABLE release_reviews RENAME TO reviews_history;
        ELSE
            CREATE TABLE reviews_history (
                id                            SERIAL PRIMARY KEY,
                release_id                    UUID NOT NULL REFERENCES releases(id),
                reviewed_at                   TIMESTAMP NOT NULL DEFAULT NOW(),
                decision                      TEXT NOT NULL,
                model_alt_text                TEXT,
                model_confidence              DOUBLE PRECISION,
                model_confidence_explanation  TEXT,
                model_review_triggers         JSONB,
                final_alt_text                TEXT,
                final_confidence              DOUBLE PRECISION,
                final_confidence_explanation  TEXT,
                final_review_triggers         JSONB,
                changed_fields                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
                CONSTRAINT reviews_history_decision_valid
                    CHECK (decision IN ('confirm', 'deny')),
                CONSTRAINT reviews_history_changed_fields_valid
                    CHECK (
                        changed_fields <@ ARRAY[
                            'alt_text',
                            'confidence',
                            'confidence_explanation',
                            'review_triggers'
                        ]::TEXT[]
                    )
            );
        END IF;
    END IF;
END $$;

ALTER TABLE reviews_history
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS decision TEXT,
    ADD COLUMN IF NOT EXISTS model_alt_text TEXT,
    ADD COLUMN IF NOT EXISTS model_confidence DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS model_confidence_explanation TEXT,
    ADD COLUMN IF NOT EXISTS model_review_triggers JSONB,
    ADD COLUMN IF NOT EXISTS final_alt_text TEXT,
    ADD COLUMN IF NOT EXISTS final_confidence DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS final_confidence_explanation TEXT,
    ADD COLUMN IF NOT EXISTS final_review_triggers JSONB,
    ADD COLUMN IF NOT EXISTS changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE reviews_history
SET reviewed_at = COALESCE(reviewed_at, NOW());

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'reviews_history'
          AND column_name = 'approved'
    ) THEN
        EXECUTE $sql$
            UPDATE reviews_history
            SET decision = CASE
                WHEN decision IS NOT NULL THEN decision
                WHEN approved = true THEN 'confirm'
                ELSE 'deny'
            END
            WHERE decision IS NULL
        $sql$;
    ELSE
        UPDATE reviews_history
        SET decision = COALESCE(decision, 'confirm')
        WHERE decision IS NULL;
    END IF;
END $$;

UPDATE reviews_history
SET changed_fields = CASE
    WHEN changed_fields IS NULL THEN ARRAY[]::TEXT[]
    ELSE changed_fields
END;

ALTER TABLE reviews_history
    ALTER COLUMN reviewed_at SET NOT NULL,
    ALTER COLUMN decision SET NOT NULL,
    ALTER COLUMN changed_fields SET NOT NULL;

ALTER TABLE reviews_history
    DROP CONSTRAINT IF EXISTS approved_requires_reviewed;

ALTER TABLE reviews_history
    DROP CONSTRAINT IF EXISTS reviews_history_decision_valid,
    ADD CONSTRAINT reviews_history_decision_valid
        CHECK (decision IN ('confirm', 'deny'));

ALTER TABLE reviews_history
    DROP CONSTRAINT IF EXISTS reviews_history_changed_fields_valid,
    ADD CONSTRAINT reviews_history_changed_fields_valid
        CHECK (
            changed_fields <@ ARRAY[
                'alt_text',
                'confidence',
                'confidence_explanation',
                'review_triggers'
            ]::TEXT[]
        );

DROP INDEX IF EXISTS release_reviews_release_id_idx;
CREATE INDEX IF NOT EXISTS reviews_history_release_id_idx
    ON reviews_history (release_id);

ALTER TABLE reviews_history
    DROP COLUMN IF EXISTS reviewed,
    DROP COLUMN IF EXISTS approved,
    DROP COLUMN IF EXISTS notes,
    DROP COLUMN IF EXISTS reviewed_by;

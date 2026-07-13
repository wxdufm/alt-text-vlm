-- Builds edited_confidence_explanation, a standardized copy of reviews_history.
-- reviews_history.model_confidence_explanation is human-written and inconsistent,
-- so this backfills a cleaner confidence/explanation/trigger set without touching
-- reviews_history or releases. Run from the repo root (the \copy path is relative
-- to the psql client's cwd, not this file):
--   psql "$PG_URI" -f migrations/007_edited_confidence_explanation.sql

-- Sanity-check the row counts this migration was written against, so it fails
-- loudly instead of silently mis-applying rule 1 / rule 3 if the data has moved.
DO $$
DECLARE
  cnt integer;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM reviews_history
  WHERE model_confidence = 0 AND final_confidence = 1
    AND model_confidence_explanation IS NOT NULL
    AND (final_confidence_explanation IS NOT NULL OR final_review_triggers IS NOT NULL);
  IF cnt <> 2 THEN
    RAISE EXCEPTION 'Expected exactly 2 rows for rule 1, found %', cnt;
  END IF;

  SELECT COUNT(*) INTO cnt
  FROM reviews_history
  WHERE model_confidence = 0 AND model_confidence_explanation IS NULL AND final_confidence = 1;
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 row for rule 3, found %', cnt;
  END IF;
END $$;

DROP TABLE IF EXISTS edited_confidence_explanation;

CREATE TABLE edited_confidence_explanation AS
SELECT *, NULL::text AS edit_rule_applied
FROM reviews_history;

ALTER TABLE edited_confidence_explanation ADD PRIMARY KEY (id);

-- Rule 1: model flagged low confidence (0) with an explanation, human overrode to
-- confident (1) but left review data behind. Trust the model: copy its explanation
-- over, union in its triggers, and flip final_confidence back to 0.
UPDATE edited_confidence_explanation
SET final_confidence = 0,
    final_confidence_explanation = model_confidence_explanation,
    final_review_triggers = (
      SELECT jsonb_agg(DISTINCT t)
      FROM jsonb_array_elements_text(
        COALESCE(final_review_triggers, '[]'::jsonb) || COALESCE(model_review_triggers, '[]'::jsonb)
      ) AS t
    ),
    edit_rule_applied = 'rule1'
WHERE model_confidence = 0 AND final_confidence = 1
  AND model_confidence_explanation IS NOT NULL
  AND (final_confidence_explanation IS NOT NULL OR final_review_triggers IS NOT NULL);

-- Rule 2: same override situation, but the human left no explanation/triggers at
-- all -- read as a deliberate "the model should be confident here". No data
-- change, just tag it so it's distinguishable from rows no rule ever touched.
UPDATE edited_confidence_explanation
SET edit_rule_applied = 'rule2_reviewed_no_change'
WHERE model_confidence = 0 AND final_confidence = 1
  AND model_confidence_explanation IS NOT NULL
  AND final_confidence_explanation IS NULL
  AND final_review_triggers IS NULL;

-- Rule 3: model said low confidence but gave no explanation, and the human was
-- confident. Treat the missing explanation as the model having nothing to flag.
UPDATE edited_confidence_explanation
SET model_confidence = 1,
    edit_rule_applied = 'rule3'
WHERE model_confidence = 0
  AND model_confidence_explanation IS NULL
  AND final_confidence = 1;

-- Rule 4: human flagged low confidence (0) but the model was confident (1), so
-- there's no model explanation to draw from. The seed CSV holds a new
-- explanation + triggers for each such row, hand-written by inspecting the
-- actual cover image in data/covers/{release_id}.{ext}.
CREATE TEMP TABLE rule4_seed (
  id integer,
  final_confidence_explanation text,
  review_triggers_to_add jsonb
);

\copy rule4_seed FROM 'migrations/seeds/007_rule4_confidence_explanations.csv' WITH (FORMAT csv, HEADER true)

UPDATE edited_confidence_explanation e
SET final_confidence_explanation = s.final_confidence_explanation,
    final_review_triggers = (
      SELECT jsonb_agg(DISTINCT t)
      FROM jsonb_array_elements_text(
        COALESCE(e.final_review_triggers, '[]'::jsonb) || s.review_triggers_to_add
      ) AS t
    ),
    edit_rule_applied = 'rule4'
FROM rule4_seed s
WHERE e.id = s.id;

-- Rule 4 rows with no local cover image to inspect (all confirmed to have
-- final_alt_text over 130 chars, which excluded them from the data/covers
-- export) are left untouched but tagged so they're findable later.
UPDATE edited_confidence_explanation e
SET edit_rule_applied = 'rule4_skipped_no_image'
WHERE e.final_confidence = 0 AND e.model_confidence = 1
  AND e.edit_rule_applied IS NULL;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT COALESCE(edit_rule_applied, '(untouched)') AS bucket, COUNT(*) AS cnt
    FROM edited_confidence_explanation
    GROUP BY 1
    ORDER BY 1
  LOOP
    RAISE NOTICE '%: %', r.bucket, r.cnt;
  END LOOP;
END $$;

INSERT INTO review_trigger_definitions (trigger, trigger_description)
VALUES (
    'ambiguous main visual element',
    'One or more important visual elements cannot be confidently identified or could reasonably be interpreted in multiple ways, making a precise description uncertain.'
)
ON CONFLICT (trigger) DO UPDATE
SET
    trigger_description = EXCLUDED.trigger_description,
    updated_at = NOW();

CREATE OR REPLACE FUNCTION remap_review_triggers(input_value JSONB)
RETURNS JSONB AS $$
DECLARE
    result JSONB;
BEGIN
    IF input_value IS NULL THEN
        RETURN NULL;
    END IF;

    IF jsonb_typeof(input_value) <> 'array' THEN
        RETURN input_value;
    END IF;

    WITH mapped AS (
        SELECT
            CASE value
                WHEN 'ambiguous visual element' THEN 'ambiguous main visual element'
                WHEN 'factual visual error' THEN 'ambiguous main visual element'
                WHEN 'unclear main subject' THEN 'ambiguous main visual element'
                WHEN 'lacking details or not focusing on the most important details' THEN 'unclear visual focus'
                WHEN 'style guide review required' THEN NULL
                WHEN 'unnecessary complex language' THEN NULL
                ELSE value
            END AS trigger,
            ord
        FROM jsonb_array_elements_text(input_value) WITH ORDINALITY AS trigger_values(value, ord)
    ),
    deduped AS (
        SELECT DISTINCT ON (trigger)
            trigger,
            ord
        FROM mapped
        WHERE trigger IS NOT NULL
        ORDER BY trigger, ord
    ),
    ordered AS (
        SELECT trigger, ord
        FROM deduped
        ORDER BY ord
    )
    SELECT CASE
        WHEN COUNT(*) = 0 THEN NULL
        ELSE jsonb_agg(trigger ORDER BY ord)
    END
    INTO result
    FROM ordered;

    RETURN result;
END;
$$ LANGUAGE plpgsql;

UPDATE releases
SET review_triggers = remap_review_triggers(review_triggers)
WHERE review_triggers IS NOT NULL;

UPDATE reviews_history
SET model_review_triggers = remap_review_triggers(model_review_triggers)
WHERE model_review_triggers IS NOT NULL;

UPDATE reviews_history
SET final_review_triggers = remap_review_triggers(final_review_triggers)
WHERE final_review_triggers IS NOT NULL;

DELETE FROM review_trigger_definitions
WHERE trigger IN (
    'ambiguous visual element',
    'factual visual error',
    'lacking details or not focusing on the most important details',
    'style guide review required',
    'unnecessary complex language',
    'unclear main subject'
);

DROP FUNCTION remap_review_triggers(JSONB);

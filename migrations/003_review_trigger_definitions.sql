CREATE TABLE IF NOT EXISTS review_trigger_definitions (
    trigger             TEXT PRIMARY KEY,
    trigger_description TEXT NOT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT review_trigger_definitions_trigger_normalized
        CHECK (trigger = lower(btrim(trigger)) AND btrim(trigger) <> ''),
    CONSTRAINT review_trigger_definitions_description_present
        CHECK (btrim(trigger_description) <> '')
);

DROP TRIGGER IF EXISTS review_trigger_definitions_updated_at
    ON review_trigger_definitions;

CREATE TRIGGER review_trigger_definitions_updated_at
    BEFORE UPDATE ON review_trigger_definitions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

INSERT INTO review_trigger_definitions (trigger, trigger_description)
VALUES
    (
        'bad image quality',
        'The image is too low in quality (e.g., blurry, pixelated, grainy, noisy, or poorly lit) to confidently identify important visual details.'
    ),
    (
        'cannot read text confidently',
        'Visible text is partially obscured, too small, distorted, or otherwise unreadable, making it impossible to transcribe or describe with confidence.'
    ),
    (
        'unclear main subject',
        'The primary subject or focus of the artwork cannot be identified with confidence because it is visually unclear, obscured, or multiple subjects appear equally plausible.'
    ),
    (
        'ambiguous visual element',
        'One or more visual elements could reasonably be interpreted in multiple ways, making a precise description uncertain.'
    ),
    (
        'possible person misidentification',
        'The image may contain one or more people, but their identity, appearance, or even whether they are people cannot be determined with confidence.'
    ),
    (
        'highly abstract artwork',
        'The artwork is primarily abstract or non-representational, making it difficult to identify concrete subjects beyond colors, shapes, textures, or composition.'
    ),
    (
        'complex image with mixed media',
        'The artwork combines multiple artistic media or overlapping visual elements (e.g., photography, collage, painting, illustration, typography) that make accurate description difficult.'
    ),
    (
        'possible symbolic interpretation',
        'The artwork may contain symbolic or metaphorical imagery whose meaning cannot be described confidently from visible content alone.'
    ),
    (
        'cultural or historical reference needed',
        'The artwork appears to contain cultural, historical, political, or religious references that may require additional context or human expertise to describe accurately.'
    ),
    (
        'sensitive or indecent content',
        'The artwork contains or may contain sensitive content such as nudity, violence, self-harm, hate symbols, or other imagery that requires careful human review.'
    ),
    (
        'factual visual error',
        'The generated description contains a likely factual mistake or misidentifies a visible visual element, despite the image being sufficiently clear.'
    ),
    (
        'style guide review required',
        'The generated description may not fully comply with the project''s accessibility or editorial style guide and should be reviewed by a human.'
    )
ON CONFLICT (trigger) DO NOTHING;

ALTER TABLE releases
    ADD COLUMN IF NOT EXISTS confidence_explanation TEXT;

WITH rows_to_migrate AS (
    SELECT r.id
    FROM releases r
    WHERE r.review_triggers IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(r.review_triggers) AS trigger_value
          LEFT JOIN review_trigger_definitions d
            ON d.trigger = lower(btrim(trigger_value))
          WHERE d.trigger IS NULL
      )
)
UPDATE releases r
SET confidence_explanation = CASE
        WHEN jsonb_typeof(r.review_triggers) = 'array' THEN (
            SELECT string_agg(trigger_value, E'\n')
            FROM jsonb_array_elements_text(r.review_triggers) AS trigger_value
        )
        WHEN jsonb_typeof(r.review_triggers) = 'string' THEN
            trim(both '"' FROM r.review_triggers::text)
        ELSE r.review_triggers::text
    END
WHERE r.id IN (SELECT id FROM rows_to_migrate)
  AND r.confidence_explanation IS NULL;

WITH rows_to_migrate AS (
    SELECT r.id
    FROM releases r
    WHERE r.review_triggers IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(r.review_triggers) AS trigger_value
          LEFT JOIN review_trigger_definitions d
            ON d.trigger = lower(btrim(trigger_value))
          WHERE d.trigger IS NULL
      )
)
UPDATE releases r
SET review_triggers = NULL
WHERE r.id IN (SELECT id FROM rows_to_migrate);

UPDATE releases
SET review_triggers = CASE id
    WHEN 'ec98f0b2-ba80-46b9-a2d3-6bede707a5ef'::uuid THEN '["bad image quality","cannot read text confidently"]'::jsonb
    WHEN 'e90cd860-1f9d-4aa0-8329-ab35c79bb40e'::uuid THEN '["bad image quality","cannot read text confidently"]'::jsonb
    WHEN 'c4dad2bf-f70d-4118-8a21-e8f6709300e4'::uuid THEN '["bad image quality","ambiguous visual element"]'::jsonb
    WHEN '27edc832-32eb-40ab-97d7-73684f19c96d'::uuid THEN '["bad image quality","possible person misidentification"]'::jsonb
    WHEN '9b5082f9-a5c7-41b3-9c41-b24727f3e4f9'::uuid THEN '["ambiguous visual element","cannot read text confidently"]'::jsonb
    WHEN '0098c9fe-0723-4ca2-920d-41b4fb770583'::uuid THEN '["bad image quality","possible person misidentification"]'::jsonb
    WHEN '33fde2dd-5f91-49ac-ae6b-f0257c9a7c34'::uuid THEN '["bad image quality","ambiguous visual element"]'::jsonb
    WHEN 'e1a8fef5-aa84-4937-a0b6-3f60f4832e19'::uuid THEN '["bad image quality","possible person misidentification"]'::jsonb
    WHEN '966d2293-4234-43b9-b4db-880c9f1a45ec'::uuid THEN '["bad image quality","unclear main subject","highly abstract artwork"]'::jsonb
    WHEN 'ceabc3a4-ddfc-4218-ab7d-2175c934eb65'::uuid THEN '["bad image quality","ambiguous visual element"]'::jsonb
    WHEN '80dffefe-da4c-45e5-a659-7196ffe84034'::uuid THEN '["highly abstract artwork"]'::jsonb
    WHEN '9547db3d-62c5-4ab1-af74-fdd29913190f'::uuid THEN '["bad image quality","ambiguous visual element"]'::jsonb
    WHEN '0204a518-a45f-4958-b57f-93deef1a87cb'::uuid THEN '["bad image quality","ambiguous visual element"]'::jsonb
    WHEN 'c7608eac-2b77-410c-9195-c38c2d2c83ef'::uuid THEN '["bad image quality","ambiguous visual element"]'::jsonb
    WHEN '811d1be7-c9ef-4325-b101-f2c5dd8737b6'::uuid THEN '["bad image quality","cannot read text confidently"]'::jsonb
    WHEN 'cfb006e7-7f42-47b1-97aa-603fedf17b60'::uuid THEN '["bad image quality","ambiguous visual element"]'::jsonb
    WHEN 'e10f6908-a275-4d08-a50a-2848c7c2c5cc'::uuid THEN '["bad image quality","unclear main subject","cannot read text confidently"]'::jsonb
    WHEN 'e727e59b-64fc-4e48-ae76-e25bd6cf13cf'::uuid THEN '["bad image quality","possible person misidentification"]'::jsonb
    WHEN '5ae1f655-c0f1-4620-ac91-f0f2b1cfc934'::uuid THEN '["bad image quality","cannot read text confidently","ambiguous visual element"]'::jsonb
    WHEN 'f8bbae93-ab86-43e8-8b73-848899322ffb'::uuid THEN '["bad image quality","cannot read text confidently"]'::jsonb
    WHEN '14693352-4fa6-476f-9d68-9da91c6867e4'::uuid THEN '["bad image quality","unclear main subject"]'::jsonb
    WHEN '75b8201c-96e0-4e48-a23d-89854c1d6135'::uuid THEN '["bad image quality","highly abstract artwork","ambiguous visual element"]'::jsonb
    WHEN '4e70fd51-cb40-4ad9-b855-7be339411f51'::uuid THEN '["bad image quality","ambiguous visual element"]'::jsonb
    WHEN '12f0aeab-7fd9-45b2-b051-d9a8d3d2c972'::uuid THEN '["bad image quality","highly abstract artwork"]'::jsonb
    WHEN 'dc05b652-2bee-4a63-96b3-a8a600922360'::uuid THEN '["bad image quality"]'::jsonb
    WHEN 'a7946603-ecb4-4d29-bbb7-ff24b6923a58'::uuid THEN '["bad image quality","unclear main subject","ambiguous visual element"]'::jsonb
    WHEN '56f5bc2a-08e5-4345-801a-8142ff352a3d'::uuid THEN '["bad image quality","unclear main subject"]'::jsonb
    WHEN 'a3a538d3-e8e2-4ae4-b758-66483b0e6ad5'::uuid THEN '["bad image quality","possible person misidentification"]'::jsonb
    WHEN '641b3950-0349-4a64-9dd1-7b09b546ec12'::uuid THEN '["factual visual error"]'::jsonb
    WHEN '27c75d78-8e8d-4b88-abd8-7eef898bb883'::uuid THEN '["bad image quality","cannot read text confidently"]'::jsonb
    WHEN 'fb1c2240-cf54-41d6-9e45-0dbc09ce3075'::uuid THEN '["bad image quality","unclear main subject","ambiguous visual element"]'::jsonb
    WHEN '2cb4e986-35d5-4c37-9332-99a585c4d413'::uuid THEN '["bad image quality"]'::jsonb
    WHEN '07247e9f-638b-425a-9694-ec89de65b431'::uuid THEN '["bad image quality"]'::jsonb
    WHEN 'c2128080-043f-49f4-9615-a1d03d688cb1'::uuid THEN '["bad image quality","possible person misidentification","cannot read text confidently"]'::jsonb
    ELSE review_triggers
END
WHERE id IN (
    'ec98f0b2-ba80-46b9-a2d3-6bede707a5ef'::uuid,
    'e90cd860-1f9d-4aa0-8329-ab35c79bb40e'::uuid,
    'c4dad2bf-f70d-4118-8a21-e8f6709300e4'::uuid,
    '27edc832-32eb-40ab-97d7-73684f19c96d'::uuid,
    '9b5082f9-a5c7-41b3-9c41-b24727f3e4f9'::uuid,
    '0098c9fe-0723-4ca2-920d-41b4fb770583'::uuid,
    '33fde2dd-5f91-49ac-ae6b-f0257c9a7c34'::uuid,
    'e1a8fef5-aa84-4937-a0b6-3f60f4832e19'::uuid,
    '966d2293-4234-43b9-b4db-880c9f1a45ec'::uuid,
    'ceabc3a4-ddfc-4218-ab7d-2175c934eb65'::uuid,
    '80dffefe-da4c-45e5-a659-7196ffe84034'::uuid,
    '9547db3d-62c5-4ab1-af74-fdd29913190f'::uuid,
    '0204a518-a45f-4958-b57f-93deef1a87cb'::uuid,
    'c7608eac-2b77-410c-9195-c38c2d2c83ef'::uuid,
    '811d1be7-c9ef-4325-b101-f2c5dd8737b6'::uuid,
    'cfb006e7-7f42-47b1-97aa-603fedf17b60'::uuid,
    'e10f6908-a275-4d08-a50a-2848c7c2c5cc'::uuid,
    'e727e59b-64fc-4e48-ae76-e25bd6cf13cf'::uuid,
    '5ae1f655-c0f1-4620-ac91-f0f2b1cfc934'::uuid,
    'f8bbae93-ab86-43e8-8b73-848899322ffb'::uuid,
    '14693352-4fa6-476f-9d68-9da91c6867e4'::uuid,
    '75b8201c-96e0-4e48-a23d-89854c1d6135'::uuid,
    '4e70fd51-cb40-4ad9-b855-7be339411f51'::uuid,
    '12f0aeab-7fd9-45b2-b051-d9a8d3d2c972'::uuid,
    'dc05b652-2bee-4a63-96b3-a8a600922360'::uuid,
    'a7946603-ecb4-4d29-bbb7-ff24b6923a58'::uuid,
    '56f5bc2a-08e5-4345-801a-8142ff352a3d'::uuid,
    'a3a538d3-e8e2-4ae4-b758-66483b0e6ad5'::uuid,
    '641b3950-0349-4a64-9dd1-7b09b546ec12'::uuid,
    '27c75d78-8e8d-4b88-abd8-7eef898bb883'::uuid,
    'fb1c2240-cf54-41d6-9e45-0dbc09ce3075'::uuid,
    '2cb4e986-35d5-4c37-9332-99a585c4d413'::uuid,
    '07247e9f-638b-425a-9694-ec89de65b431'::uuid,
    'c2128080-043f-49f4-9615-a1d03d688cb1'::uuid
);

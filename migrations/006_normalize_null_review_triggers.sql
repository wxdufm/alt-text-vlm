-- server.js used to build jsonb parameters with JSON.stringify(value ?? null),
-- and JSON.stringify(null) is the string "null" -- cast to ::jsonb that stores
-- a JSON null value instead of a real SQL NULL. Normalize existing rows.

UPDATE releases
SET review_triggers = NULL
WHERE review_triggers = 'null';

UPDATE reviews_history
SET model_review_triggers = NULL
WHERE model_review_triggers = 'null';

UPDATE reviews_history
SET final_review_triggers = NULL
WHERE final_review_triggers = 'null';

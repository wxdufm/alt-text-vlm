import dotenv from "dotenv";
import express from "express";
import { getPostgresPool } from "./lib/postgres.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const CLAIM_TIMEOUT_MINUTES = 30;
const ALT_TEXT_MAX_LENGTH = 130;
const CLAIM_EXPIRATION_SQL = `NOW() - make_interval(mins => ${CLAIM_TIMEOUT_MINUTES})`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let reviewsHistoryTableAvailable = null;

app.use(express.static("public"));
app.use(express.json());

async function hasReviewsHistoryTable(client = null) {
  if (reviewsHistoryTableAvailable !== null) {
    return reviewsHistoryTableAvailable;
  }

  const db = client || getPostgresPool();
  const result = await db.query(
    "SELECT to_regclass('public.reviews_history') AS table_name"
  );

  reviewsHistoryTableAvailable = Boolean(result.rows[0]?.table_name);
  return reviewsHistoryTableAvailable;
}

function normalizeReviewer(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, 120);
}

function requireReviewer(req, res) {
  const reviewer = normalizeReviewer(req.body?.reviewer);

  if (reviewer) {
    return reviewer;
  }

  res.status(400).json({
    error: "reviewer is required"
  });

  return null;
}

function normalizeCorrectedConfidence(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || ![0, 1].includes(numericValue)) {
    throw new Error("correctedConfidence must be 0 or 1");
  }

  return numericValue;
}

function normalizeOptionalText(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function normalizeCorrectedAltText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, ALT_TEXT_MAX_LENGTH);
}

function normalizeTriggerName(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function getReviewTriggerDefinitions(client) {
  const result = await client.query(
    `
      SELECT trigger, trigger_description
      FROM review_trigger_definitions
      ORDER BY trigger
    `
  );

  return result.rows;
}

function normalizeCorrectedReviewTriggers(value, allowedTriggers) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw new Error("correctedReviewTriggers must be an array of strings");
  }

  const normalized = [];
  const seen = new Set();

  for (const item of value) {
    const trigger = normalizeTriggerName(item);

    if (!trigger || seen.has(trigger)) {
      continue;
    }

    if (!allowedTriggers.has(trigger)) {
      throw new Error(`Unknown review trigger: ${trigger}`);
    }

    seen.add(trigger);
    normalized.push(trigger);
  }

  return normalized.length > 0 ? normalized : null;
}

function normalizeTriggerDefinitionInput(trigger, triggerDescription) {
  const normalizedTrigger = normalizeTriggerName(trigger);

  if (!normalizedTrigger) {
    throw new Error("trigger is required");
  }

  const normalizedDescription = normalizeOptionalText(
    triggerDescription,
    "triggerDescription"
  );

  if (!normalizedDescription) {
    throw new Error("triggerDescription is required");
  }

  return {
    trigger: normalizedTrigger,
    triggerDescription: normalizedDescription
  };
}

function triggersEqual(left, right) {
  const leftNormalized = Array.isArray(left)
    ? left.map(String).filter(Boolean)
    : [];
  const rightNormalized = Array.isArray(right)
    ? right.map(String).filter(Boolean)
    : [];

  if (leftNormalized.length !== rightNormalized.length) {
    return false;
  }

  return leftNormalized.every((value, index) => value === rightNormalized[index]);
}

function buildChangedFields(modelRelease, finalRelease) {
  const changedFields = [];

  if ((modelRelease.alt_text ?? null) !== (finalRelease.alt_text ?? null)) {
    changedFields.push("alt_text");
  }

  if ((modelRelease.confidence ?? null) !== (finalRelease.confidence ?? null)) {
    changedFields.push("confidence");
  }

  if (
    (modelRelease.confidence_explanation ?? null) !==
    (finalRelease.confidence_explanation ?? null)
  ) {
    changedFields.push("confidence_explanation");
  }

  if (
    !triggersEqual(
      modelRelease.review_triggers,
      finalRelease.review_triggers
    )
  ) {
    changedFields.push("review_triggers");
  }

  return changedFields;
}

const eligibleReleaseClause = `
  r.cover_url IS NOT NULL
  AND btrim(r.cover_url) <> ''
  AND r.alt_text IS NOT NULL
  AND btrim(r.alt_text) <> ''
  AND r.approved = false
`;

const releaseSelectColumns = `
  r.id,
  r.artist,
  r.title,
  r.cover_url,
  r.alt_text,
  r.confidence,
  r.confidence_explanation,
  r.review_triggers,
  r.needs_review,
  r.approved
`;

const releaseReturningColumns = `
  id,
  artist,
  title,
  cover_url,
  alt_text,
  confidence,
  confidence_explanation,
  review_triggers,
  needs_review,
  approved
`;

async function getPendingStats(db) {
  const stats = await db.query(
    `
      SELECT
        COUNT(*)::int AS "totalReleases",
        COUNT(*) FILTER (
          WHERE r.cover_url IS NOT NULL
            AND btrim(r.cover_url) <> ''
        )::int AS "releasesWithCoverUrl",
        COUNT(*) FILTER (
          WHERE r.alt_text IS NOT NULL
            AND btrim(r.alt_text) <> ''
        )::int AS "releasesWithAltText",
        COUNT(*) FILTER (
          WHERE ${eligibleReleaseClause}
        )::int AS "pendingReleases",
        COUNT(*) FILTER (
          WHERE c.release_id IS NOT NULL
            AND c.claimed_at >= ${CLAIM_EXPIRATION_SQL}
        )::int AS "activeClaims"
      FROM releases r
      LEFT JOIN release_claims c ON c.release_id = r.id
    `
  );

  return stats.rows[0];
}

async function getReviewCoverageStats(db) {
  const result = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE approved = true)::int AS "humanReviewedCount",
        COUNT(*)::int AS "totalCoversCount"
      FROM releases
    `
  );

  return {
    humanReviewedCount: result.rows[0]?.humanReviewedCount ?? 0,
    totalCoversCount: result.rows[0]?.totalCoversCount ?? 0
  };
}

app.get("/api/release", async (req, res) => {
  res.status(410).json({
    error: "Use POST /api/releases/claim with a reviewer name."
  });
});

app.get("/api/stats", async (req, res) => {
  try {
    const stats = await getReviewCoverageStats(getPostgresPool());
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load stats",
      detail: err.message
    });
  }
});

app.get("/api/review-trigger-definitions", async (req, res) => {
  try {
    const definitions = await getReviewTriggerDefinitions(getPostgresPool());
    res.json({ definitions });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load review trigger definitions",
      detail: err.message
    });
  }
});

app.post("/api/review-trigger-definitions", async (req, res) => {
  let normalized;

  try {
    normalized = normalizeTriggerDefinitionInput(
      req.body?.trigger,
      req.body?.triggerDescription
    );
  } catch (err) {
    return res.status(400).json({
      error: err.message
    });
  }

  try {
    const result = await getPostgresPool().query(
      `
        INSERT INTO review_trigger_definitions (trigger, trigger_description)
        VALUES ($1, $2)
        ON CONFLICT (trigger) DO NOTHING
        RETURNING trigger, trigger_description
      `,
      [normalized.trigger, normalized.triggerDescription]
    );

    if (!result.rows[0]) {
      return res.status(409).json({
        error: "Trigger already exists"
      });
    }

    res.status(201).json({
      definition: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to create review trigger definition",
      detail: err.message
    });
  }
});

app.post("/api/releases/claim", async (req, res) => {
  const reviewer = requireReviewer(req, res);
  const rawExcludeReleaseIds = Array.isArray(req.body?.excludeReleaseIds)
    ? req.body.excludeReleaseIds
    : req.body?.excludeReleaseId
      ? [req.body.excludeReleaseId]
      : [];
  const excludeReleaseIds = rawExcludeReleaseIds.filter(
    (value) => value !== null && value !== undefined && value !== ""
  );

  if (!reviewer) {
    return;
  }

  if (!excludeReleaseIds.every((value) => UUID_PATTERN.test(value))) {
    return res.status(400).json({
      error: "Invalid excludeReleaseIds"
    });
  }

  let client;

  try {
    const pool = getPostgresPool();
    client = await pool.connect();
    await client.query("BEGIN");

    const existingClaim = await client.query(
      `
        SELECT ${releaseSelectColumns}
        FROM release_claims c
        JOIN releases r ON r.id = c.release_id
        WHERE c.reviewer = $1
          AND ($2::uuid[] IS NULL OR NOT (c.release_id = ANY($2::uuid[])))
          AND c.claimed_at >= ${CLAIM_EXPIRATION_SQL}
          AND ${eligibleReleaseClause}
        ORDER BY c.claimed_at DESC
        LIMIT 1
      `,
      [reviewer, excludeReleaseIds.length > 0 ? excludeReleaseIds : null]
    );

    if (existingClaim.rows[0]) {
      await client.query("COMMIT");

      return res.json({
        reviewer,
        claimTimeoutMinutes: CLAIM_TIMEOUT_MINUTES,
        ...(await getReviewCoverageStats(client)),
        release: existingClaim.rows[0]
      });
    }

    const result = await client.query(
      `
        WITH next_release AS (
          SELECT r.id
          FROM releases r
          LEFT JOIN release_claims c ON c.release_id = r.id
          WHERE ${eligibleReleaseClause}
            AND ($2::uuid[] IS NULL OR NOT (r.id = ANY($2::uuid[])))
            AND (
              c.release_id IS NULL
              OR c.claimed_at < ${CLAIM_EXPIRATION_SQL}
            )
          ORDER BY random()
          FOR UPDATE OF r SKIP LOCKED
          LIMIT 1
        ),
        claimed AS (
          INSERT INTO release_claims (release_id, reviewer, claimed_at)
          SELECT id, $1, NOW()
          FROM next_release
          ON CONFLICT (release_id) DO UPDATE
          SET reviewer = EXCLUDED.reviewer,
              claimed_at = EXCLUDED.claimed_at
          WHERE release_claims.claimed_at < ${CLAIM_EXPIRATION_SQL}
          RETURNING release_id
        )
        SELECT ${releaseSelectColumns}
        FROM releases r
        JOIN claimed c ON c.release_id = r.id
      `,
      [reviewer, excludeReleaseIds.length > 0 ? excludeReleaseIds : null]
    );

    const release = result.rows[0];

    if (!release) {
      const stats = await getPendingStats(client);
      await client.query("COMMIT");

      return res.status(404).json({
        error: "No claimable release found with cover_url and alt_text",
        table: "releases",
        claimTimeoutMinutes: CLAIM_TIMEOUT_MINUTES,
        ...stats
      });
    }

    await client.query("COMMIT");

    res.json({
      reviewer,
      claimTimeoutMinutes: CLAIM_TIMEOUT_MINUTES,
      ...(await getReviewCoverageStats(client)),
      release
    });
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error(err);
    res.status(500).json({
      error: "Failed to claim release",
      detail: err.message
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

app.post("/api/release/:id/release", async (req, res) => {
  const { id } = req.params;
  const reviewer = requireReviewer(req, res);

  if (!reviewer) {
    return;
  }

  if (!UUID_PATTERN.test(id)) {
    return res.status(400).json({
      error: "Invalid release id"
    });
  }

  let client;

  try {
    const pool = getPostgresPool();
    client = await pool.connect();
    await client.query("BEGIN");

    const currentClaim = await client.query(
      `
        SELECT reviewer
        FROM release_claims
        WHERE release_id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );

    const claim = currentClaim.rows[0];

    if (claim && claim.reviewer !== reviewer) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Release is claimed by another reviewer"
      });
    }

    const released = await client.query(
      `
        DELETE FROM release_claims
        WHERE release_id = $1::uuid
          AND reviewer = $2
        RETURNING release_id
      `,
      [id, reviewer]
    );

    await client.query("COMMIT");

    res.json({
      claimReleased: Boolean(released.rows[0]),
      releaseId: id,
      reviewer
    });
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error(err);
    res.status(500).json({
      error: "Failed to release claim",
      detail: err.message
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

app.post("/api/release/:id/review", async (req, res) => {
  const { id } = req.params;
  const reviewer = requireReviewer(req, res);

  if (!reviewer) {
    return;
  }

  const {
    approved,
    correctedAltText = "",
    correctedConfidence,
    correctedConfidenceExplanation,
    correctedReviewTriggers
  } = req.body || {};

  if (!UUID_PATTERN.test(id)) {
    return res.status(400).json({
      error: "Invalid release id"
    });
  }

  if (typeof approved !== "boolean") {
    return res.status(400).json({
      error: "approved must be a boolean"
    });
  }

  const correction = normalizeCorrectedAltText(correctedAltText);

  let normalizedConfidence;
  let normalizedConfidenceExplanation;
  let normalizedReviewTriggers;

  try {
    const triggerDefinitions = await getReviewTriggerDefinitions(
      getPostgresPool()
    );
    const allowedTriggers = new Set(
      triggerDefinitions.map((definition) => definition.trigger)
    );

    normalizedConfidence = normalizeCorrectedConfidence(correctedConfidence);
    normalizedConfidenceExplanation = normalizeOptionalText(
      correctedConfidenceExplanation,
      "correctedConfidenceExplanation"
    );
    normalizedReviewTriggers = normalizeCorrectedReviewTriggers(
      correctedReviewTriggers,
      allowedTriggers
    );
  } catch (err) {
    return res.status(400).json({
      error: err.message
    });
  }

  if (!approved && correction === "") {
    return res.status(400).json({
      error: "Corrected alt text is required when denying an AI description"
    });
  }

  let client;

  try {
    const pool = getPostgresPool();
    client = await pool.connect();
    await client.query("BEGIN");

    const reviewsHistoryAvailable = await hasReviewsHistoryTable(client);
    const releaseRow = await client.query(
      `
        SELECT
          approved,
          alt_text,
          confidence,
          confidence_explanation,
          review_triggers
        FROM releases
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );

    if (!releaseRow.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Release not found"
      });
    }

    if (releaseRow.rows[0].approved) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Release has already been reviewed"
      });
    }

    const currentClaim = await client.query(
      `
        SELECT reviewer
        FROM release_claims
        WHERE release_id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );

    const claim = currentClaim.rows[0];

    if (claim && claim.reviewer !== reviewer) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Release is claimed by another reviewer"
      });
    }

    const result = await client.query(
      `
        UPDATE releases
        SET
          approved = true,
          alt_text = CASE
            WHEN $2 THEN alt_text
            ELSE $3
          END,
          confidence = CASE
            WHEN $2 THEN confidence
            ELSE $4
          END,
          confidence_explanation = CASE
            WHEN $2 THEN confidence_explanation
            ELSE $5
          END,
          review_triggers = CASE
            WHEN $2 THEN review_triggers
            ELSE $6::jsonb
          END
        WHERE id = $1::uuid
        RETURNING
          ${releaseReturningColumns}
      `,
      [
        id,
        approved,
        correction,
        normalizedConfidence,
        normalizedConfidenceExplanation,
        normalizedReviewTriggers === undefined
          ? null
          : JSON.stringify(normalizedReviewTriggers)
      ]
    );

    const release = result.rows[0];

    if (reviewsHistoryAvailable) {
      const modelRelease = releaseRow.rows[0];
      const finalRelease = release;
      const decision = approved ? "confirm" : "deny";
      const changedFields = buildChangedFields(modelRelease, finalRelease);

      await client.query(
        `
          INSERT INTO reviews_history (
            release_id,
            reviewed_at,
            decision,
            model_alt_text,
            model_confidence,
            model_confidence_explanation,
            model_review_triggers,
            final_alt_text,
            final_confidence,
            final_confidence_explanation,
            final_review_triggers,
            changed_fields
          )
          VALUES (
            $1::uuid,
            NOW(),
            $2,
            $3,
            $4,
            $5,
            $6::jsonb,
            $7,
            $8,
            $9,
            $10::jsonb,
            $11::text[]
          )
        `,
        [
          id,
          decision,
          modelRelease.alt_text ?? null,
          modelRelease.confidence ?? null,
          modelRelease.confidence_explanation ?? null,
          JSON.stringify(modelRelease.review_triggers ?? null),
          finalRelease.alt_text ?? null,
          finalRelease.confidence ?? null,
          finalRelease.confidence_explanation ?? null,
          JSON.stringify(finalRelease.review_triggers ?? null),
          changedFields
        ]
      );
    }

    await client.query(
      `
        DELETE FROM release_claims
        WHERE release_id = $1::uuid
      `,
      [id]
    );

    await client.query("COMMIT");

    res.json({
      release,
      reviewer,
      reviewSaved: true,
      reviewHistorySaved: reviewsHistoryAvailable,
      ...(await getReviewCoverageStats(client))
    });
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error(err);
    res.status(500).json({
      error: "Failed to save review",
      detail: err.message
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(`Failed to start server on port ${PORT}: ${err.message}`);
    process.exit(1);
  }

  console.log(`Running at http://${HOST}:${PORT}`);
});

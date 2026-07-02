import dotenv from "dotenv";
import express from "express";
import { getPostgresPool } from "./lib/postgres.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const CLAIM_TIMEOUT_MINUTES = 30;
const CLAIM_EXPIRATION_SQL = `NOW() - make_interval(mins => ${CLAIM_TIMEOUT_MINUTES})`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let releaseReviewsTableAvailable = null;

app.use(express.static("public"));
app.use(express.json());

async function hasReleaseReviewsTable(client = null) {
  if (releaseReviewsTableAvailable !== null) {
    return releaseReviewsTableAvailable;
  }

  const db = client || getPostgresPool();
  const result = await db.query(
    "SELECT to_regclass('public.release_reviews') AS table_name"
  );

  releaseReviewsTableAvailable = Boolean(result.rows[0]?.table_name);
  return releaseReviewsTableAvailable;
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

app.get("/api/release", async (req, res) => {
  res.status(410).json({
    error: "Use POST /api/releases/claim with a reviewer name."
  });
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

  const { approved, correctedAltText = "" } = req.body || {};

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

  const correction =
    typeof correctedAltText === "string" ? correctedAltText.trim() : "";

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

    const releaseReviewsAvailable = await hasReleaseReviewsTable(client);
    const releaseRow = await client.query(
      `
        SELECT approved
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
          END
        WHERE id = $1::uuid
        RETURNING
          ${releaseReturningColumns}
      `,
      [id, approved, correction]
    );

    const release = result.rows[0];

    if (releaseReviewsAvailable) {
      await client.query(
        `
          INSERT INTO release_reviews (
            release_id,
            reviewed,
            approved,
            notes,
            reviewed_by,
            reviewed_at
          )
          VALUES ($1::uuid, true, true, NULLIF($2, ''), $3, NOW())
        `,
        [id, correction, reviewer]
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
      reviewHistorySaved: releaseReviewsAvailable
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

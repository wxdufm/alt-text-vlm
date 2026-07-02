import dotenv from "dotenv";
import express from "express";
import { getPostgresPool, query } from "./lib/postgres.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const app = express();
const PORT = process.env.PORT || 3000;
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

const eligibleReleaseClause = `
  r.cover_url IS NOT NULL
  AND btrim(r.cover_url) <> ''
  AND r.alt_text IS NOT NULL
  AND btrim(r.alt_text) <> ''
  AND r.approved = false
`;

app.get("/api/release", async (req, res) => {
  try {
    const result = await query(
      `
        SELECT
          r.id,
          r.artist,
          r.title,
          r.cover_url,
          r.alt_text,
          r.confidence,
          r.review_triggers,
          r.needs_review,
          r.approved
        FROM releases r
        WHERE ${eligibleReleaseClause}
        ORDER BY random()
        LIMIT 1
      `
    );

    const release = result.rows[0];

    if (!release) {
      const stats = await query(
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
            )::int AS "pendingReleases"
          FROM releases r
        `
      );

      return res.status(404).json({
        error: "No pending release found with cover_url and alt_text",
        table: "releases",
        ...stats.rows[0]
      });
    }

    res.json(release);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load release",
      detail: err.message
    });
  }
});

app.post("/api/release/:id/review", async (req, res) => {
  const { id } = req.params;
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
          id,
          artist,
          title,
          cover_url,
          alt_text,
          confidence,
          review_triggers,
          needs_review,
          approved
      `,
      [id, approved, correction]
    );

    const release = result.rows[0];

    if (!release) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Release not found"
      });
    }

    if (releaseReviewsAvailable) {
      await client.query(
        `
          INSERT INTO release_reviews (
            release_id,
            reviewed,
            approved,
            notes,
            reviewed_at
          )
          VALUES ($1::uuid, true, true, NULLIF($2, ''), NOW())
        `,
        [id, correction]
      );
    }

    await client.query("COMMIT");

    res.json({
      release,
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

app.listen(PORT, (err) => {
  if (err) {
    console.error(`Failed to start server on port ${PORT}: ${err.message}`);
    process.exit(1);
  }

  console.log(`Running at http://localhost:${PORT}`);
});

# Mac Mini Review Server Plan

## Goal

Run the album-cover alt-text review website on a Mac mini so four reviewers can
use it at the same time over Tailscale.

Reviewers should only need:

- Tailscale installed and signed into the approved tailnet.
- A web browser.
- A reviewer name, or later a real authenticated identity.

They should not need a local database, a local copy of this repo, or Docker.

## Current Repo State

The current app is:

- Backend: Node.js + Express in `server.js`.
- Frontend: plain HTML/CSS/JavaScript in `public/`.
- Database driver: `pg`, configured by `PG_URI` or `DATABASE_URL`.
- Current queue rule: rows in `releases` where `approved = false`.
- Current approval behavior: `POST /api/release/:id/review` sets
  `approved = true`.
- Current correction behavior: if the reviewer denies the AI description, they
  must submit corrected alt text; the backend replaces `releases.alt_text` with
  that corrected text and sets `approved = true`.
- Current review UI shows `cover_url`, `alt_text`, `confidence`, and
  `review_triggers`.

The current local Docker setup under `sqldocker/` can run Postgres and import
`releases_dump.sql`. For the Mac mini, the same pattern is useful for initial
setup, but the Mac mini should eventually use the real production review
database, not a disposable local dump.

## Important Gap Before Four Reviewers

The current app is not yet safe for simultaneous reviewers.

`GET /api/release` currently selects a random pending row:

```sql
WHERE approved = false
ORDER BY random()
LIMIT 1
```

That means two reviewers can receive the same album at the same time. Before
letting four people review concurrently, implement an atomic claim workflow.

## Recommended Architecture

```text
Mac mini
├── Tailscale
├── Express review server
├── PostgreSQL
└── launchd service or process manager

        encrypted Tailscale network

Reviewer laptops
├── Tailscale
└── Web browser
```

Only the Express app should be reachable by reviewers. PostgreSQL should bind to
`127.0.0.1` and should not be reachable directly over Tailscale or the public
Internet.

## Tailscale Access Model

Use Tailscale for private network access. Do not open router ports or expose the
Mac mini directly to the Internet.

Recommended setup:

1. Install the Standalone Tailscale app on the Mac mini.
2. Install Tailscale on each reviewer machine.
3. Enable MagicDNS in the tailnet so reviewers can use a stable machine name.
4. Restrict access with Tailscale ACLs so only reviewers can reach the review
   app port.

If using direct port access, reviewers open:

```text
http://mac-mini-name:3000
```

or:

```text
http://100.x.y.z:3000
```

If using Tailscale Serve, the Node app can listen only on localhost and
Tailscale can proxy HTTPS traffic to it:

```bash
tailscale serve 3000
```

This is attractive later because Tailscale can provide identity headers for the
requesting user. For the first working version, direct Tailscale access to
`http://mac-mini-name:3000` is simpler.

## Server Binding

For direct Tailscale access, make the Express server listen on all interfaces:

```js
app.listen(PORT, "0.0.0.0", ...);
```

For Tailscale Serve, keep Express bound to localhost and run:

```bash
tailscale serve 3000
```

Pick one model. Do not use both at first.

Recommended first pass: direct Tailscale access on port `3000`, with ACLs
limiting who can reach that port.

## Database Setup On The Mac Mini

Use Postgres on the Mac mini. For Docker Compose, the Postgres port should bind
only to localhost:

```yaml
ports:
  - "127.0.0.1:5432:5432"
```

That still lets the local Express app connect with:

```env
PG_URI=postgresql://postgres:postgres@localhost:5432/vlm_training
```

but prevents reviewer machines from connecting directly to Postgres over
Tailscale.

Current local startup from this repo:

```bash
cd sqldocker
docker compose up -d postgres
```

Check database health:

```bash
docker exec -it vlm-training-postgres pg_isready -U postgres -d vlm_training
docker exec -it vlm-training-postgres psql -U postgres -d vlm_training
```

Check pending rows:

```sql
SELECT COUNT(*) AS pending
FROM releases
WHERE approved = false;
```

## Required Database Change For Multi-User Claims

The `releases` table currently has `approved`, but it does not have claim
fields. Add a claim table instead of overloading the release row.

Suggested migration:

```sql
CREATE TABLE release_claims (
  release_id UUID PRIMARY KEY REFERENCES releases(id),
  reviewer TEXT NOT NULL,
  claimed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX release_claims_claimed_at_idx
  ON release_claims (claimed_at);
```

Keep final review history in `release_reviews`:

```sql
CREATE TABLE IF NOT EXISTS release_reviews (
  id SERIAL PRIMARY KEY,
  release_id UUID NOT NULL REFERENCES releases(id),
  reviewed BOOLEAN NOT NULL DEFAULT false,
  approved BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMP,
  CONSTRAINT approved_requires_reviewed
    CHECK (approved = false OR reviewed = true)
);
```

The current code already inserts into `release_reviews` if that table exists,
but it does not yet store `reviewed_by`. Add that when reviewer identity is
added.

## Claim Next Workflow

Replace `GET /api/release` with a claim endpoint, for example:

```http
POST /api/releases/claim
```

Request body:

```json
{
  "reviewer": "alice"
}
```

Use a transaction and `FOR UPDATE SKIP LOCKED`:

```sql
BEGIN;

WITH next_release AS (
  SELECT r.id
  FROM releases r
  LEFT JOIN release_claims c ON c.release_id = r.id
  WHERE r.approved = false
    AND r.cover_url IS NOT NULL
    AND btrim(r.cover_url) <> ''
    AND r.alt_text IS NOT NULL
    AND btrim(r.alt_text) <> ''
    AND (
      c.release_id IS NULL
      OR c.claimed_at < NOW() - INTERVAL '30 minutes'
    )
  ORDER BY r.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
INSERT INTO release_claims (release_id, reviewer, claimed_at)
SELECT id, $1, NOW()
FROM next_release
ON CONFLICT (release_id) DO UPDATE
SET reviewer = EXCLUDED.reviewer,
    claimed_at = EXCLUDED.claimed_at
WHERE release_claims.claimed_at < NOW() - INTERVAL '30 minutes'
RETURNING release_id;

COMMIT;
```

Then fetch and return that release.

This prevents two reviewers from claiming the same row in the same moment.

## Save Review Workflow

When saving a review:

1. Verify the release is either unclaimed or claimed by the same reviewer.
2. If approved:
   - Leave `releases.alt_text` unchanged.
   - Set `releases.approved = true`.
3. If denied/corrected:
   - Require non-empty corrected alt text.
   - Replace `releases.alt_text` with the corrected version.
   - Set `releases.approved = true`.
4. Insert a `release_reviews` row with:
   - `release_id`
   - `reviewed = true`
   - `approved = true`
   - `notes` containing the corrected text only when there was a correction
   - `reviewed_by`
   - `reviewed_at = NOW()`
5. Delete the row from `release_claims`.

The UI should pass the same `reviewer` value used during claim.

## Reviewer Identity

First pass:

- Show a required reviewer-name input before loading albums.
- Store it in `localStorage`.
- Send it with claim and review requests.

Later:

- Use Tailscale Serve identity headers:
  - `Tailscale-User-Login`
  - `Tailscale-User-Name`

Only trust those headers if the Node app is listening on localhost and all
review traffic goes through Tailscale Serve.

## Running The Web App On The Mac Mini

Install dependencies:

```bash
npm install
```

Create `.env.local`:

```env
PORT=3000
PG_URI=postgresql://postgres:postgres@localhost:5432/vlm_training
```

Start manually for a test:

```bash
node server.js
```

Verify from the Mac mini:

```bash
curl http://localhost:3000/api/release
```

Verify from a reviewer machine connected to Tailscale:

```text
http://mac-mini-name:3000
```

## Process Management

For a production-ish Mac mini setup, do not rely on a terminal window staying
open.

Use one of:

- `launchd` with a plist that runs `node /path/to/vlm-training/server.js`.
- `pm2`, if you prefer a Node-specific process manager.

`launchd` is the most macOS-native choice. The service should:

- Start at boot.
- Restart if the process crashes.
- Set the working directory to the repo path.
- Set `PATH` so it can find the intended `node` binary.

## Backup And Recovery

Before reviewers start, decide where the source of truth lives.

Minimum backup:

```bash
docker exec vlm-training-postgres pg_dump -U postgres -d vlm_training > review_backup.sql
```

Recommended:

- Daily `pg_dump` to a folder that is backed up by Time Machine or another
  backup tool.
- Keep `releases_dump.sql` as the immutable seed data.
- Treat the live Mac mini Postgres volume as mutable review state.

## Deployment Checklist

1. Mac mini has Tailscale installed and signed in.
2. Mac mini has a stable Tailscale machine name.
3. Reviewer machines are in the same tailnet.
4. Tailscale ACL allows reviewers to reach the Mac mini app port.
5. Postgres binds only to `127.0.0.1:5432`.
6. `.env.local` has the production `PG_URI`.
7. The app can load one release locally.
8. A reviewer machine can load the site over Tailscale.
9. Claim workflow is implemented before multiple reviewers start.
10. Backup job is in place before real review work starts.

## References

- Tailscale macOS install variants:
  https://tailscale.com/docs/concepts/macos-variants
- Tailscale MagicDNS:
  https://tailscale.com/docs/features/magicdns
- Tailscale ACLs:
  https://tailscale.com/docs/features/access-control/acls
- Tailscale Serve:
  https://tailscale.com/docs/features/tailscale-serve

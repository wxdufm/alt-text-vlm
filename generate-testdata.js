import 'dotenv/config';
import pg from 'pg';
import sharp from 'sharp';


const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://api.wxdu.art';
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || null;
const CONCURRENCY = 3;
const LOCAL_URL = 'http://localhost:11434';
const MODEL = 'qwen2.5-vl-30b';
const DHASH_THRESHOLD = 8;

async function computeDhash(buffer) {
    const { data } = await sharp(buffer)
        .resize(9, 8, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    let bits = '';
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const idx = row * 9 + col;
            bits += data[idx] > data[idx + 1] ? '1' : '0';
        }
    }
    return bits;
}

async function findDuplicate(pool, dhash) {
    const result = await pool.query(
        `SELECT id, alt_text FROM releases
        WHERE cover_hash IS NOT NULL
        AND bit_count(cover_hash # $1::bit(64)) < $2
        LIMIT 1`,
        [dhash, DHASH_THRESHOLD]
    );
    return result.rows[0] || null;
}

// fetches one page of releases from the Marc's public API
async function fetchReleasePage(offset) {
    const res = await fetch(`${API_BASE}/api/releases?limit=100&offset=${offset}`)
    if(!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// checks if a WXDU release is already tracked in Postgres
async function alreadyProcessed(pool, wxduReleaseId) {
    const result = await pool.query(
        `SELECT 1 FROM release_ids WHERE wxdu_release_id = $1`,
        [wxduReleaseId]
    );
    return result.rows.length > 0;
}

// if downloads_db_id exists, it uses the local API, if not it falls back to Discogs.
async function getCoverUrl(release) {
    if (release.cover_url) {
        return { url: `${API_BASE}${release.cover_url}?size=small`, discogsId: null };
    }

    if (DISCOGS_TOKEN) {
        const { coverUrl, discogsId } = await fetchDiscogsAPI(release.artist, release.title);
        return { url: coverUrl, discogsId };
    }

     return { url: null, discogsId: null };
}


// adapted directly from albumCover.js
async function fetchDiscogsAPI(artist, album) {
    try {
        const params = new URLSearchParams({ type: 'release', token: DISCOGS_TOKEN });
        if (artist) params.append('artist', artist);
        if (album) params.append('release_title', album);

        const res = await fetch(`https://api.discogs.com/database/search?${params}`);
        if (!res.ok) return { coverUrl: null, discogsId: null };

        const data = await res.json();
        // find the first result that has a cover image.
        const match = data.results?.[0]?.cover_image
            ? data.results[0]
            : data.results?.find((r) => r.cover_image);
        
        if (!match) return { coverUrl: null, discogsId: null };
        return { coverUrl: match.cover_image, discogsId: match.id };
    } catch {
        return { coverUrl: null, discogsId: null };
    }
}

async function describeAlbumCover(imageBuffer, artist, title) {
    const base64 = Buffer.from(imageBuffer).toString('base64');


    // sends the request to the local Ollama server running
    const res = await fetch(`${LOCAL_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            // prompt given to the model for generation — can be fine-tuned
            prompt: `This is the album cover for "${title}" by ${artist}. Describe it in 2–3 sentences for a blind or low-vision listener. Include what is visually depicted, the dominant colors and visual style, any visible text other than the artist name and album title, and the mood the image conveys. Be specific and evocative.`,
            images: [base64],
            stream: false,
        }),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const data = await res.json();
    return data.response;
}


async function main() {
    const { Pool } = pg;
    const pool = new Pool({ connectionString: process.env.PG_URI });

    const TARGET = 1000;
    const releases = [];
    let offset = 0;

    while (releases.length < TARGET) {
        const page = await fetchReleasePage(offset);
        if (page.length === 0) break;

        for (const release of page) {
            if (releases.length >= TARGET) break;
            if (await alreadyProcessed(pool, release._id)) continue;
            releases.push(release);
        }
        offset += 100;
    }

    // logs queue size
    console.log(`Found ${releases.length} releases to process`);

    // tracks progress
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let duped = 0;
        

    // loop steps through array 3 at a time
    for (let i = 0; i < releases.length; i += CONCURRENCY) {
    const chunk = releases.slice(i, i + CONCURRENCY);  // slice prevents error at the end if there isn't exactly 3 left.

    // starts the 3 at the same time and waits until they're resolved or caught
    await Promise.all(
        chunk.map(async (release) => {  
        try {
            const { url: coverUrl, discogsId } = await getCoverUrl(release);

            if (!coverUrl) {
                await pool.query(
                    `INSERT INTO release_ids (wxdu_release_id)
                    VALUES ($1)
                    ON CONFLICT (wxdu_release_id) DO NOTHING`,
                    [release._id]
                );
                skipped++;
                console.log(`[${done + duped + failed + skipped}/${releases.length}] ○ ${release.artist} — ${release.title}: no cover`);
                return;
            }

            const imageRes = await fetch(coverUrl);
            const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
            const dhash = await computeDhash(imageBuffer);
            const duplicate = await findDuplicate(pool, dhash);

            if (duplicate) {
                await pool.query(
                    `INSERT INTO release_ids (release_id, wxdu_release_id, discogs_id)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (wxdu_release_id) DO NOTHING`,
                    [duplicate.id, release._id, discogsId]
                );
                duped++;
                console.log(`[${done + duped + failed + skipped}/${releases.length}] ≈ ${release.artist} — ${release.title}: duplicate cover`);
                return;
            }

            const description = await describeAlbumCover(imageBuffer, release.artist, release.title);

            const result = await pool.query(
                `INSERT INTO releases (artist, title, cover_hash, cover_url, alt_text)
                 VALUES ($1, $2, $3::bit(64), $4, $5)
                 RETURNING id`,
                [release.artist, release.title, dhash, coverUrl, description]
            );
            const releaseId = result.rows[0].id;

            await pool.query(
                `INSERT INTO release_ids (release_id, wxdu_release_id, discogs_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (wxdu_release_id) DO NOTHING`,
                [releaseId, release._id, discogsId]
            );

            done++;
            console.log(`[${done + duped + failed + skipped}/${releases.length}] ✓ ${release.artist} — ${release.title}`);
        
        // any errors land here. increments fail counter and logs the error.
        // if there's an error, nothing will have been written to MongoDB, so it will be in queue for next time.
        } catch (err) {
            failed++;
            console.error(`[${done + duped + failed + skipped}/${releases.length}] ✗ ${release.artist} — ${release.title}: ${err.message}`);
        }
        })
    );
    }
    
    // summary line at the end.
    console.log(`\nDone: ${done} generated, ${duped} duplicates, ${skipped} skipped (no cover), ${failed} failed`);
    await pool.end();
}

// handles any error that escapes main entirely.
main().catch(console.error);
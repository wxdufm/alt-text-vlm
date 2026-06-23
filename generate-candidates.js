require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { MongoClient } = require('mongodb');

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://api.wxdu.art';
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || null;
const CONCURRENCY = 3;

const anthropic = new Anthropic();

// if downloads_db_id exists, it uses the local API, if not it falls back to Discogs.
async function getCoverUrl(release) {
    if (release.downloads_db_id) {
        return `${API_BASE}/api/releases/${release._id}/cover?size=small`;
    }

    if (DISCOGS_TOKEN) {
        return await fetchDiscogsAPI(release.artist, release.title);
    }

     return null;
}


// adapted directly from albumCover.js
async function fetchDiscogsAPI(artist, album) {
    try {
        const params = new URLSearchParams({ type: 'release', token: DISCOGS_TOKEN });
        if (artist) params.append('artist', artist);
        if (album) params.append('release_title', album);

    const res = await fetch(`https://api.discogs.com/database/search?${params}`);
    if (!res.ok) return null;

    const data = await res.json();
    return (
        data.results?.[0]?.cover_image ??
        data.results?.find((r) => r.cover_image)?.cover_image ??
        null
    );
    } catch {
        return null;
    }
}
 
async function describeAlbumCover(coverUrl, artist, title) {
    const message = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 300, // safety net - 2-3 sentence description should only use 60-80 tokens.
        messages: [
        {
            role: 'user',
            content: [
            {
                type: 'image',
                source: { type: 'url', url: coverUrl },
            },
            {
            type: 'text',
            // this is the prompt given to the ai for the generation. we can fine-tune this prompt.
            text: `This is the album cover for "${title}" by ${artist}. Describe it in 2–3 sentences for a blind or low-vision listener. Include what is visually depicted, the dominant colors and visual style, any visible text other than the artist name and album title, and the mood the image conveys. Be specific and evocative.`,
            },
        ],
        },
    ],
    });
  
  // returns the text block from Claude's response.
  return message.content.find((b) => b.type === 'text').text;
}


async function main() {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db();

    const releases = await db
    .collection('releases')
    .find(
        {
        candidate_description: { $exists: false },  // looking for entries without the description
        no_cover: { $exists: false },  // want entries with covers
        },
        { projection: { _id: 1, artist: 1, title: 1, downloads_db_id: 1 } }
    )
    .toArray();  // loads the matching document into memory as an array


    // logs queue size
    console.log(`Found ${releases.length} releases to process`);

    // tracks progress
    let done = 0;
    let failed = 0;
    let skipped = 0;

    // loop steps through array 3 at a time
    for (let i = 0; i < releases.length; i += CONCURRENCY) {
    const chunk = releases.slice(i, i + CONCURRENCY);  // slice prevents error at the end if there isn't exactly 3 left.

    // starts the 3 at the same time and waits until they're resolved or caught
    await Promise.all(
        chunk.map(async (release) => {  
        try {
            const coverUrl = await getCoverUrl(release);

            if (!coverUrl) {
            await db.collection('releases').updateOne(
                { _id: release._id },
                { $set: { no_cover: true } }
            );

            skipped++;
            console.log(`[${done + failed + skipped}/${releases.length}] ○ ${release.artist} — ${release.title}: no cover`);
            return;
            }

            const description = await describeAlbumCover(coverUrl, release.artist, release.title);

            // writes the description back to MongoDB
            await db.collection('releases').updateOne(  // finds the document with the specifc id and then adds or overwrites the update
                { _id: release._id },
                { $set: { candidate_description: description, candidate_generated_at: new Date() } }
            );

            // increments counter and logs a success line.
            done++;
            console.log(`[${done + failed + skipped}/${releases.length}] ✓ ${release.artist} — ${release.title}`);
        
        // any errors land here. increments fail counter and logs the error.
        // if there's an error, nothing will have been written to MongoDB, so it will be in queue for next time.
        } catch (err) {
            failed++;
            console.error(`[${done + failed + skipped}/${releases.length}] ✗ ${release.artist} — ${release.title}: ${err.message}`);
        }
        })
    );
    }
    
    // summary line at the end.
    console.log(`\nDone: ${done} generated, ${skipped} skipped (no cover), ${failed} failed`);
    await client.close();
}

// handles any error that escapes main entirely.
main().catch(console.error);
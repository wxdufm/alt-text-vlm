import 'dotenv/config';
import pg from 'pg';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'fs';
import { extname, join } from 'path';

const { Pool } = pg;

// ----------------------------------------
// Config
// ----------------------------------------

const PROMPT_TEMPLATE = readFileSync('prompts/short_prompt.txt', 'utf-8');

const TOTAL = 524;
const TRAIN_COUNT = 444;
const VALID_COUNT = 80;
const TRAIN_TEST_COUNT = 100;

const DATA_DIR = 'data';
const COVERS_DIR = 'data/covers';

const TRAIN_PATH = join(DATA_DIR, 'train.jsonl');
const VALID_PATH = join(DATA_DIR, 'valid.jsonl');
const TRAIN_TEST_PATH = join(DATA_DIR, 'train_test.jsonl');

// ----------------------------------------
// Helpers
// ----------------------------------------

// Convert review_triggers from Postgres into a JSON string for the XML output.
function normalizeReviewTriggers(value) {
  if (!value) return '[]';

  if (Array.isArray(value)) return JSON.stringify(value);

  if (typeof value === 'object') return JSON.stringify(value);

  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return JSON.stringify([value]);
    }
  }

  return '[]';
}

// Fill the prompt template with the release metadata.
function buildPrompt(artist, title) {
  return PROMPT_TEMPLATE
    .replaceAll('{{artist}}', artist || 'Unknown artist')
    .replaceAll('{{title}}', title || 'Unknown title');
}

// Build the assistant answer from the validated fields in Postgres.
function buildAssistantOutput(row) {
  const confidenceReasoning =
    row.confidence_explanation && row.confidence_explanation.trim()
      ? row.confidence_explanation.trim()
      : row.confidence === 1
        ? 'N/A'
        : '';

  return [
    `<description>${row.alt_text.trim()}</description>`,
    `<confidence-score>${row.confidence}</confidence-score>`,
    `<confidence-reasoning>${confidenceReasoning}</confidence-reasoning>`,
    `<review-triggers>${normalizeReviewTriggers(row.review_triggers)}</review-triggers>`,
  ].join('\n');
}

// Convert one Postgres row into one MLX-VLM JSONL training example.
function buildJsonlRow(row) {
  return {
    id: row.id,
    image: row.cover_url,
    messages: [
      {
        role: 'user',
        content: buildPrompt(row.artist, row.title),
      },
      {
        role: 'assistant',
        content: buildAssistantOutput(row),
      },
    ],
  };
}

// Write an array of objects to a JSONL file.
function writeJsonl(path, rows) {
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(path, text, 'utf-8');
}

// Read a JSONL file into an array of objects.
function readJsonl(path) {
  const text = readFileSync(path, 'utf-8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line));
}

// Decide the image extension from the URL or HTTP content type.
function getImageExtension(url, contentType) {
  const cleanUrl = url.split('?')[0];
  const fromUrl = extname(cleanUrl).toLowerCase();

  if (['.jpg', '.jpeg', '.png', '.webp'].includes(fromUrl)) {
    return fromUrl;
  }

  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';

  return '.jpg';
}

// Download one image and return the local filepath.
// If the image already exists, reuse it instead of downloading again.
async function downloadImage(row) {
  const res = await fetch(row.image);

  if (!res.ok) {
    throw new Error(`Failed to download ${row.image}: ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || '';
  const ext = getImageExtension(row.image, contentType);
  const filepath = join(COVERS_DIR, `${row.id}${ext}`);

  if (existsSync(filepath)) {
    return filepath;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(filepath, buffer);

  return filepath;
}

// Read a JSONL file, download each external image URL,
// replace "image" with the local filepath, then rewrite the JSONL file.
async function localizeImages(jsonlPath) {
  const rows = readJsonl(jsonlPath);
  const updatedRows = [];

  console.log(`\nLocalizing images in ${jsonlPath}...`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    try {
      // If this row already points to a local file, keep it unchanged.
      if (!row.image.startsWith('http://') && !row.image.startsWith('https://')) {
        updatedRows.push(row);
        console.log(`[${i + 1}/${rows.length}] already local: ${row.image}`);
        continue;
      }

      const localPath = await downloadImage(row);

      updatedRows.push({
        ...row,
        image: localPath,
      });

      console.log(`[${i + 1}/${rows.length}] downloaded ${row.id} -> ${localPath}`);
    } catch (err) {
      // Keep the original row if download fails, so the file is not corrupted.
      updatedRows.push(row);
      console.error(`[${i + 1}/${rows.length}] failed ${row.id}: ${err.message}`);
    }
  }

  writeJsonl(jsonlPath, updatedRows);
  console.log(`Updated ${jsonlPath}`);
}

// ----------------------------------------
// Main script
// ----------------------------------------

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(COVERS_DIR, { recursive: true });

  const pool = new Pool({
    connectionString: process.env.PG_URI,
  });

  // Pull only the validated rows that belong to the reviewed training set.
  const result = await pool.query(
    `
    SELECT
      id,
      artist,
      title,
      cover_url,
      alt_text,
      confidence,
      approved,
      review_triggers,
      confidence_explanation,
      updated_at
    FROM releases
    WHERE approved = true
      AND LENGTH(alt_text) < 131
      AND cover_url IS NOT NULL
      AND alt_text IS NOT NULL
    ORDER BY id ASC
    `
  );

  await pool.end();

  const rows = result.rows;

  console.log(`Found ${rows.length} approved rows`);

  if (rows.length !== TOTAL) {
    throw new Error(`Incorrect amount of data found: ${rows.length}`);
  }

  // Convert database rows into training rows.
  const selectedRows = rows.slice(0, TOTAL);
  const jsonlRows = selectedRows.map(buildJsonlRow);

  // Split into train, validation, and train-test.
  const trainRows = jsonlRows.slice(0, TRAIN_COUNT);
  const validRows = jsonlRows.slice(TRAIN_COUNT, TOTAL);
  const trainTestRows = trainRows.slice(0, TRAIN_TEST_COUNT);

  // First write all files with external cover_url values.
  writeJsonl(TRAIN_PATH, trainRows);
  writeJsonl(VALID_PATH, validRows);
  writeJsonl(TRAIN_TEST_PATH, trainTestRows);

  console.log('\nWrote initial JSONL files with external cover URLs:');
  console.log(`- ${TRAIN_PATH}: ${trainRows.length}`);
  console.log(`- ${VALID_PATH}: ${validRows.length}`);
  console.log(`- ${TRAIN_TEST_PATH}: ${trainTestRows.length}`);

  // Then download images and replace image URLs with local paths in every JSONL file.
  await localizeImages(TRAIN_PATH);
  await localizeImages(VALID_PATH);
  await localizeImages(TRAIN_TEST_PATH);

  console.log('\nDone.');
  console.log('All JSONL files now point to local image paths when downloads succeeded.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
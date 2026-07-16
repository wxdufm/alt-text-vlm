// Standalone backend for the alt-text generation playground (public/alt_text_generation_website).
// Deliberately separate from server.js/the reviewer app: different port, own process, own
// lifecycle. It talks to a persistent Python process (scripts/inference_server.py) for the
// actual mlx_vlm generation, spawning it on demand since Node can't call mlx_vlm directly.
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getPostgresPool } from "./lib/postgres.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const app = express();
const PORT = process.env.ALT_TEXT_PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";

const COVERS_DIR = path.join(process.cwd(), "data", "covers");
const COVER_EXTENSIONS = [".jpg", ".jpeg", ".png"];

// The two JSONL files selectable from the "select by dataset index" control; each row's
// "id" field maps back to a file in data/covers.
const DATASET_FILES = {
  "train.jsonl": path.join(process.cwd(), "data", "train.jsonl"),
  "valid.jsonl": path.join(process.cwd(), "data", "valid.jsonl")
};

// A random file in data/covers isn't guaranteed to have a matching releases row (or vice
// versa), so /api/random-cover retries a handful of picks before giving up.
const RANDOM_COVER_MAX_ATTEMPTS = 15;

// Same pattern server.js uses for release ids; kept local since this file must not import
// from server.js.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Best checkpoint per trial, per "2. All seven trials at a glance" in
// final_fine_tuning_report.md. Each path is a self-contained adapter
// directory (its own adapter_config.json + adapters.safetensors) — mlx_vlm's
// apply_lora_layers always reads "<adapter_path>/adapters.safetensors", so a
// specific checkpoint (e.g. "700") has to live in its own subdirectory rather
// than being pointed at directly as a numbered file.
const BEST_ADAPTERS = {
  "1st-trial": {
    path: "adapters/1st-trial",
    label: "1st trial — final (0% well-formed, broken prompt)"
  },
  "2nd-trial": {
    path: "adapters/2nd-trial/700",
    label: "2nd trial — checkpoint 700 (97.5% well-formed)"
  },
  "3rd-trial": {
    path: "adapters/3rd-trial/700",
    label: "3rd trial — checkpoint 700 (98.8% well-formed, overall best)"
  },
  "4th-trial": {
    path: "adapters/4th-trial",
    label: "4th trial — final (38.8% well-formed)"
  },
  "5th-trial": {
    path: "adapters/5th-trial/900",
    label: "5th trial — checkpoint 900 (92.5% well-formed)"
  },
  "6th-trial": {
    path: "adapters/6th-trial/700",
    label: "6th trial — checkpoint 700 (58.8% well-formed)"
  },
  "7th-trial": {
    path: "adapters/7th-trial/800",
    label: "7th trial — checkpoint 800 (95.0% well-formed)"
  }
};

const PYTHON_BIN = process.env.PYTHON_BIN || "/Users/xdu/miniconda3/bin/python3";
const INFERENCE_HOST = "127.0.0.1";
const INFERENCE_PORT = process.env.INFERENCE_PORT || 8765;
const INFERENCE_BASE_URL = `http://${INFERENCE_HOST}:${INFERENCE_PORT}`;
const INFERENCE_STARTUP_TIMEOUT_MS = 120_000;

// Holds the spawned Python child process (if we started one) and an in-flight startup
// promise so concurrent requests don't each try to spawn their own copy.
let inferenceProcess = null;
let inferenceReadyPromise = null;

function findCoverPath(id) {
  for (const ext of COVER_EXTENSIONS) {
    const candidate = path.join(COVERS_DIR, `${id}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Dataset rows only need their "id" field for this tool (the cover + artist/title still
// come from data/covers and Postgres respectively), so parse just that out of each line.
function readDatasetIds(file) {
  const filePath = DATASET_FILES[file];
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line).id);
}

async function checkInferenceHealth() {
  try {
    const res = await fetch(`${INFERENCE_BASE_URL}/health`, {
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Lazily starts scripts/inference_server.py the first time it's needed and waits for its
// /health endpoint to respond. The timeout is long because the first request also has to
// load the ~8B-parameter base model into memory, which can take a while.
async function ensureInferenceServer() {
  if (await checkInferenceHealth()) {
    return;
  }

  if (!inferenceReadyPromise) {
    inferenceReadyPromise = (async () => {
      if (!inferenceProcess) {
        console.log(
          `Starting inference server: ${PYTHON_BIN} scripts/inference_server.py --port ${INFERENCE_PORT}`
        );
        inferenceProcess = spawn(
          PYTHON_BIN,
          ["scripts/inference_server.py", "--port", String(INFERENCE_PORT)],
          { cwd: process.cwd(), stdio: "inherit" }
        );
        inferenceProcess.on("exit", (code) => {
          console.log(`Inference server exited with code ${code}`);
          inferenceProcess = null;
        });
        inferenceProcess.on("error", (err) => {
          console.error(`Failed to start inference server: ${err.message}`);
          inferenceProcess = null;
        });
      }

      const deadline = Date.now() + INFERENCE_STARTUP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await checkInferenceHealth()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("Inference server did not become healthy in time");
    })();
  }

  try {
    await inferenceReadyPromise;
  } finally {
    inferenceReadyPromise = null;
  }
}

// Shared by /api/release/:id, /api/random-cover, and /api/generate. The cover must exist
// locally in data/covers — this intentionally never falls back to the releases table's
// cover_url, per the requirement that only locally-available covers are selectable.
async function lookupRelease(id) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    return { error: 400, message: "Invalid release id" };
  }

  const coverPath = findCoverPath(id);
  if (!coverPath) {
    return { error: 404, message: `No cover found in data/covers for id ${id}` };
  }

  const pool = getPostgresPool();
  const result = await pool.query(
    "SELECT artist, title FROM releases WHERE id = $1",
    [id]
  );

  if (result.rows.length === 0) {
    return { error: 404, message: `No release found in the database for id ${id}` };
  }

  const { artist, title } = result.rows[0];
  return { id, artist, title, coverPath };
}

app.use(express.static("public/alt_text_generation_website"));
app.use(express.json());

// Powers the trial dropdown. The frontend never hardcodes trial names/labels itself.
app.get("/api/trials", (req, res) => {
  const trials = Object.entries(BEST_ADAPTERS).map(([key, { label }]) => ({
    key,
    label
  }));
  res.json({ trials });
});

// Used for the live cover/artist/title preview as the user types a release id.
app.get("/api/release/:id", async (req, res) => {
  try {
    const result = await lookupRelease(req.params.id);
    if (result.error) {
      return res.status(result.error).json({ error: result.message });
    }
    res.json({ id: result.id, artist: result.artist, title: result.title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to look up release", detail: err.message });
  }
});

// Powers the "Select random cover" button.
app.get("/api/random-cover", async (req, res) => {
  try {
    const files = fs
      .readdirSync(COVERS_DIR)
      .filter((f) => COVER_EXTENSIONS.includes(path.extname(f).toLowerCase()));

    if (files.length === 0) {
      return res.status(404).json({ error: "No covers found in data/covers" });
    }

    // Retry instead of pre-filtering the whole directory against Postgres up front —
    // cheaper for the common case where most covers do have a matching release row.
    for (let attempt = 0; attempt < RANDOM_COVER_MAX_ATTEMPTS; attempt++) {
      const file = files[Math.floor(Math.random() * files.length)];
      const id = path.basename(file, path.extname(file));
      const release = await lookupRelease(id);
      if (!release.error) {
        return res.json({ id });
      }
    }

    res.status(404).json({
      error: "Could not find a random cover with matching release data after several attempts"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to pick a random cover", detail: err.message });
  }
});

// Powers the "select by dataset index" control: resolves row N of train.jsonl/valid.jsonl
// to a release id, which the frontend then feeds through the normal preview flow.
app.get("/api/dataset-row", (req, res) => {
  const { file, index } = req.query;

  if (!DATASET_FILES[file]) {
    return res.status(400).json({ error: `Unknown dataset file: ${file}` });
  }

  const parsedIndex = Number(index);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return res.status(400).json({ error: "index must be a non-negative integer" });
  }

  let ids;
  try {
    ids = readDatasetIds(file);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: `Failed to read ${file}`, detail: err.message });
  }

  if (parsedIndex >= ids.length) {
    return res.status(400).json({
      error: `Index ${parsedIndex} out of range — ${file} has ${ids.length} rows (0-${ids.length - 1})`
    });
  }

  res.json({ id: ids[parsedIndex], index: parsedIndex, file, total: ids.length });
});

// Streams the actual image bytes — the browser can't reach data/covers directly since
// only public/alt_text_generation_website is served as static content.
app.get("/api/cover/:id", (req, res) => {
  const { id } = req.params;
  if (!UUID_PATTERN.test(id)) {
    return res.status(400).json({ error: "Invalid release id" });
  }
  const coverPath = findCoverPath(id);
  if (!coverPath) {
    return res.status(404).json({ error: "Cover not found" });
  }
  res.sendFile(coverPath);
});

app.post("/api/generate", async (req, res) => {
  const { releaseId, trial } = req.body || {};

  if (!BEST_ADAPTERS[trial]) {
    return res.status(400).json({ error: `Unknown trial: ${trial}` });
  }

  try {
    const release = await lookupRelease(releaseId);
    if (release.error) {
      return res.status(release.error).json({ error: release.message });
    }

    await ensureInferenceServer();

    const adapterPath = path.join(process.cwd(), BEST_ADAPTERS[trial].path);

    const response = await fetch(`${INFERENCE_BASE_URL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_path: release.coverPath,
        artist: release.artist,
        title: release.title,
        adapter_path: adapterPath
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.detail || "Generation failed"
      });
    }

    res.json({
      id: release.id,
      artist: release.artist,
      title: release.title,
      trial,
      ...data
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate alt text", detail: err.message });
  }
});

app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(`Failed to start alt text server on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Alt text generation playground running at http://${HOST}:${PORT}`);
});

// Take the Python inference process down with us so it doesn't linger holding the model
// in memory after this server stops.
function shutdown() {
  if (inferenceProcess) {
    inferenceProcess.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

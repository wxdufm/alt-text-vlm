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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Best checkpoint per trial, per "2. All seven trials at a glance" in
// final_fine_tuning_report.md. Each path is a self-contained adapter
// directory (its own adapter_config.json + adapters.safetensors).
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

app.get("/api/trials", (req, res) => {
  const trials = Object.entries(BEST_ADAPTERS).map(([key, { label }]) => ({
    key,
    label
  }));
  res.json({ trials });
});

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

function shutdown() {
  if (inferenceProcess) {
    inferenceProcess.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

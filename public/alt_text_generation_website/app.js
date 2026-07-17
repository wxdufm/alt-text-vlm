const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const releaseIdInput = document.getElementById("releaseId");
const randomCoverBtn = document.getElementById("randomCoverBtn");
const randomUnapprovedBtn = document.getElementById("randomUnapprovedBtn");
const datasetFileSelect = document.getElementById("datasetFile");
const datasetIndexInput = document.getElementById("datasetIndex");
const trialSelect = document.getElementById("trialSelect");
const generateBtn = document.getElementById("generateBtn");
const statusMessage = document.getElementById("statusMessage");

const cover = document.getElementById("cover");
const coverPlaceholder = document.getElementById("coverPlaceholder");
const albumTitle = document.getElementById("albumTitle");
const artistName = document.getElementById("artistName");
const sourceBadge = document.getElementById("sourceBadge");
const description = document.getElementById("description");
const descriptionCharCount = document.getElementById("descriptionCharCount");
const confidenceScore = document.getElementById("confidenceScore");
const reviewTriggers = document.getElementById("reviewTriggers");
const confidenceReasoning = document.getElementById("confidenceReasoning");
const rawOutput = document.getElementById("rawOutput");

// Same limit used elsewhere in this project (ALT_TEXT_MAX_LENGTH in server.js,
// MAX_DESCRIPTION_CHARS in scripts/04_generate_alt_text.py).
const MAX_DESCRIPTION_CHARS = 130;

// 3rd-trial is the overall best per final_fine_tuning_report.md §2 (98.8% well-formed),
// so it's preselected rather than defaulting to whatever /api/trials returns first.
const DEFAULT_TRIAL = "3rd-trial";

let currentRelease = null;
// Incremented on every previewRelease() call so a slow, stale fetch response (e.g. from
// typing quickly) can't overwrite the UI after a newer one has already resolved.
let previewToken = 0;

function setStatus(message, isError = false) {
  statusMessage.textContent = message || "";
  statusMessage.classList.toggle("error", isError);
}

function updateCharCount(text) {
  const count = text ? text.length : 0;
  descriptionCharCount.textContent = `${count} character${count === 1 ? "" : "s"}`;
  descriptionCharCount.classList.toggle("over-limit", count > MAX_DESCRIPTION_CHARS);
}

function resetPreview() {
  currentRelease = null;
  cover.classList.remove("loaded");
  cover.src = "";
  coverPlaceholder.style.display = "block";
  coverPlaceholder.textContent = "Enter a release ID to preview its cover";
  albumTitle.textContent = "—";
  artistName.textContent = "—";
  sourceBadge.hidden = true;
  updateGenerateEnabled();
}

function updateGenerateEnabled() {
  generateBtn.disabled = !currentRelease || !trialSelect.value;
}

async function loadTrials() {
  try {
    const res = await fetch("/api/trials");
    const data = await res.json();
    trialSelect.innerHTML = "";
    for (const trial of data.trials) {
      const option = document.createElement("option");
      option.value = trial.key;
      option.textContent = trial.label;
      trialSelect.appendChild(option);
    }
    if (data.trials.some((trial) => trial.key === DEFAULT_TRIAL)) {
      trialSelect.value = DEFAULT_TRIAL;
    }
    updateGenerateEnabled();
  } catch (err) {
    trialSelect.innerHTML = '<option value="">Failed to load trials</option>';
    setStatus(`Failed to load trials: ${err.message}`, true);
  }
}

// Fetches artist/title/cover for a candidate release id and updates the left-hand preview.
// Used both by manual typing (debounced) and by setReleaseId() (immediate).
async function previewRelease(id) {
  const token = ++previewToken;

  if (!UUID_PATTERN.test(id)) {
    resetPreview();
    return;
  }

  coverPlaceholder.style.display = "block";
  coverPlaceholder.textContent = "Loading release...";
  cover.classList.remove("loaded");

  try {
    const res = await fetch(`/api/release/${encodeURIComponent(id)}`);
    const data = await res.json();

    if (token !== previewToken) {
      return;
    }

    if (!res.ok) {
      currentRelease = null;
      albumTitle.textContent = "—";
      artistName.textContent = "—";
      sourceBadge.hidden = true;
      coverPlaceholder.textContent = data.error || "Release not found";
      updateGenerateEnabled();
      return;
    }

    currentRelease = { ...data, local: true };
    albumTitle.textContent = data.title;
    artistName.textContent = data.artist;
    sourceBadge.hidden = true;
    cover.src = `/api/cover/${encodeURIComponent(id)}?t=${Date.now()}`;
    cover.onload = () => {
      cover.classList.add("loaded");
      coverPlaceholder.style.display = "none";
    };
    updateGenerateEnabled();
  } catch (err) {
    if (token !== previewToken) {
      return;
    }
    currentRelease = null;
    coverPlaceholder.textContent = `Failed to load release: ${err.message}`;
    updateGenerateEnabled();
  }
}

// Single entry point used by the random-cover button and the dataset-index selector to
// populate the release id field and preview it immediately (bypassing the typing debounce,
// since the id is already known-good in both cases).
function setReleaseId(id) {
  clearTimeout(previewDebounce);
  releaseIdInput.value = id;
  previewRelease(id);
}

let previewDebounce = null;
releaseIdInput.addEventListener("input", () => {
  clearTimeout(previewDebounce);
  const id = releaseIdInput.value.trim();
  previewDebounce = setTimeout(() => previewRelease(id), 400);
});

trialSelect.addEventListener("change", updateGenerateEnabled);

randomCoverBtn.addEventListener("click", async () => {
  randomCoverBtn.disabled = true;
  setStatus("Picking a random cover...");
  try {
    const res = await fetch("/api/random-cover");
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Failed to pick a random cover", true);
      return;
    }
    setStatus("");
    setReleaseId(data.id);
  } catch (err) {
    setStatus(`Failed to pick a random cover: ${err.message}`, true);
  } finally {
    randomCoverBtn.disabled = false;
  }
});

// Populates the preview directly from a /api/random-unapproved-cover response, bypassing
// previewRelease()/setReleaseId() entirely since those require a local data/covers file —
// this flow's whole point is releases that don't have one, sourced via cover_url instead.
function setExternalRelease(data) {
  clearTimeout(previewDebounce);
  previewToken++; // invalidate any in-flight local preview lookup

  releaseIdInput.value = data.id;
  currentRelease = {
    id: data.id,
    artist: data.artist,
    title: data.title,
    local: false
  };

  albumTitle.textContent = data.title;
  artistName.textContent = data.artist;
  sourceBadge.hidden = false;

  coverPlaceholder.style.display = "block";
  coverPlaceholder.textContent = "Loading cover from database...";
  cover.classList.remove("loaded");
  cover.src = data.coverUrl;
  cover.onload = () => {
    cover.classList.add("loaded");
    coverPlaceholder.style.display = "none";
  };
  cover.onerror = () => {
    cover.classList.remove("loaded");
    coverPlaceholder.style.display = "block";
    coverPlaceholder.textContent = "Failed to load cover from cover_url";
  };

  updateGenerateEnabled();
}

randomUnapprovedBtn.addEventListener("click", async () => {
  randomUnapprovedBtn.disabled = true;
  setStatus("Picking a random unreviewed cover...");
  try {
    const res = await fetch("/api/random-unapproved-cover");
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Failed to pick a random unreviewed cover", true);
      return;
    }
    setStatus("");
    setExternalRelease(data);
  } catch (err) {
    setStatus(`Failed to pick a random unreviewed cover: ${err.message}`, true);
  } finally {
    randomUnapprovedBtn.disabled = false;
  }
});

// Resolves the selected dataset file + index to a release id via /api/dataset-row, then
// hands off to setReleaseId() to load it the same way any other id would be.
async function loadDatasetIndex() {
  const file = datasetFileSelect.value;
  const rawIndex = datasetIndexInput.value.trim();

  if (rawIndex === "") {
    return;
  }

  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) {
    setStatus("Index must be a non-negative integer", true);
    return;
  }

  setStatus(`Loading row ${index} from ${file}...`);
  try {
    const res = await fetch(`/api/dataset-row?file=${encodeURIComponent(file)}&index=${index}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Failed to load dataset row", true);
      return;
    }
    setStatus("");
    setReleaseId(data.id);
  } catch (err) {
    setStatus(`Failed to load dataset row: ${err.message}`, true);
  }
}

let datasetIndexDebounce = null;
datasetIndexInput.addEventListener("input", () => {
  clearTimeout(datasetIndexDebounce);
  datasetIndexDebounce = setTimeout(loadDatasetIndex, 400);
});

datasetFileSelect.addEventListener("change", () => {
  if (datasetIndexInput.value.trim() !== "") {
    loadDatasetIndex();
  }
});

// Runs the selected trial's best adapter against the currently previewed release. The
// first generation against a given trial is slow (model/adapter load); subsequent ones
// against the same trial reuse the inference server's in-memory cache.
generateBtn.addEventListener("click", async () => {
  if (!currentRelease || !trialSelect.value) {
    return;
  }

  generateBtn.disabled = true;
  setStatus("Generating... first run against a given trial can take a while to load the model.");
  description.textContent = "Generating...";
  updateCharCount(null);
  confidenceScore.textContent = "—";
  reviewTriggers.textContent = "—";
  confidenceReasoning.textContent = "—";
  rawOutput.textContent = "";

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        releaseId: currentRelease.id,
        trial: trialSelect.value,
        useExternalCover: currentRelease.local === false
      })
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Generation failed", true);
      description.textContent = "Generation failed.";
      updateCharCount(null);
      return;
    }

    setStatus("");
    description.textContent = data.description || "(no description tag found)";
    updateCharCount(data.description);
    confidenceScore.textContent =
      data.confidence_score === null || data.confidence_score === undefined
        ? "(missing)"
        : String(data.confidence_score);
    reviewTriggers.textContent = data.review_triggers
      ? JSON.stringify(data.review_triggers)
      : "(missing)";
    confidenceReasoning.textContent = data.confidence_reasoning || "(not present in this trial's format)";
    rawOutput.textContent = data.raw_text || "";
  } catch (err) {
    setStatus(`Generation failed: ${err.message}`, true);
    description.textContent = "Generation failed.";
    updateCharCount(null);
  } finally {
    updateGenerateEnabled();
  }
});

resetPreview();
loadTrials();

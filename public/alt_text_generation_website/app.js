const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const releaseIdInput = document.getElementById("releaseId");
const trialSelect = document.getElementById("trialSelect");
const generateBtn = document.getElementById("generateBtn");
const statusMessage = document.getElementById("statusMessage");

const cover = document.getElementById("cover");
const coverPlaceholder = document.getElementById("coverPlaceholder");
const albumTitle = document.getElementById("albumTitle");
const artistName = document.getElementById("artistName");
const description = document.getElementById("description");
const confidenceScore = document.getElementById("confidenceScore");
const reviewTriggers = document.getElementById("reviewTriggers");
const confidenceReasoning = document.getElementById("confidenceReasoning");
const rawOutput = document.getElementById("rawOutput");

let currentRelease = null;
let previewToken = 0;

function setStatus(message, isError = false) {
  statusMessage.textContent = message || "";
  statusMessage.classList.toggle("error", isError);
}

function resetPreview() {
  currentRelease = null;
  cover.classList.remove("loaded");
  cover.src = "";
  coverPlaceholder.style.display = "block";
  coverPlaceholder.textContent = "Enter a release ID to preview its cover";
  albumTitle.textContent = "—";
  artistName.textContent = "—";
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
    updateGenerateEnabled();
  } catch (err) {
    trialSelect.innerHTML = '<option value="">Failed to load trials</option>';
    setStatus(`Failed to load trials: ${err.message}`, true);
  }
}

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
      coverPlaceholder.textContent = data.error || "Release not found";
      updateGenerateEnabled();
      return;
    }

    currentRelease = data;
    albumTitle.textContent = data.title;
    artistName.textContent = data.artist;
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

let previewDebounce = null;
releaseIdInput.addEventListener("input", () => {
  clearTimeout(previewDebounce);
  const id = releaseIdInput.value.trim();
  previewDebounce = setTimeout(() => previewRelease(id), 400);
});

trialSelect.addEventListener("change", updateGenerateEnabled);

generateBtn.addEventListener("click", async () => {
  if (!currentRelease || !trialSelect.value) {
    return;
  }

  generateBtn.disabled = true;
  setStatus("Generating... first run against a given trial can take a while to load the model.");
  description.textContent = "Generating...";
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
        trial: trialSelect.value
      })
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Generation failed", true);
      description.textContent = "Generation failed.";
      return;
    }

    setStatus("");
    description.textContent = data.description || "(no description tag found)";
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
  } finally {
    updateGenerateEnabled();
  }
});

resetPreview();
loadTrials();

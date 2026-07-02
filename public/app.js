let currentRelease = null;

const cover = document.getElementById("cover");
const albumTitle = document.getElementById("albumTitle");
const artistName = document.getElementById("artistName");
const confidenceScore = document.getElementById("confidenceScore");
const reviewTriggers = document.getElementById("reviewTriggers");
const description = document.getElementById("description");
const status = document.getElementById("status");
const skipBtn = document.getElementById("skipBtn");
const approveBtn = document.getElementById("approveBtn");
const denyBtn = document.getElementById("denyBtn");
const denyPanel = document.getElementById("denyPanel");
const denyReason = document.getElementById("denyReason");
const confirmDenyBtn = document.getElementById("confirmDenyBtn");
const cancelDenyBtn = document.getElementById("cancelDenyBtn");

const loadingDescription = "Loading generated description...";

function setStatus(message, type = "") {
  status.textContent = message;

  if (type) {
    status.dataset.type = type;
  } else {
    delete status.dataset.type;
  }
}

function setButtonsLoading(isLoading) {
  skipBtn.disabled = isLoading;
  approveBtn.disabled = isLoading || !currentRelease;
  denyBtn.disabled = isLoading || !currentRelease;
  confirmDenyBtn.disabled =
    isLoading ||
    !currentRelease ||
    (!denyPanel.hidden && denyReason.value.trim() === "");
  cancelDenyBtn.disabled = isLoading;
}

function hideDenyPanel() {
  denyPanel.hidden = true;
  denyReason.value = "";
  setButtonsLoading(false);
}

function formatConfidence(value) {
  if (value === null || value === undefined || value === "") {
    return "Not provided";
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return `${Math.round(numericValue * 100)}% (${numericValue.toFixed(2)})`;
}

function normalizeReviewTriggers(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }

  if (typeof value === "object") {
    return Object.entries(value).map(([key, trigger]) => `${key}: ${trigger}`);
  }

  return [String(value)];
}

function renderReviewTriggers(value) {
  const triggers = normalizeReviewTriggers(value);

  reviewTriggers.replaceChildren();

  if (triggers.length === 0) {
    const item = document.createElement("li");
    item.textContent = "None";
    reviewTriggers.append(item);
    return;
  }

  for (const trigger of triggers) {
    const item = document.createElement("li");
    item.textContent = trigger;
    reviewTriggers.append(item);
  }
}

async function loadRelease() {
  currentRelease = null;
  albumTitle.textContent = "Album: Loading...";
  artistName.textContent = "By: Loading...";
  confidenceScore.textContent = "Loading...";
  reviewTriggers.replaceChildren(Object.assign(document.createElement("li"), {
    textContent: "Loading..."
  }));
  description.textContent = loadingDescription;
  cover.removeAttribute("src");
  cover.alt = "";
  hideDenyPanel();
  setStatus("");
  setButtonsLoading(true);

  try {
    const res = await fetch("/api/release");
    const release = await res.json();

    if (!res.ok) {
      throw new Error(release.error || `Request failed with status ${res.status}`);
    }

    if (!release?.cover_url) {
      throw new Error("API response did not include cover_url.");
    }

    currentRelease = release;

    cover.src = release.cover_url;
    cover.alt = `Album cover for ${
      release.title ||
      release.album ||
      "unknown album"
    }`;

    albumTitle.textContent = `Album: ${
      release.title ||
      release.album ||
      "Unknown Album"
    }`;
    artistName.textContent = `By: ${
      release.artist ||
      "Unknown Artist"
    }`;

    confidenceScore.textContent = formatConfidence(release.confidence);
    renderReviewTriggers(release.review_triggers);
    description.textContent =
      release.alt_text || "No generated description is available.";
    setStatus("");
  } catch (err) {
    console.error(err);
    albumTitle.textContent = "Album: No release loaded";
    artistName.textContent = "By: Unknown Artist";
    confidenceScore.textContent = "Not available";
    renderReviewTriggers([]);
    setStatus(err.message, "error");
  } finally {
    setButtonsLoading(false);
  }
}

cover.addEventListener("error", () => {
  if (!currentRelease) return;

  setStatus("Image failed to load. Check the cover_url value.", "error");
});

skipBtn.addEventListener("click", loadRelease);

async function saveReview(approved, correctedAltText = "") {
  if (!currentRelease) return;

  setButtonsLoading(true);
  setStatus(approved ? "Saving approval..." : "Saving correction...");

  try {
    const res = await fetch(
      `/api/release/${encodeURIComponent(currentRelease.id)}/review`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          approved,
          correctedAltText
        })
      }
    );
    const payload = await res.json();

    if (!res.ok) {
      throw new Error(payload.error || `Request failed with status ${res.status}`);
    }

    hideDenyPanel();
    await loadRelease();
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
  } finally {
    setButtonsLoading(false);
  }
}

approveBtn.addEventListener("click", async () => {
  if (!currentRelease) return;

  hideDenyPanel();
  await saveReview(true);
});

denyBtn.addEventListener("click", () => {
  if (!currentRelease) return;

  denyPanel.hidden = false;
  denyReason.focus();
  setStatus("");
  setButtonsLoading(false);
});

confirmDenyBtn.addEventListener("click", async () => {
  if (!currentRelease) return;

  const correctedAltText = denyReason.value.trim();

  if (correctedAltText === "") {
    setStatus("Corrected alt text is required.", "error");
    denyReason.focus();
    setButtonsLoading(false);
    return;
  }

  await saveReview(false, correctedAltText);
});

denyReason.addEventListener("input", () => {
  setButtonsLoading(false);
});

cancelDenyBtn.addEventListener("click", () => {
  hideDenyPanel();
  setStatus("");
});

loadRelease();

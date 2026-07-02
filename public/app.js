let currentRelease = null;
let reviewerName = "";
let skippedReleaseIds = [];

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
const reviewerNameInput = document.getElementById("reviewerName");
const saveReviewerBtn = document.getElementById("saveReviewerBtn");
const reviewerHelp = document.getElementById("reviewerHelp");

const loadingDescription = "Loading generated description...";
const reviewerStorageKey = "vlm-reviewer-name";

function setStatus(message, type = "") {
  status.textContent = message;

  if (type) {
    status.dataset.type = type;
  } else {
    delete status.dataset.type;
  }
}

function normalizeReviewerName(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, 120);
}

function setReviewerHelp(message) {
  reviewerHelp.textContent = message;
}

function setReviewerName(nextReviewerName) {
  reviewerName = normalizeReviewerName(nextReviewerName);
  reviewerNameInput.value = reviewerName;

  try {
    if (reviewerName) {
      localStorage.setItem(reviewerStorageKey, reviewerName);
    } else {
      localStorage.removeItem(reviewerStorageKey);
    }
  } catch (err) {
    console.warn("Failed to persist reviewer name", err);
  }
}

function resetSkippedReleaseIds() {
  skippedReleaseIds = [];
}

function rememberSkippedReleaseId(releaseId) {
  if (!releaseId) {
    return;
  }

  if (!skippedReleaseIds.includes(releaseId)) {
    skippedReleaseIds.push(releaseId);
  }
}

function loadStoredReviewerName() {
  try {
    return normalizeReviewerName(localStorage.getItem(reviewerStorageKey) || "");
  } catch (err) {
    console.warn("Failed to read reviewer name", err);
    return "";
  }
}

function setButtonsLoading(isLoading) {
  const hasReviewer = reviewerName !== "";

  saveReviewerBtn.disabled = isLoading;
  reviewerNameInput.disabled = isLoading;
  skipBtn.disabled = isLoading || !hasReviewer;
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

function resetReleaseCard() {
  currentRelease = null;
  albumTitle.textContent = reviewerName
    ? "Album: Ready to load"
    : "Album: Waiting for reviewer";
  artistName.textContent = reviewerName
    ? "By: Press Load next to claim a release"
    : "By: Save your reviewer name to start";
  confidenceScore.textContent = reviewerName
    ? "Not loaded"
    : "Enter reviewer name";
  reviewTriggers.replaceChildren(Object.assign(document.createElement("li"), {
    textContent: reviewerName ? "No release loaded" : "Reviewer required"
  }));
  description.textContent = reviewerName
    ? "Claim a release to start reviewing."
    : "Enter your reviewer name before loading albums.";
  cover.removeAttribute("src");
  cover.alt = "";
  hideDenyPanel();
}

async function claimRelease(options = {}) {
  if (!reviewerName) {
    setStatus("Reviewer name is required before loading albums.", "error");
    reviewerNameInput.focus();
    return;
  }

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

  const requestBody = {
    reviewer: reviewerName
  };

  if (options.excludeReleaseIds?.length) {
    requestBody.excludeReleaseIds = options.excludeReleaseIds;
  }

  try {
    const res = await fetch("/api/releases/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    const payload = await res.json();

    if (!res.ok) {
      throw new Error(payload.error || `Request failed with status ${res.status}`);
    }

    const release = payload.release;

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
    resetReleaseCard();
    setStatus(err.message, "error");
  } finally {
    setButtonsLoading(false);
  }
}

async function releaseClaim() {
  if (!currentRelease || !reviewerName) {
    return;
  }

  const res = await fetch(
    `/api/release/${encodeURIComponent(currentRelease.id)}/release`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        reviewer: reviewerName
      })
    }
  );
  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || `Request failed with status ${res.status}`);
  }
}

cover.addEventListener("error", () => {
  if (!currentRelease) return;

  setStatus("Image failed to load. Check the cover_url value.", "error");
});

skipBtn.addEventListener("click", async () => {
  if (!reviewerName) {
    setStatus("Reviewer name is required before loading albums.", "error");
    reviewerNameInput.focus();
    return;
  }

  setButtonsLoading(true);
  setStatus(currentRelease ? "Releasing claim..." : "Loading next release...");

  try {
    const skippedReleaseId = currentRelease?.id || null;

    if (currentRelease) {
      rememberSkippedReleaseId(skippedReleaseId);
      await releaseClaim();
    }

    await claimRelease({ excludeReleaseIds: skippedReleaseIds });
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
    setButtonsLoading(false);
  }
});

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
          reviewer: reviewerName,
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
    await claimRelease();
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

saveReviewerBtn.addEventListener("click", async () => {
  const nextReviewerName = normalizeReviewerName(reviewerNameInput.value);

  if (!nextReviewerName) {
    setStatus("Reviewer name is required before loading albums.", "error");
    reviewerNameInput.focus();
    return;
  }

  const shouldSwitchReviewer = currentRelease && nextReviewerName !== reviewerName;

  setButtonsLoading(true);
  setStatus(shouldSwitchReviewer ? "Switching reviewer..." : "");

  try {
    if (shouldSwitchReviewer) {
      await releaseClaim();
    }

    resetSkippedReleaseIds();
    setReviewerName(nextReviewerName);
    setReviewerHelp(`Reviews will be saved as ${reviewerName}.`);
    setStatus("");
    resetReleaseCard();

    await claimRelease();
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
  } finally {
    setButtonsLoading(false);
  }
});

reviewerNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveReviewerBtn.click();
  }
});

setReviewerName(loadStoredReviewerName());
resetSkippedReleaseIds();

if (reviewerName) {
  setReviewerHelp(`Reviews will be saved as ${reviewerName}.`);
} else {
  setReviewerHelp("Enter your reviewer name before loading albums.");
}

resetReleaseCard();
setButtonsLoading(false);

if (reviewerName) {
  claimRelease();
}

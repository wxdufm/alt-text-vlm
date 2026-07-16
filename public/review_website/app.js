let currentRelease = null;
let reviewerName = "";
let skippedReleaseIds = [];
let reviewTriggerDefinitions = [];
let reviewerCountResetTimerId = null;
const ALT_TEXT_MAX_LENGTH = 130;

const cover = document.getElementById("cover");
const albumTitle = document.getElementById("albumTitle");
const artistName = document.getElementById("artistName");
const confidenceScore = document.getElementById("confidenceScore");
const reviewTriggers = document.getElementById("reviewTriggers");
const confidenceExplanation = document.getElementById("confidenceExplanation");
const description = document.getElementById("description");
const status = document.getElementById("status");
const skipBtn = document.getElementById("skipBtn");
const approveBtn = document.getElementById("approveBtn");
const denyBtn = document.getElementById("denyBtn");
const denyPanel = document.getElementById("denyPanel");
const denyReason = document.getElementById("denyReason");
const denyReasonCount = document.getElementById("denyReasonCount");
const denyConfidence = document.getElementById("denyConfidence");
const denyConfidenceExplanation = document.getElementById(
  "denyConfidenceExplanation"
);
const denyTriggerOptions = document.getElementById("denyTriggerOptions");
const denyTriggers = document.getElementById("denyTriggers");
const newTriggerName = document.getElementById("newTriggerName");
const newTriggerDescription = document.getElementById("newTriggerDescription");
const addTriggerBtn = document.getElementById("addTriggerBtn");
const confirmDenyBtn = document.getElementById("confirmDenyBtn");
const cancelDenyBtn = document.getElementById("cancelDenyBtn");
const reviewerNameInput = document.getElementById("reviewerName");
const saveReviewerBtn = document.getElementById("saveReviewerBtn");
const reviewerHelp = document.getElementById("reviewerHelp");
const humanReviewedCount = document.getElementById("humanReviewedCount");
const reviewerDailyCount = document.getElementById("reviewerDailyCount");

const loadingDescription = "Loading generated description...";
const reviewerStorageKey = "vlm-reviewer-name";
const reviewCounterStoragePrefix = "vlm-review-count";

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

function normalizeTriggerName(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function clampAltText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.slice(0, ALT_TEXT_MAX_LENGTH);
}

function getLocalDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getReviewerDailyCountStorageKey(name = reviewerName) {
  const normalizedName = normalizeReviewerName(name);

  if (!normalizedName) {
    return null;
  }

  return `${reviewCounterStoragePrefix}:${getLocalDateKey()}:${normalizedName}`;
}

function getMillisecondsUntilNextLocalMidnight() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  return Math.max(1000, nextMidnight.getTime() - now.getTime());
}

function readReviewerDailyCount(name = reviewerName) {
  const storageKey = getReviewerDailyCountStorageKey(name);

  if (!storageKey) {
    return 0;
  }

  try {
    const value = Number(localStorage.getItem(storageKey) || "0");
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch (err) {
    console.warn("Failed to read reviewer daily count", err);
    return 0;
  }
}

function writeReviewerDailyCount(nextCount, name = reviewerName) {
  const storageKey = getReviewerDailyCountStorageKey(name);

  if (!storageKey) {
    return;
  }

  try {
    localStorage.setItem(storageKey, String(Math.max(0, nextCount)));
  } catch (err) {
    console.warn("Failed to persist reviewer daily count", err);
  }
}

function incrementReviewerDailyCount(name = reviewerName) {
  const nextCount = readReviewerDailyCount(name) + 1;
  writeReviewerDailyCount(nextCount, name);
  renderReviewerDailyCount(name);
}

function renderReviewerDailyCount(name = reviewerName) {
  reviewerDailyCount.textContent = String(readReviewerDailyCount(name));
}

function scheduleReviewerDailyCountReset() {
  if (reviewerCountResetTimerId !== null) {
    clearTimeout(reviewerCountResetTimerId);
  }

  reviewerCountResetTimerId = window.setTimeout(() => {
    renderReviewerDailyCount();
    scheduleReviewerDailyCountReset();
  }, getMillisecondsUntilNextLocalMidnight());
}

function renderHumanReviewedCount(approvedCount, totalCount) {
  if (
    approvedCount === null ||
    approvedCount === undefined ||
    approvedCount === "" ||
    totalCount === null ||
    totalCount === undefined ||
    totalCount === ""
  ) {
    humanReviewedCount.textContent = "0";
    return;
  }

  const approvedNumericValue = Number(approvedCount);
  const totalNumericValue = Number(totalCount);

  humanReviewedCount.textContent =
    Number.isFinite(approvedNumericValue) && Number.isFinite(totalNumericValue)
      ? `${approvedNumericValue} / ${totalNumericValue}`
      : "0 / 0";
}

function syncDenyReasonField() {
  const clampedValue = clampAltText(denyReason.value);

  if (denyReason.value !== clampedValue) {
    denyReason.value = clampedValue;
  }

  denyReasonCount.textContent = `${denyReason.value.length} / ${ALT_TEXT_MAX_LENGTH}`;
}

function setReviewerHelp(message) {
  reviewerHelp.textContent = message;
}

function setReviewerName(nextReviewerName) {
  reviewerName = normalizeReviewerName(nextReviewerName);
  reviewerNameInput.value = reviewerName;
  renderReviewerDailyCount(reviewerName);

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
  const denyHasAltText = denyReason.value.trim() !== "";

  saveReviewerBtn.disabled = isLoading;
  reviewerNameInput.disabled = isLoading;
  skipBtn.disabled = isLoading || !hasReviewer;
  approveBtn.disabled = isLoading || !currentRelease;
  denyBtn.disabled = isLoading || !currentRelease;
  confirmDenyBtn.disabled =
    isLoading ||
    !currentRelease ||
    (!denyPanel.hidden && !denyHasAltText);
  cancelDenyBtn.disabled = isLoading;
  addTriggerBtn.disabled = isLoading;
  newTriggerName.disabled = isLoading;
  newTriggerDescription.disabled = isLoading;

  for (const input of denyTriggerOptions.querySelectorAll("input")) {
    input.disabled = isLoading;
  }
}

function createListPlaceholder(message) {
  const item = document.createElement("li");
  item.textContent = message;
  return item;
}

function hideDenyPanel() {
  denyPanel.hidden = true;
  denyReason.value = "";
  syncDenyReasonField();
  denyConfidence.value = "";
  denyConfidenceExplanation.value = "";
  newTriggerName.value = "";
  newTriggerDescription.value = "";
  renderTriggerOptions([]);
  syncSelectedTriggersOutput();
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
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeTriggerName(String(item)))
      .filter(Boolean);
  }

  return [normalizeTriggerName(String(value))].filter(Boolean);
}

function getTriggerDescription(trigger) {
  const definition = reviewTriggerDefinitions.find(
    (item) => item.trigger === trigger
  );

  return definition?.trigger_description || null;
}

function createTriggerDescriptionDetails(trigger) {
  const triggerDescription = getTriggerDescription(trigger);

  if (!triggerDescription) {
    return null;
  }

  const details = document.createElement("details");
  details.className = "trigger-details";

  const summary = document.createElement("summary");
  summary.textContent = "What this means";
  details.append(summary);

  const body = document.createElement("p");
  body.textContent = triggerDescription;
  details.append(body);

  return details;
}

function renderReviewTriggers(value) {
  const triggers = normalizeReviewTriggers(value);
  reviewTriggers.replaceChildren();

  if (triggers.length === 0) {
    reviewTriggers.append(createListPlaceholder("None"));
    return;
  }

  for (const trigger of triggers) {
    const item = document.createElement("li");
    item.className = "trigger-list-item";

    const name = document.createElement("span");
    name.className = "trigger-name";
    name.textContent = trigger;
    item.append(name);

    const details = createTriggerDescriptionDetails(trigger);

    if (details) {
      item.append(details);
    }

    reviewTriggers.append(item);
  }
}

function renderConfidenceExplanation(value) {
  confidenceExplanation.textContent =
    normalizeOptionalText(value) || "None";
}

function formatEditableConfidence(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "";
  }

  return String(numericValue);
}

function getSelectedTriggerValues() {
  return Array.from(
    denyTriggerOptions.querySelectorAll('input[name="denyReviewTrigger"]:checked')
  )
    .map((input) => normalizeTriggerName(input.value))
    .filter(Boolean);
}

function syncSelectedTriggersOutput() {
  denyTriggers.value = getSelectedTriggerValues().join("\n");
}

function renderTriggerOptions(selectedTriggers) {
  const selected = new Set(selectedTriggers);
  denyTriggerOptions.replaceChildren();

  if (reviewTriggerDefinitions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "trigger-options-empty";
    empty.textContent = "No review triggers are available yet.";
    denyTriggerOptions.append(empty);
    syncSelectedTriggersOutput();
    return;
  }

  for (const definition of reviewTriggerDefinitions) {
    const option = document.createElement("label");
    option.className = "trigger-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "denyReviewTrigger";
    checkbox.value = definition.trigger;
    checkbox.checked = selected.has(definition.trigger);
    checkbox.addEventListener("change", () => {
      syncSelectedTriggersOutput();
      setButtonsLoading(false);
    });
    option.append(checkbox);

    const content = document.createElement("div");
    content.className = "trigger-option-copy";

    const title = document.createElement("span");
    title.className = "trigger-option-title";
    title.textContent = definition.trigger;
    content.append(title);

    const details = createTriggerDescriptionDetails(definition.trigger);

    if (details) {
      content.append(details);
    }

    option.append(content);
    denyTriggerOptions.append(option);
  }

  syncSelectedTriggersOutput();
}

function parseEditedConfidence() {
  const rawValue = denyConfidence.value.trim();

  if (rawValue === "") {
    return null;
  }

  const numericValue = Number(rawValue);

  if (!Number.isFinite(numericValue) || ![0, 1].includes(numericValue)) {
    throw new Error("Confidence score must be 0 or 1.");
  }

  return numericValue;
}

function parseEditedConfidenceExplanation() {
  return normalizeOptionalText(denyConfidenceExplanation.value);
}

function parseEditedReviewTriggers() {
  const selectedTriggers = getSelectedTriggerValues();
  return selectedTriggers.length > 0 ? selectedTriggers : null;
}

function resetReleaseCard() {
  currentRelease = null;
  albumTitle.textContent = reviewerName
    ? "Album: Ready to load"
    : "Album: Waiting for reviewer";
  artistName.textContent = reviewerName
    ? "By: Press Skip to claim a release"
    : "By: Save your reviewer name to start";
  confidenceScore.textContent = reviewerName
    ? "Not loaded"
    : "Enter reviewer name";
  renderReviewTriggers([]);
  renderConfidenceExplanation(reviewerName ? null : "Reviewer required");
  description.textContent = reviewerName
    ? "Claim a release to start reviewing."
    : "Enter your reviewer name before loading albums.";
  cover.removeAttribute("src");
  cover.alt = "";
  hideDenyPanel();
}

async function loadReviewTriggerDefinitions() {
  const res = await fetch("/api/review-trigger-definitions");
  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || `Request failed with status ${res.status}`);
  }

  reviewTriggerDefinitions = Array.isArray(payload.definitions)
    ? payload.definitions
    : [];
}

async function loadAppStats() {
  const res = await fetch("/api/stats");
  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.error || `Request failed with status ${res.status}`);
  }

  renderHumanReviewedCount(payload.humanReviewedCount, payload.totalCoversCount);
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
  reviewTriggers.replaceChildren(createListPlaceholder("Loading..."));
  renderConfidenceExplanation("Loading...");
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

    if (
      payload.humanReviewedCount !== undefined &&
      payload.totalCoversCount !== undefined
    ) {
      renderHumanReviewedCount(
        payload.humanReviewedCount,
        payload.totalCoversCount
      );
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
    renderConfidenceExplanation(release.confidence_explanation);
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
  if (!currentRelease) {
    return;
  }

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

async function saveReview(
  approved,
  correctedAltText = "",
  correctedConfidence = undefined,
  correctedConfidenceExplanation = undefined,
  correctedReviewTriggers = undefined
) {
  if (!currentRelease) {
    return;
  }

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
          correctedAltText,
          correctedConfidence,
          correctedConfidenceExplanation,
          correctedReviewTriggers
        })
      }
    );
    const payload = await res.json();

    if (!res.ok) {
      throw new Error(payload.error || `Request failed with status ${res.status}`);
    }

    incrementReviewerDailyCount(reviewerName);

    if (
      payload.humanReviewedCount !== undefined &&
      payload.totalCoversCount !== undefined
    ) {
      renderHumanReviewedCount(
        payload.humanReviewedCount,
        payload.totalCoversCount
      );
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
  if (!currentRelease) {
    return;
  }

  hideDenyPanel();
  await saveReview(true);
});

denyBtn.addEventListener("click", () => {
  if (!currentRelease) {
    return;
  }

  denyPanel.hidden = false;
  syncDenyReasonField();
  denyConfidence.value = formatEditableConfidence(currentRelease.confidence);
  denyConfidenceExplanation.value =
    normalizeOptionalText(currentRelease.confidence_explanation) || "";
  renderTriggerOptions(normalizeReviewTriggers(currentRelease.review_triggers));
  denyReason.focus();
  setStatus("");
  setButtonsLoading(false);
});

confirmDenyBtn.addEventListener("click", async () => {
  if (!currentRelease) {
    return;
  }

  const correctedAltText = denyReason.value.trim();

  if (correctedAltText === "") {
    setStatus("Corrected alt text is required.", "error");
    denyReason.focus();
    setButtonsLoading(false);
    return;
  }

  let correctedConfidence;
  let correctedConfidenceExplanation;
  let correctedReviewTriggers;

  try {
    correctedConfidence = parseEditedConfidence();
    correctedConfidenceExplanation = parseEditedConfidenceExplanation();
    correctedReviewTriggers = parseEditedReviewTriggers();
  } catch (err) {
    setStatus(err.message, "error");
    setButtonsLoading(false);
    return;
  }

  await saveReview(
    false,
    correctedAltText,
    correctedConfidence,
    correctedConfidenceExplanation,
    correctedReviewTriggers
  );
});

async function addReviewTriggerDefinition() {
  const trigger = normalizeTriggerName(newTriggerName.value);
  const triggerDescription = normalizeOptionalText(newTriggerDescription.value);

  if (!trigger) {
    setStatus("New trigger name is required.", "error");
    newTriggerName.focus();
    return;
  }

  if (!triggerDescription) {
    setStatus("New trigger description is required.", "error");
    newTriggerDescription.focus();
    return;
  }

  setButtonsLoading(true);
  setStatus("Adding trigger...");

  try {
    const res = await fetch("/api/review-trigger-definitions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        trigger,
        triggerDescription
      })
    });
    const payload = await res.json();

    if (!res.ok) {
      throw new Error(payload.error || `Request failed with status ${res.status}`);
    }

    reviewTriggerDefinitions = [...reviewTriggerDefinitions, payload.definition]
      .sort((left, right) => left.trigger.localeCompare(right.trigger));
    const selectedTriggers = getSelectedTriggerValues();
    selectedTriggers.push(payload.definition.trigger);
    renderTriggerOptions(selectedTriggers);
    newTriggerName.value = "";
    newTriggerDescription.value = "";
    setStatus(`Added trigger "${payload.definition.trigger}".`);
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
  } finally {
    setButtonsLoading(false);
  }
}

addTriggerBtn.addEventListener("click", async () => {
  await addReviewTriggerDefinition();
});

denyReason.addEventListener("input", () => {
  syncDenyReasonField();
  setButtonsLoading(false);
});

denyConfidence.addEventListener("input", () => {
  setButtonsLoading(false);
});

denyConfidenceExplanation.addEventListener("input", () => {
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

newTriggerName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addTriggerBtn.click();
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
renderReviewerDailyCount();
renderHumanReviewedCount(0, 0);
syncDenyReasonField();
scheduleReviewerDailyCountReset();
setButtonsLoading(false);

(async () => {
  try {
    await loadAppStats();
    await loadReviewTriggerDefinitions();

    if (reviewerName) {
      await claimRelease();
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
  }
})();

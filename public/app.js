let currentRelease = null;

const cover = document.getElementById("cover");
const albumTitle = document.getElementById("albumTitle");
const description = document.getElementById("description");
const status = document.getElementById("status");
const nextBtn = document.getElementById("nextBtn");
const approveBtn = document.getElementById("approveBtn");
const denyBtn = document.getElementById("denyBtn");
const denyPanel = document.getElementById("denyPanel");
const denyReason = document.getElementById("denyReason");
const confirmDenyBtn = document.getElementById("confirmDenyBtn");

const placeholderDescription =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

function setStatus(message, type = "") {
  status.textContent = message;
  status.dataset.type = type;
}

function setButtonsLoading(isLoading) {
  nextBtn.disabled = isLoading;
  approveBtn.disabled = isLoading || !currentRelease;
  denyBtn.disabled = isLoading || !currentRelease;
  confirmDenyBtn.disabled = isLoading || !currentRelease;
}

function hideDenyPanel() {
  denyPanel.hidden = true;
  denyReason.value = "";
}

async function loadRelease() {
  currentRelease = null;
  albumTitle.textContent = "Loading...";
  description.textContent = placeholderDescription;
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

    console.log(release);

    cover.src = release.cover_url;
    cover.alt = `Album cover for ${
      release.title ||
      release.album ||
      "unknown album"
    }`;

    albumTitle.textContent =
      release.title ||
      release.album ||
      "Unknown Album";

    description.textContent = placeholderDescription;
    setStatus("");
  } catch (err) {
    console.error(err);
    albumTitle.textContent = "No release loaded";
    setStatus(err.message, "error");
  } finally {
    setButtonsLoading(false);
  }
}

cover.addEventListener("error", () => {
  if (!currentRelease) return;

  setStatus("Image failed to load. Check the cover_url value.", "error");
});

nextBtn.addEventListener("click", loadRelease);

approveBtn.addEventListener("click", () => {
  if (!currentRelease) return;

  hideDenyPanel();
  setStatus(`Approved ${currentRelease._id}`);
});

denyBtn.addEventListener("click", () => {
  if (!currentRelease) return;

  denyPanel.hidden = false;
  denyReason.focus();
  setStatus("");
});

confirmDenyBtn.addEventListener("click", () => {
  if (!currentRelease) return;

  const note = denyReason.value.trim();
  hideDenyPanel();
  setStatus(note ? `Denied ${currentRelease._id} with notes` : `Denied ${currentRelease._id}`);
});

loadRelease();

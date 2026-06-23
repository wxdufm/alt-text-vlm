let currentRelease = null;

const cover = document.getElementById("cover");
const albumTitle = document.getElementById("albumTitle");
const artistName = document.getElementById("artistName");
const description = document.getElementById("description");
const status = document.getElementById("status");
const skipBtn = document.getElementById("skipBtn");
const approveBtn = document.getElementById("approveBtn");
const denyBtn = document.getElementById("denyBtn");
const denyPanel = document.getElementById("denyPanel");
const denyReason = document.getElementById("denyReason");
const confirmDenyBtn = document.getElementById("confirmDenyBtn");
const cancelDenyBtn = document.getElementById("cancelDenyBtn");

const placeholderDescription =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

function setStatus(message, type = "") {
  status.textContent = message;
  status.dataset.type = type;
}

function setButtonsLoading(isLoading) {
  skipBtn.disabled = isLoading;
  approveBtn.disabled = isLoading || !currentRelease;
  denyBtn.disabled = isLoading || !currentRelease;
  confirmDenyBtn.disabled = isLoading || !currentRelease;
  cancelDenyBtn.disabled = isLoading;
}

function hideDenyPanel() {
  denyPanel.hidden = true;
  denyReason.value = "";
}

async function loadRelease() {
  currentRelease = null;
  albumTitle.textContent = "Album: Loading...";
  artistName.textContent = "By: Loading...";
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

    albumTitle.textContent = `Album: ${
      release.title ||
      release.album ||
      "Unknown Album"
    }`;
    artistName.textContent = `By: ${
      release.artist ||
      "Unknown Artist"
    }`;

    description.textContent = placeholderDescription;
    setStatus("");
  } catch (err) {
    console.error(err);
    albumTitle.textContent = "Album: No release loaded";
    artistName.textContent = "By: Unknown Artist";
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

approveBtn.addEventListener("click", async () => {
  if (!currentRelease) return;

  hideDenyPanel();
  await loadRelease();
});

denyBtn.addEventListener("click", () => {
  if (!currentRelease) return;

  denyPanel.hidden = false;
  denyReason.focus();
  setStatus("");
});

confirmDenyBtn.addEventListener("click", () => {
  if (!currentRelease) return;

  const denialNote = denyReason.value.trim();
  console.log({
    releaseId: currentRelease._id,
    denialNote
  });
  hideDenyPanel();
  loadRelease();
});

cancelDenyBtn.addEventListener("click", () => {
  hideDenyPanel();
  setStatus("");
});

loadRelease();

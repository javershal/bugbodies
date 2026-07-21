// Popup: pick a company + Start/Stop. All recording state lives in the worker,
// so the popup just reflects it (GET_STATE) and can be closed mid-interview.

const NEW_COMPANY = "__new__";

const idleView = document.getElementById("idleView");
const recordingView = document.getElementById("recordingView");
const companySelect = document.getElementById("companySelect");
const companyNew = document.getElementById("companyNew");
const toggle = document.getElementById("toggle");
const elapsedEl = document.getElementById("elapsed");
const recCompanyEl = document.getElementById("recCompany");
const statusEl = document.getElementById("status");
const meetingsLink = document.getElementById("meetingsLink");

let elapsedTimer = null;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("err", isError);
}

async function micState() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {
    return "prompt";
  }
}

async function helperBase() {
  const res = await chrome.runtime.sendMessage({ type: "GET_HELPER_BASE" });
  return res?.base || "http://localhost:8137";
}

// ---------- company dropdown ----------
async function loadCompanies() {
  let companies = [];
  try {
    const base = await helperBase();
    const res = await fetch(`${base}/meetings`);
    if (res.ok) companies = (await res.json()).companies || [];
  } catch {
    setStatus("Helper offline — you can still record (saved to Downloads).");
  }
  const { lastCompany } = await chrome.storage.local.get("lastCompany");

  companySelect.innerHTML = "";
  for (const c of companies) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    companySelect.appendChild(opt);
  }
  const newOpt = document.createElement("option");
  newOpt.value = NEW_COMPANY;
  newOpt.textContent = "+ New company…";
  companySelect.appendChild(newOpt);

  if (lastCompany && companies.includes(lastCompany)) {
    companySelect.value = lastCompany;
  } else if (companies.length === 0) {
    companySelect.value = NEW_COMPANY;
  }
  syncNewField();
}

function syncNewField() {
  companyNew.classList.toggle("hidden", companySelect.value !== NEW_COMPANY);
}

function chosenCompany() {
  return companySelect.value === NEW_COMPANY
    ? companyNew.value.trim()
    : companySelect.value;
}

companySelect.addEventListener("change", syncNewField);

// ---------- elapsed timer ----------
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const p = (n) => String(n).padStart(2, "0");
  return m >= 60
    ? `${p(Math.floor(m / 60))}:${p(m % 60)}:${p(s % 60)}`
    : `${p(m)}:${p(s % 60)}`;
}
function startTimer(startedAt) {
  const tick = () => (elapsedEl.textContent = fmt(Date.now() - startedAt));
  tick();
  elapsedTimer = setInterval(tick, 1000);
}
function stopTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

// ---------- render current state ----------
function renderIdle() {
  stopTimer();
  idleView.classList.remove("hidden");
  recordingView.classList.add("hidden");
  toggle.textContent = "Start recording";
  toggle.className = "idle";
  toggle.disabled = false;
}
function renderRecording(state) {
  idleView.classList.add("hidden");
  recordingView.classList.remove("hidden");
  recCompanyEl.textContent =
    state.company + (state.helperDown ? "  (helper offline — will save to Downloads)" : "");
  toggle.textContent = "Stop recording";
  toggle.className = "recording";
  toggle.disabled = false;
  startTimer(state.startedAt);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (state?.status === "recording") {
    renderRecording(state);
  } else {
    renderIdle();
    await loadCompanies();
  }
}

// ---------- start / stop ----------
toggle.addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });

  if (state?.status === "recording") {
    toggle.disabled = true;
    setStatus("Stopping and saving…");
    const res = await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
    if (res && res.ok === false) return setStatus("Stop failed: " + res.error, true);
    setStatus("Saved. You can process it from the meetings page.");
    setTimeout(() => window.close(), 800);
    return;
  }

  // Starting.
  const company = chosenCompany();
  if (!company) return setStatus("Pick or type a company first.", true);

  // Mic must be granted from a real tab, not the popup (Phase 0 gotcha #1).
  if ((await micState()) !== "granted") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
    setStatus("Microphone not granted. Click Allow in the new tab, close it, then Start again.");
    return;
  }

  toggle.disabled = true;
  setStatus("Starting… keep the meeting tab active. You'll still hear it.");
  await chrome.storage.local.set({ lastCompany: company });
  const res = await chrome.runtime.sendMessage({ type: "START_RECORDING", company });
  if (res && res.ok === false) {
    toggle.disabled = false;
    return setStatus("Failed: " + res.error, true);
  }
  await refresh();
  setStatus("Recording. You can close this popup — it won't stop.");
});

meetingsLink.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("meetings.html") });
});

refresh();

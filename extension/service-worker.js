// MV3 service worker: orchestration + owner of recording STATE. Recording
// itself happens in the offscreen document (workers have no MediaRecorder), but
// the authoritative "are we recording?" state lives here, persisted to
// chrome.storage.session so it survives worker restarts and popup closes.
// (Spec §6.1: closing the popup mid-interview must NOT stop recording.)

const OFFSCREEN_URL = "offscreen.html";
const DEFAULT_HELPER_BASE = "http://localhost:8137";
const STATE_KEY = "recState";

// ---------- helper base URL (configurable via storage) ----------
async function helperBase() {
  const { helperBase } = await chrome.storage.local.get("helperBase");
  return helperBase || DEFAULT_HELPER_BASE;
}

// ---------- recording state ----------
async function getState() {
  const { [STATE_KEY]: s } = await chrome.storage.session.get(STATE_KEY);
  return s || { status: "idle" };
}
async function setState(s) {
  await chrome.storage.session.set({ [STATE_KEY]: s });
}
async function clearState() {
  await chrome.storage.session.remove(STATE_KEY);
}

// ---------- offscreen doc lifecycle ----------
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Record tab + mic audio for interview notes.",
  });
}
async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) {
    await chrome.offscreen.closeDocument();
  }
}

// ---------- start ----------
async function startRecording(company) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");
  if (/^(chrome|brave|edge|about|chrome-extension):/.test(tab.url || "")) {
    throw new Error("Active tab is a restricted page. Use a normal http(s) tab.");
  }

  const startedAt = Date.now();
  const base = await helperBase();

  // Ask the helper to create the meeting folder up front. If it's down, we
  // still record — Stop will fall back to chrome.downloads (spec §6.1).
  let meetingId = null;
  let helperDown = false;
  try {
    const res = await fetch(`${base}/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, started_at: startedAt }),
    });
    if (!res.ok) throw new Error(`helper ${res.status}`);
    meetingId = (await res.json()).id;
  } catch (_e) {
    helperDown = true;
  }

  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_START",
    streamId,
    meetingId,
    company,
    startedAt,
    helperBase: base,
  });

  await setState({
    status: "recording",
    meetingId,
    company,
    startedAt,
    helperBase: base,
    helperDown,
    tabId: tab.id,
  });
}

// ---------- stop ----------
async function stopRecording() {
  const s = await getState();
  if (s.status !== "recording") return;
  // Offscreen finalizes the blobs and POSTs them to the helper, then reports
  // back via TRACKS_SAVED or TRACKS_FALLBACK. Keep state until it confirms.
  await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" });
}

// ---------- fallback download (helper unreachable) ----------
function dateFolder(startedAt) {
  const d = new Date(startedAt);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function safeCompany(company) {
  return (company || "Unknown").replace(/[\/\\]+/g, " ").trim() || "Unknown";
}

async function saveFallback(msg) {
  const folder = `bugbodies/${safeCompany(msg.company)}/${dateFolder(msg.startedAt)}`;
  const dl = (url, name) =>
    chrome.downloads.download({ url, filename: `${folder}/${name}` });
  await dl(msg.micUrl, "mic.webm");
  await dl(msg.tabUrl, "tab.webm");
  await dl(msg.metaUrl, "meta.json");
}

// ---------- message routing ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg?.type;

  if (type === "GET_STATE") {
    getState().then(sendResponse);
    return true;
  }
  if (type === "START_RECORDING") {
    startRecording(msg.company)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (type === "STOP_RECORDING") {
    stopRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (type === "GET_HELPER_BASE") {
    helperBase().then((base) => sendResponse({ base }));
    return true;
  }

  // ----- messages from the offscreen document -----
  if (type === "TRACKS_SAVED") {
    // Helper accepted the upload. Done.
    clearState()
      .then(closeOffscreen)
      .then(() => sendResponse?.({ ok: true }));
    return true;
  }
  if (type === "TRACKS_FALLBACK") {
    // Helper was unreachable; download the blobs locally instead.
    saveFallback(msg)
      .then(() => sendResponse?.({ ok: true }))
      .catch((err) => sendResponse?.({ ok: false, error: err?.message }))
      .finally(() => {
        clearState().then(closeOffscreen);
      });
    return true;
  }
});

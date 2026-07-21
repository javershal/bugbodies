// The offscreen document does the real recording: acquire both audio sources,
// record each into its own MediaRecorder, and on stop POST both finished .webm
// blobs straight to the local helper (spec §7 — replaces the Phase 0 data-URL
// hop, which can't carry a 45-minute file). If the helper is unreachable, hand
// the blobs to the worker as object URLs for a chrome.downloads fallback (§6.1).

let session = null; // { meetingId, company, startedAt, helperBase, recorders... }

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "OFFSCREEN_START") {
    start(msg).catch((err) => console.error("[offscreen] start failed:", err));
  } else if (msg?.type === "OFFSCREEN_STOP") {
    stop().catch((err) => console.error("[offscreen] stop failed:", err));
  }
});

async function start({ streamId, meetingId, company, startedAt, helperBase }) {
  // --- Tab audio (remote participants) ---
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });

  // Consuming the tab stream diverts it from the speakers, muting the tab.
  // Route it back through an AudioContext so the meeting stays audible.
  // (Do NOT do this for the mic — it would echo.)
  const audioContext = new AudioContext();
  audioContext.createMediaStreamSource(tabStream).connect(audioContext.destination);

  // --- Microphone (your voice) --- permission already granted from a real tab.
  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const tab = makeRecorder(tabStream);
  const mic = makeRecorder(micStream);

  session = { meetingId, company, startedAt, helperBase, audioContext, tab, mic };

  // Record each recorder's real wall-clock start so any offset between the two
  // can be corrected at merge time (spec §5).
  mic.startedAt = Date.now();
  mic.recorder.start(1000);
  tab.startedAt = Date.now();
  tab.recorder.start(1000);
}

function makeRecorder(stream) {
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  return { recorder, chunks, stream, startedAt: null };
}

function finalize(r) {
  return new Promise((resolve) => {
    r.recorder.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(r.chunks, { type: "audio/webm" }));
    };
    if (r.recorder.state !== "inactive") r.recorder.stop();
    else resolve(new Blob(r.chunks, { type: "audio/webm" }));
  });
}

async function stop() {
  if (!session) return;
  const s = session;
  session = null;

  const [micBlob, tabBlob] = await Promise.all([finalize(s.mic), finalize(s.tab)]);

  if (s.audioContext) await s.audioContext.close().catch(() => {});

  const durationSec = (Date.now() - Math.min(s.mic.startedAt, s.tab.startedAt)) / 1000;
  const micStartedIso = new Date(s.mic.startedAt).toISOString();
  const tabStartedIso = new Date(s.tab.startedAt).toISOString();

  // Preferred path: POST straight to the helper.
  if (s.meetingId) {
    try {
      const form = new FormData();
      form.append("mic", micBlob, "mic.webm");
      form.append("tab", tabBlob, "tab.webm");
      form.append("mic_started_at", micStartedIso);
      form.append("tab_started_at", tabStartedIso);
      form.append("duration_sec", String(durationSec));
      const res = await fetch(
        `${s.helperBase}/meetings/${encodeURIComponent(s.meetingId)}/tracks`,
        { method: "POST", body: form }
      );
      if (!res.ok) throw new Error(`helper ${res.status}`);
      await chrome.runtime.sendMessage({ type: "TRACKS_SAVED", meetingId: s.meetingId });
      return;
    } catch (err) {
      console.warn("[offscreen] helper upload failed, falling back:", err);
    }
  }

  // Fallback: helper unreachable. Hand blobs to the worker as object URLs so it
  // can chrome.downloads them into bugbodies/<Company>/<Date>/.
  const meta = {
    company: s.company,
    started_at: new Date(s.startedAt).toISOString(),
    mic_started_at: micStartedIso,
    tab_started_at: tabStartedIso,
    duration_sec: durationSec,
    status: "recorded",
    note: "Saved locally because the helper was unreachable. Import with: helper import <folder>",
  };
  const metaUrl = URL.createObjectURL(
    new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" })
  );
  await chrome.runtime.sendMessage({
    type: "TRACKS_FALLBACK",
    company: s.company,
    startedAt: s.startedAt,
    micUrl: URL.createObjectURL(micBlob),
    tabUrl: URL.createObjectURL(tabBlob),
    metaUrl,
  });
  // The worker closes this document once downloads finish, which revokes the URLs.
}

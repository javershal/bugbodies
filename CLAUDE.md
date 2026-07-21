# bugbodies — personal interview note-taker

Personal AI note-taker that records browser-based job interviews (Zoom/Meet/Teams web)
for later **local** Whisper transcription + hand summarization in a Claude project. Personal use
only — extension loaded unpacked in developer mode, never published. Runs on **Brave**
(Chromium 150) on Ubuntu 20.04.

Tab audio (remote participants) and mic (my voice) are recorded as **separate tracks**, then
transcribed separately and merged by timestamp → clean **You** / **Interviewer** labels for free
(no diarization).

## Status / progress

- **Phase 0 — DONE.** Proved both capture paths (tab + mic → two `.webm`).
- **Phase 1 (full build) — DONE, built per `bugbodies-build-spec.md`.** Two components now:
  the MV3 extension (records + UI) and a local Python helper (owns files, transcribes, serves).
  - Helper: config/store/pipeline/app/cli all built and **verified** — HTTP endpoints via
    TestClient (create → upload → list → detail → reassign), and the real transcription pipeline
    (ffmpeg + faster-whisper + VAD + merge → `transcript.json`/`.txt`) on `phase0-tab.webm` with
    `tiny.en`. `import` CLI verified.
  - Extension: manifest, worker (recording-state owner), offscreen (blob POST + fallback), popup
    (Start/Stop + company picker), meetings page, transcript page — all written.
- **Remaining / untested end-to-end:** live browser run (record a real tab in Brave), the helper
  fallback download path, and a full `medium.en` run (only `tiny.en` was used for the smoke test
  to avoid the 1.5 GB pull). See "Verify end-to-end" below.

## Repo layout

```
extension/     ← load unpacked from HERE (manifest.json + all extension files)
  manifest.json  service-worker.js  offscreen.html/.js  popup.html/.js
  permission.html/.js  meetings.html/.js  transcript.html/.js
helper/        ← uv project (Python 3.12)
  pyproject.toml  .python-version  README.md
  bugbodies_helper/  config.py store.py pipeline.py app.py cli.py __main__.py
recordings/    ← default BUGBODIES_ROOT, the browsable Company/Date/ tree (gitignored)
claude-project-prompt.md   bugbodies-build-spec.md   CLAUDE.md   .gitignore
```

## Architecture (two components over http://localhost)

**Extension** (MV3, vanilla JS). MV3 workers can't record (no `MediaRecorder`/`AudioContext`),
so recording lives in an **offscreen document**; the worker orchestrates and owns recording state.

```
popup.html/.js       company picker + Start/Stop; reflects worker state; opens meetings page
permission.html/.js  full tab that requests mic permission (a popup can't — gotcha #1)
service-worker.js    OWNS recording state (chrome.storage.session); creates meeting on helper,
                     getMediaStreamId, offscreen lifecycle, fallback chrome.downloads
offscreen.html/.js   2 getUserMedia + 2 MediaRecorders; tab AudioContext re-route; POSTs blobs
meetings.html/.js    grouped list + status polling; Process / View / Export / Reassign
transcript.html/.js  merged transcript, You vs Interviewer visually distinct
```

**Helper** (Python, FastAPI + uvicorn + faster-whisper + ffmpeg). Single source of truth. Owns
`<root>/<Company>/<YYYY-MM-DD_HHMMSS>/` with `mic.webm tab.webm meta.json transcript.json/.txt`.
Endpoints: `POST /meetings`, `POST /meetings/{id}/tracks`, `POST /meetings/{id}/process`,
`GET /meetings`, `GET /meetings/{id}`, `GET /meetings/{id}/transcript.txt` (attachment),
`PATCH /meetings/{id}` (reassign = move folder), `GET /health`. CLI: `serve`/`process`/`import`.
See `helper/README.md`.

**Record flow:** popup `START_RECORDING {company}` → worker `POST /meetings` (gets id; if helper
down, marks `helperDown` and still records) → `getMediaStreamId` → offscreen `OFFSCREEN_START`
records both tracks (wall-clock start of each recorder saved for offset correction) → popup
`STOP_RECORDING` → worker `OFFSCREEN_STOP` → offscreen `POST /meetings/{id}/tracks` (multipart)
→ on success `TRACKS_SAVED`; on helper failure `TRACKS_FALLBACK` (object URLs → worker
`chrome.downloads` into `bugbodies/<Company>/<Date>/`).

**Transcription (spec §5):** tracks are NOT mixed. mic→You, tab→Interviewer, each transcribed with
`vad_filter=True` + no-speech/log-prob thresholds (stops silent-track hallucination), merged by
timestamp with the per-track offset applied. `pipeline.py`.

## Hard-won gotchas (don't relearn these)

1. **Mic permission must be granted from a real tab, not the popup** — the prompt steals focus
   and closes the popup, aborting `getUserMedia`. `permission.html` holds it; the grant then
   persists for the extension origin so the offscreen doc acquires the mic silently. Popup checks
   `navigator.permissions.query({name:"microphone"})` first.
2. **Capturing tab audio mutes the tab** unless the tab `MediaStream` is routed through an
   `AudioContext` back to `destination` (offscreen.js). Tab stream only — never the mic (echo).
3. **Blob transport changed from Phase 0.** Offscreen now **POSTs blobs straight to the helper**
   (multipart `FormData`) — a 45-min recording is far too big for the old data-URL hop. The old
   `SAVE`/data-URL path is gone. Only the *fallback* (helper down) still touches
   `chrome.downloads`, via `URL.createObjectURL` in offscreen → worker downloads → offscreen
   closes (which revokes the URLs). Keep the offscreen doc alive until downloads resolve.
4. **Tab capture needs a normal http(s) active tab** — `chrome://`/`brave://`/extension pages are
   rejected by the worker; the tab must be active at Start.
5. **Recording state lives in the worker, not the popup** (`chrome.storage.session`). Closing the
   popup mid-interview must not stop recording; popup calls `GET_STATE` on open and reflects it.
6. **Python: use uv, not the system interpreter.** System `python3` is 3.8 (too old for
   faster-whisper and for `str | None` unions); the helper is a uv project pinned to 3.12. Always
   `uv run …`. NB: `helper/.python-version` (3.12) makes a *bare* `python3` in that dir fail under
   pyenv — that's expected; use `uv run`.

## Tab-capture stream path (exact incantation, easy to get wrong)

```js
navigator.mediaDevices.getUserMedia({
  audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  video: false,
});
```

## Run / verify end-to-end

1. **Helper:** `cd helper && uv sync && uv run helper serve` (first real process pulls
   `medium.en` ~1.5 GB; set `BUGBODIES_MODEL=small.en` to go faster).
2. **Extension:** `brave://extensions` → Developer mode → Load unpacked → `extension/`.
3. Open an audible http(s) meeting tab, keep it active. Click the icon → pick/type a company →
   (first run) Allow mic in the tab that opens, close it, Start again. Talk. The tab stays
   audible. Close the popup — recording continues. Reopen → Stop.
4. Files land under `recordings/<Company>/<Date>/`. Open Meetings → Process → status reaches
   `complete` → View transcript (You/Interviewer) → Export `.txt`.
5. **Fallback:** stop the helper, record, Stop → two `.webm` + `meta.json` in
   `Downloads/bugbodies/<Company>/<Date>/`; adopt with `uv run helper import <folder>`.

## Config knobs
- Helper: env vars `BUGBODIES_ROOT` / `BUGBODIES_PORT` (8137) / `BUGBODIES_MODEL` (`medium.en`) /
  `BUGBODIES_COMPUTE_TYPE` (`int8`). See `helper/README.md`.
- Extension → helper URL: `chrome.storage.local` key `helperBase` (default
  `http://localhost:8137`); manifest grants broad `http://localhost/*` so any port works.

## Notes
- Legal: recording interviews may require all-party consent depending on jurisdiction — a
  personal, informed decision; the build doesn't handle it.
- `claude-project-prompt.md` is the prompt to paste into a Claude project to analyze an exported
  transcript.

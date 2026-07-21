# bugbodies — full build spec

**For Claude Code (plan mode).** Read this whole document, then produce a build plan and
wait for my approval before executing. This repo already contains a working Phase 0 extension
and a `CLAUDE.md` describing it — read both first; the notes here extend that work, they don't
replace it.

---

## 1. What this is

A personal AI note-taker for browser-based job interviews (Zoom / Google Meet / Teams, all in a
browser tab). It records each interview as two separate audio tracks, transcribes them locally,
and produces a speaker-labeled transcript I review and later summarize by hand in a Claude project.

Personal use only. Loaded unpacked in developer mode, never published.

**Environment:** Brave (Chromium 150) on Ubuntu 20.04 LTS. Machine has ~16 GB RAM and no dedicated
GPU, so all inference is CPU-only and happens *after* recording, never live.

---

## 2. Current state (already built — do not rebuild)

Phase 0 is done and passing. The extension already proves the two capture paths:

- One click records ~20 s of **tab audio** (remote participants) + ~20 s of **mic** (my voice)
  to two separate `.webm` (Opus) files.
- Recording happens in an **offscreen document** because MV3 service workers can't use
  `MediaRecorder` / `AudioContext`. The worker only orchestrates.
- Existing files: `popup.html/.js`, `permission.html/.js`, `service-worker.js`,
  `offscreen.html/.js`, `manifest.json`.

The four hard-won gotchas from Phase 0 (see `CLAUDE.md`) still apply and must be preserved:

1. **Mic permission must be granted from a real tab, not the popup** (the prompt steals focus and
   closes the popup). `permission.html` handles this; the grant then persists for the extension origin.
2. **Capturing tab audio mutes the tab for me** unless the tab `MediaStream` is routed back to
   `destination` through an `AudioContext`. Do this for the tab stream only, never the mic (echo).
3. **Downloading a `Blob` from offscreen was a data-URL 2-hop dance.** This changes now — see §7.
4. **Tab capture needs a normal active http(s) tab;** `chrome://` / `brave://` / extension pages
   can't be captured.

---

## 3. Target architecture

Two components that talk over `http://localhost`:

**A. The browser extension** — records, and is the UI. Start/stop, company selection, the
meetings list, the transcript viewer, the export button.

**B. A local helper (Python)** — everything the extension sandbox can't do: owns the real
folder tree on disk, combines the tracks, runs Whisper, tracks per-meeting status, serves the
meetings list and transcripts back to the extension. Runnable as a long-lived server *and*
triggerable from the CLI for one-off processing.

```
Brave extension                         Local helper (Python)
──────────────────                      ─────────────────────
popup:    company + Start/Stop   ──►    POST recordings, read meeting list/status
offscreen: 2 MediaRecorders             owns <root>/<Company>/<Date>/ tree
worker:   orchestrates, POSTs      ◄──  faster-whisper (CPU) + ffmpeg
meetings page: list/status/view         transcript merge, status tracking
transcript page: You / Interviewer      serves transcript.txt for export
```

The helper is the **single source of truth**. The meetings page reads its list and statuses
from the helper's endpoints (and ultimately from the on-disk `meta.json` files), never from
`chrome.storage`, so the UI can't drift from what's actually on disk.

---

## 4. On-disk layout (real, browsable folders)

The helper writes a real directory tree under a configurable root (default e.g.
`~/bugbodies/`). I want to be able to open these in my file manager.

```
<root>/
  <Company>/
    <YYYY-MM-DD_HHMMSS>/
      mic.webm            # my voice
      tab.webm            # interviewer(s)
      meta.json           # company, started_at, per-track start offsets, status, error, durations
      transcript.json     # merged segments: [{speaker, start, end, text}, ...]
      transcript.txt      # labeled export (see §6.5)
```

`meta.json.status` is one of: `recorded`, `processing`, `complete`, `error` (with an `error`
message field when relevant). The helper builds the meetings list by scanning the root and
reading each `meta.json`.

---

## 5. Processing pipeline — "combine" means merge at the transcript level

Do **not** mix the two audio tracks into one file. Transcribe them separately and merge the
*text* by timestamp. This is what gives clean speaker labels for free.

1. Both `MediaRecorder`s start on the single Start click, so both files share t≈0. Record each
   track's actual start timestamp (`Date.now()` at recorder start) in `meta.json` so any small
   offset between the two can be corrected at merge time.
2. Transcribe `mic.webm` → every segment labeled **You**.
3. Transcribe `tab.webm` → every segment labeled **Interviewer** (assume exactly one interviewer
   per meeting).
4. Merge all segments, apply the per-track offset, sort by start time → `transcript.json`.
5. Render `transcript.txt` from that.

**Critical quality fix:** while one person talks, the other track is silent, and Whisper
hallucinates text over long silence (repeated "thank you", etc.). Turn on VAD:
faster-whisper `vad_filter=True`, and set a no-speech / log-prob threshold to drop empty
segments. Apply to both tracks.

Model: faster-whisper `medium.en`, CPU, int8. Expose the model name as a config value so I can
drop to `small.en` for speed. First run of `medium.en` pulls ~1.5 GB.

Overlapping speech (both talking at once) will interleave a little awkwardly in the merged
transcript — that's acceptable and still better than diarization.

---

## 6. Features and acceptance criteria

### 6.1 Record start / stop
- Popup shows current state (idle vs. recording) and a Start/Stop toggle.
- Before Start, I pick a company: a dropdown of existing companies plus a field to type a new one.
- Start begins both recorders in the offscreen doc. Stop finalizes both blobs and hands them to
  the helper, which writes them into `<root>/<Company>/<YYYY-MM-DD_HHMMSS>/` with `meta.json`
  (`status: recorded`).
- **Recording state lives in the worker/offscreen doc, not the popup.** Closing the popup
  mid-interview must not stop recording. The popup queries current state when it opens and
  reflects it. (Extends Phase 0 gotcha #1.)
- Fallback: if the helper is unreachable at Stop, save the two `.webm` files + a `meta.json`
  locally via `chrome.downloads` under a `bugbodies/<Company>/<Date>/` subpath so I can import /
  process them via the CLI later. Recording must never be lost just because the helper is down.

### 6.2 Meetings view (own full page/tab, not the popup)
- Lists all meetings grouped by company, newest first, each showing date/time, duration, and status.
- Per meeting: **Process** (if not yet complete), **View transcript** (if complete), **Export .txt**,
  and reassign company.
- Reassigning a company moves the meeting's folder to the new company directory and updates `meta.json`.

### 6.3 Process + status
- Process triggers the §5 pipeline on the helper.
- Status is visible and polled: `recorded` → `processing` → `complete` (or `error` with the message).
- The same processing must be triggerable from the CLI on a meeting folder, independent of the UI.

### 6.4 Transcript view
- Shows the merged transcript with **You** and **Interviewer** lines visually distinct
  (e.g. different alignment/color), in chronological order, with timestamps.

### 6.5 Export to .txt
- Produces / serves `transcript.txt` in a clean, paste-ready format, e.g.:
  ```
  [00:00:12] Interviewer: Tell me about a system you designed recently.
  [00:00:31] You: Sure — most recently I built ...
  ```
- Simplest implementation: the helper serves it with a `Content-Disposition: attachment` header
  so the browser downloads it directly (no `chrome.downloads` needed for this path).

### 6.6 Company folder structure
- Real on-disk `Company → Date` folders as in §4, created and owned by the helper.

### 6.7 Claude project prompt (separate deliverable file)
- Produce a standalone `claude-project-prompt.md` in the repo containing a prompt I'll paste into
  a Claude project to analyze an exported transcript by hand. Use this as the starting content
  (refine wording if helpful, keep the intent):

  > You are helping me review a job interview I recorded. The transcript is labeled with two
  > speakers: **You** (me, the candidate) and **Interviewer**. Analyze it and produce:
  > 1. A 3-sentence summary of the interview.
  > 2. Every question the interviewer asked, each paired with a concise version of how I answered
  >    and a candid assessment — what landed, what was weak, what I could have said instead.
  > 3. The topics, technologies, and themes covered.
  > 4. Signals about the role / team / company worth noting (culture, expectations, red or green flags).
  > 5. Concrete follow-ups to send or things to research before the next round.
  > 6. An overall read on fit and how I came across, plus the 2–3 highest-leverage things to
  >    improve next time.
  >
  > Be direct and specific. Skip flattery.

---

## 7. Locked technical decisions (don't relitigate these in the plan)

- **Extension → helper transport is HTTP POST of the recorded blobs**, replacing the Phase 0
  data-URL hop. A 45-minute interview is far too large to shuttle as a data-URL string. Offscreen
  POSTs each blob straight to the helper.
- **Manifest additions:** `http://localhost:<PORT>/*` host permission; keep `tabCapture`,
  `offscreen`, `activeTab`; add `storage` (for prefs like helper port + last company) and `tabs`
  (to open the meetings page and the permission tab). `downloads` stays only for the §6.1 fallback.
- **Helper CORS** must allow the extension origin on the localhost endpoints.
- **Helper owns the filesystem**, not `chrome.downloads`, so folders can live at a chosen root
  rather than only under Downloads.
- **Transcript-level merge**, not audio mixing (see §5).
- **VAD filtering on**, to stop silent-track hallucination (see §5).
- **Helper is the source of truth** for the meetings list and statuses.

---

## 8. Suggested helper interface (plan may refine)

HTTP (localhost):
- `POST /meetings` — `{company, started_at}` → creates the folder, returns `meeting_id`.
- `POST /meetings/{id}/tracks` — multipart upload of `mic` + `tab` blobs → writes files, sets `recorded`.
- `POST /meetings/{id}/process` — runs the pipeline; returns immediately, work happens async.
- `GET /meetings` — list with company/date/duration/status.
- `GET /meetings/{id}` — detail incl. `transcript.json` when complete.
- `GET /meetings/{id}/transcript.txt` — export (attachment header).
- `PATCH /meetings/{id}` — reassign company (moves the folder).

CLI (helper runnable without the browser):
- `helper serve` — start the localhost server.
- `helper process <meeting-dir>` — run the pipeline on one folder.
- `helper import <path>` — adopt a fallback-saved recording (from §6.1) into the tree.

---

## 9. Tech stack

- **Extension:** vanilla JS, MV3, offscreen document (as in Phase 0). No framework needed.
- **Helper:** Python 3, FastAPI + uvicorn, `faster-whisper`, `ffmpeg` via subprocess. Provide a
  `requirements.txt` and a short README covering ffmpeg install (`apt`), Python deps, first-run
  model download, and how to start `serve`.
- Add a `.gitignore` for `*.webm`, recordings root, model cache, and Python venv artifacts.

---

## 10. Suggested build sequence (for the plan)

1. Local helper skeleton: folder tree, `meta.json`, `POST /meetings` + track upload, meetings
   list/detail endpoints, status field. Verify with `curl` before touching the extension.
2. Wire the extension's Stop to POST both blobs to the helper (replace the data-URL path);
   confirm real files land in `<root>/<Company>/<Date>/`.
3. Processing pipeline: ffmpeg + faster-whisper per track, VAD, timestamp merge → `transcript.json`
   + `transcript.txt`; status transitions; CLI `process`.
4. Meetings view page: grouped list, status polling, Process / View / Export / reassign.
5. Transcript view: labeled You / Interviewer rendering.
6. Fallback save path (§6.1) + `helper import`.
7. Emit `claude-project-prompt.md`. Update `CLAUDE.md` with the new architecture and any new gotchas.

---

## 11. Out of scope

Live/real-time transcription; on-device LLM; speaker diarization (the two-track design replaces
it); multi-interviewer separation on the tab track; publishing to any store; cloud transcription.

## 12. Note

Recording interviews may require all-party consent depending on jurisdiction — this is a
personal, informed decision and not something the build needs to handle.

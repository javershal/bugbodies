# bugbodies

A personal, **local-first** note-taker that records browser-based job interviews
(Zoom / Google Meet / Teams on the web) and turns them into clean, speaker-labeled transcripts —
without sending your audio to any cloud service.

Everything runs on your own machine: a Chromium extension captures the audio, and a small local
Python helper transcribes it with [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
No accounts, no APIs, no uploads.

> ⚠️ **Personal project.** Built for one person's own use and loaded unpacked in developer mode —
> it is not on any extension store and isn't meant to be. Sharing it here in case the approach is
> useful to others.

## The core idea: two tracks, no diarization

Speaker labeling ("who said what") is normally the hard, error-prone part of transcription.
bugbodies sidesteps it entirely by recording **two separate audio tracks**:

- **Tab audio** — the remote participants (the interviewer) → labeled **Interviewer**
- **Microphone** — your own voice → labeled **You**

Each track is transcribed independently, then the two are merged back together by timestamp. Because
each track only ever contains one side of the conversation, you get accurate **You / Interviewer**
labels for free — no diarization model, no guessing.

## How it works

```
┌─────────────────────────── Brave / Chromium ───────────────────────────┐
│                                                                          │
│   Extension (MV3, vanilla JS)                                            │
│     popup            company picker + Start/Stop                         │
│     service-worker   owns recording state, orchestrates                  │
│     offscreen doc    2× MediaRecorder → mic.webm + tab.webm              │
│         │                                                                │
└─────────┼────────────────────────────────────────────────────────────────┘
          │  multipart POST over http://localhost
          ▼
┌──────────────────── Local Python helper (FastAPI) ─────────────────────┐
│   • owns  <root>/<Company>/<Date>/                                      │
│   • transcribes each track with faster-whisper (+ VAD)                  │
│   • merges by timestamp → transcript.json / transcript.txt             │
│   • serves the meetings list & transcripts back to the extension       │
└─────────────────────────────────────────────────────────────────────────┘
```

Two components talk to each other only over `http://localhost`:

1. **The extension** records and displays. MV3 service workers can't use `MediaRecorder`, so the
   actual capture happens in an *offscreen document*; the worker owns recording state so closing the
   popup mid-interview never stops the recording.
2. **The helper** is the single source of truth. It owns the files on disk, runs transcription, and
   serves everything back. It also works fully from the command line without the browser.

If the helper isn't running when you stop recording, the extension falls back to saving the two
`.webm` files via the browser's download manager so nothing is ever lost — you can adopt them later
with `helper import`.

## Repository layout

```
extension/     load this unpacked in your browser (manifest + all extension JS/HTML)
helper/        local Python helper (uv project, Python 3.12) — see helper/README.md
recordings/    your recordings live here (gitignored — never committed)
```

## Quick start

**1. Run the helper** (transcription + storage):

```bash
cd helper
uv sync                 # installs deps into a local venv (needs uv + ffmpeg)
uv run helper serve     # listens on http://localhost:8137
```

The first transcription downloads a Whisper model (default `medium.en`, ~1.5 GB; set
`BUGBODIES_MODEL=small.en` for a faster, smaller one). See [helper/README.md](helper/README.md) for
all config options and CLI usage.

**2. Load the extension:**

- Open `brave://extensions` (or `chrome://extensions`)
- Enable **Developer mode** → **Load unpacked** → select the `extension/` folder

**3. Record:**

- Open the meeting tab and keep it active
- Click the extension icon, pick/type the company, and hit **Start**
  (first run only: approve microphone access in the tab that opens)
- Talk. The tab stays audible while recording. You can close the popup — recording continues.
- Reopen the popup and hit **Stop**

**4. Transcribe & read:**

- Open the **Meetings** page → **Process** a meeting → wait for `complete`
- **View** the merged You/Interviewer transcript, or **Export** the `.txt`

## Reviewing a transcript with Claude

[`claude-project-prompt.md`](claude-project-prompt.md) is a ready-made prompt you can paste into a
Claude project. Drop in an exported `transcript.txt` and it will summarize the interview, list every
question with a candid assessment of your answers, flag signals about the role, and suggest
follow-ups.

## Tech stack

- **Extension:** Manifest V3, vanilla JavaScript (no build step, no dependencies)
- **Helper:** Python 3.12, FastAPI + uvicorn, faster-whisper, ffmpeg — managed with
  [uv](https://github.com/astral-sh/uv)

## Privacy & consent

All audio and transcripts stay on your machine — the only network traffic is `localhost` between the
two components, plus the one-time Whisper model download. Recordings are gitignored and never leave
your disk.

Recording a conversation may require the consent of everyone involved depending on where you live.
That's a personal, informed decision this tool deliberately doesn't make for you — know and follow
the laws that apply to you.

## License

Personal project shared as-is, with no warranty. Use at your own risk.

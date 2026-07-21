# bugbodies helper

Local Python helper for the bugbodies interview note-taker. It owns the on-disk recordings tree,
runs local Whisper transcription, and serves the meetings list / transcripts back to the browser
extension over `http://localhost`. It is the **single source of truth** — the extension records
and displays; this owns the files and status.

## Prerequisites

- **ffmpeg** (system):
  ```bash
  sudo apt install ffmpeg
  ```
- **uv** (already installed here). It manages the Python version (pinned to 3.12) and deps —
  no manual venv needed.

## Setup

From this `helper/` directory:

```bash
uv sync
```

This creates `.venv/` and installs FastAPI, uvicorn, and `faster-whisper`.

The first transcription downloads the Whisper model. The default is `medium.en` (~1.5 GB, best
accuracy for interviews). Drop to `small.en` for speed via `BUGBODIES_MODEL` (see Config).

## Run the server

```bash
uv run helper serve
```

Listens on `127.0.0.1:8137` by default. The extension talks to this. Leave it running while you
record and process meetings.

## CLI (works without the browser)

```bash
uv run helper process <meeting-dir>   # run the pipeline on one meeting folder
uv run helper import <path>           # adopt a fallback-saved recording into the tree
uv run helper import <path> --process # ...and process it immediately
```

`<meeting-dir>` is a folder containing `mic.webm` + `tab.webm` + `meta.json`, e.g.
`recordings/Acme/2026-07-21_101500/`.

## Config (environment variables)

| Var | Default | Meaning |
|-----|---------|---------|
| `BUGBODIES_ROOT` | `<repo>/recordings` | Root of the browsable `Company/Date/` tree |
| `BUGBODIES_PORT` | `8137` | Server port (extension uses a broad `localhost/*` permission, so any port works) |
| `BUGBODIES_MODEL` | `medium.en` | faster-whisper model; use `small.en` for speed |
| `BUGBODIES_DEVICE` | `cpu` | Inference device |
| `BUGBODIES_COMPUTE_TYPE` | `int8` | Quantization |
| `BUGBODIES_ORIGINS` | *(any chrome-extension)* | Explicit CORS allowlist if you want to lock it down |

Example — run on a different port with the faster model:

```bash
BUGBODIES_MODEL=small.en BUGBODIES_PORT=9000 uv run helper serve
```

If you change the port, set it in the extension too (`chrome.storage.local` key `helperBase`,
e.g. `http://localhost:9000`).

## On-disk layout

```
<root>/<Company>/<YYYY-MM-DD_HHMMSS>/
  mic.webm         your voice
  tab.webm         interviewer(s)
  meta.json        company, timestamps, status, error, duration
  transcript.json  merged segments [{speaker, start, end, text}]
  transcript.txt   labeled export
```

`meta.json.status`: `recorded` → `processing` → `complete` (or `error` with a message).

## How transcription works

The two tracks are **not** mixed. Each is transcribed separately (mic → **You**, tab →
**Interviewer**), with VAD on to stop Whisper hallucinating over the silent track. Segments are
merged by timestamp (with the small per-track start offset corrected) into one chronological
transcript — clean speaker labels for free.

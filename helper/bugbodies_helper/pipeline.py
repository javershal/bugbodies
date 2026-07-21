"""Transcription pipeline: two tracks in, one merged transcript out.

Key design (spec §5): do NOT mix the audio. Transcribe each track separately,
label mic segments "You" and tab segments "Interviewer", then merge the *text*
by timestamp. That gives clean speaker labels for free.

VAD is on and no-speech/log-prob thresholds are set, because while one person
talks the other track is silent and Whisper hallucinates over silence.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Callable, Optional

from . import config, store

# Lazily-created singleton so the model loads once per process.
_model = None


def _get_model():
    global _model
    if _model is None:
        # Imported here so `helper serve`/`store` work without the heavy dep
        # until an actual transcription is requested.
        from faster_whisper import WhisperModel

        _model = WhisperModel(
            config.MODEL,
            device=config.DEVICE,
            compute_type=config.COMPUTE_TYPE,
        )
    return _model


def _ensure_wav(src: Path) -> Path:
    """Decode webm/Opus → 16k mono wav next to the source.

    faster-whisper can read webm directly via its bundled ffmpeg, but decoding
    ourselves is a robust fallback and avoids surprises with Opus containers.
    """
    wav = src.with_suffix(".wav")
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(src),
            "-ac", "1", "-ar", "16000",
            "-f", "wav", str(wav),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return wav


def _transcribe_track(
    path: Path,
    speaker: str,
    offset_ms: float,
    on_progress: Optional[Callable[[float], None]] = None,
) -> list[dict]:
    """Transcribe one track, returning labeled, offset-applied segments.

    ``on_progress`` (if given) is called with this track's fraction done
    (0.0–1.0), derived from each segment's end time vs the track duration.
    """
    if not path.exists():
        return []
    model = _get_model()
    wav = _ensure_wav(path)
    try:
        # ``info.duration`` is the total audio length; each seg.end tells us how
        # far in we are, so seg.end / duration is the fraction transcribed.
        segments, info = model.transcribe(
            str(wav),
            language="en",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            # Drop silent-track hallucinations.
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            condition_on_previous_text=False,
        )
        duration = getattr(info, "duration", 0.0) or 0.0
        out = []
        shift = offset_ms / 1000.0
        for seg in segments:
            if on_progress and duration > 0:
                on_progress(min(seg.end / duration, 1.0))
            text = (seg.text or "").strip()
            if not text:
                continue
            out.append(
                {
                    "speaker": speaker,
                    "start": round(seg.start + shift, 3),
                    "end": round(seg.end + shift, 3),
                    "text": text,
                }
            )
        if on_progress:
            on_progress(1.0)
        return out
    finally:
        wav.unlink(missing_ok=True)


def _fmt_ts(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def render_txt(segments: list[dict]) -> str:
    """Clean, paste-ready export (spec §6.5)."""
    lines = [f"[{_fmt_ts(s['start'])}] {s['speaker']}: {s['text']}" for s in segments]
    return "\n".join(lines) + ("\n" if lines else "")


def process_meeting(meeting_id: str) -> dict:
    """Run the full pipeline on one meeting id. Sets status transitions."""
    d = store.meeting_dir(meeting_id)
    return process_dir(d, meeting_id=meeting_id)


def process_dir(d: Path, meeting_id: Optional[str] = None) -> dict:
    """Run the pipeline on a folder path (used by both HTTP and CLI)."""
    import json

    meta = store.read_meta(d)
    mid = meeting_id or meta.get("id")
    try:
        store.set_status(mid, "processing")

        # Throttled progress writer: set_status/set_progress do a full
        # read-modify-write of meta.json, so we don't want one per segment.
        # Write on any stage change or at most ~every 2s.
        last = {"t": 0.0, "stage": None}

        def report(progress: float, stage: str) -> None:
            now = time.monotonic()
            if stage != last["stage"] or now - last["t"] >= 2.0:
                last["t"] = now
                last["stage"] = stage
                store.set_progress(mid, progress, stage)

        # Two tracks, transcribed in sequence → each owns half the bar.
        off = store.offset_ms(meta)
        # Positive offset shifts the mic timeline; apply the negative side to
        # tab so both land on a common origin. We anchor on the tab timeline:
        # mic segments shift by (mic_started - tab_started).
        report(0.0, "transcribing you")
        mic_segments = _transcribe_track(
            d / "mic.webm", "You", off,
            on_progress=lambda f: report(f * 0.5, "transcribing you"),
        )
        report(0.5, "transcribing interviewer")
        tab_segments = _transcribe_track(
            d / "tab.webm", "Interviewer", 0.0,
            on_progress=lambda f: report(0.5 + f * 0.5, "transcribing interviewer"),
        )
        report(1.0, "merging")

        merged = mic_segments + tab_segments
        merged.sort(key=lambda s: (s["start"], s["end"]))

        (d / "transcript.json").write_text(
            json.dumps(merged, indent=2), encoding="utf-8"
        )
        (d / "transcript.txt").write_text(render_txt(merged), encoding="utf-8")

        return store.set_status(mid, "complete")
    except Exception as exc:  # noqa: BLE001 — record any failure for the UI
        return store.set_status(mid, "error", error=f"{type(exc).__name__}: {exc}")

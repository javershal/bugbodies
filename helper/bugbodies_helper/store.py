"""Filesystem source of truth.

Owns the on-disk tree:

    <ROOT>/<Company>/<YYYY-MM-DD_HHMMSS>/
        mic.webm  tab.webm  meta.json  transcript.json  transcript.txt

The meetings list is always built by scanning ROOT and reading each meta.json,
so the UI can never drift from what's actually on disk.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from . import config

# A meeting id is "<Company>/<YYYY-MM-DD_HHMMSS>" — the path relative to ROOT.
_DIRNAME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{6}$")
VALID_STATUSES = {"recorded", "processing", "complete", "error"}


def _sanitize_company(company: str) -> str:
    """Keep company names filesystem-safe without being surprising."""
    name = (company or "").strip()
    if not name:
        name = "Unknown"
    # Disallow path separators and control chars; collapse whitespace.
    name = re.sub(r"[/\\\x00-\x1f]", " ", name).strip()
    name = re.sub(r"\s+", " ", name)
    return name or "Unknown"


def _dirname_from_started_at(started_at: Optional[str]) -> str:
    """Build the <YYYY-MM-DD_HHMMSS> folder name from an ISO/epoch timestamp."""
    dt = _parse_ts(started_at) or datetime.now()
    return dt.strftime("%Y-%m-%d_%H%M%S")


def _parse_ts(value) -> Optional[datetime]:
    if value is None or value == "":
        return None
    # Epoch millis (from the extension's Date.now()).
    try:
        n = float(value)
        if n > 1e11:  # looks like ms
            n /= 1000.0
        return datetime.fromtimestamp(n)
    except (TypeError, ValueError):
        pass
    # ISO 8601.
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def meeting_dir(meeting_id: str) -> Path:
    """Resolve a meeting id to its directory, guarding against traversal."""
    parts = [p for p in Path(meeting_id).parts if p not in ("", ".", "..")]
    if len(parts) != 2 or not _DIRNAME_RE.match(parts[1]):
        raise ValueError(f"Invalid meeting id: {meeting_id!r}")
    d = (config.ROOT / parts[0] / parts[1]).resolve()
    if config.ROOT.resolve() not in d.parents:
        raise ValueError(f"Meeting id escapes root: {meeting_id!r}")
    return d


def read_meta(d: Path) -> dict:
    meta_path = d / "meta.json"
    if not meta_path.exists():
        raise FileNotFoundError(f"No meta.json in {d}")
    with meta_path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_meta(d: Path, meta: dict) -> None:
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "meta.json.tmp"
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    tmp.replace(d / "meta.json")


def update_meta(meeting_id: str, **changes) -> dict:
    d = meeting_dir(meeting_id)
    meta = read_meta(d)
    meta.update(changes)
    write_meta(d, meta)
    return meta


def set_status(meeting_id: str, status: str, error: Optional[str] = None) -> dict:
    if status not in VALID_STATUSES:
        raise ValueError(f"Bad status: {status}")
    return update_meta(meeting_id, status=status, error=error)


def create_meeting(company: str, started_at: Optional[str]) -> dict:
    """Create the folder + initial meta.json (status: recorded, pending upload)."""
    company = _sanitize_company(company)
    dirname = _dirname_from_started_at(started_at)
    d = config.ROOT / company / dirname
    # Avoid clobbering an existing meeting recorded in the same second.
    suffix = 0
    base = d
    while d.exists():
        suffix += 1
        d = base.parent / f"{base.name}_{suffix}"
    d.mkdir(parents=True, exist_ok=True)

    meeting_id = f"{company}/{d.name}"
    dt = _parse_ts(started_at) or datetime.now()
    meta = {
        "id": meeting_id,
        "company": company,
        "started_at": dt.isoformat(timespec="seconds"),
        "mic_started_at": None,
        "tab_started_at": None,
        "duration_sec": None,
        "status": "recorded",
        "error": None,
        "has_tracks": False,
    }
    write_meta(d, meta)
    return meta


def save_tracks(
    meeting_id: str,
    mic_bytes: bytes,
    tab_bytes: bytes,
    mic_started_at=None,
    tab_started_at=None,
    duration_sec=None,
) -> dict:
    d = meeting_dir(meeting_id)
    (d / "mic.webm").write_bytes(mic_bytes)
    (d / "tab.webm").write_bytes(tab_bytes)
    return update_meta(
        meeting_id,
        mic_started_at=_iso_or_none(mic_started_at),
        tab_started_at=_iso_or_none(tab_started_at),
        duration_sec=_num_or_none(duration_sec),
        status="recorded",
        has_tracks=True,
    )


def _iso_or_none(value):
    dt = _parse_ts(value)
    return dt.isoformat(timespec="milliseconds") if dt else None


def _num_or_none(value):
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return None


def offset_ms(meta: dict) -> float:
    """mic_started_at - tab_started_at in ms; used to align the two tracks.

    Positive means the mic recorder started later than the tab recorder, so mic
    segment times must be shifted forward relative to the tab timeline.
    """
    mic = _parse_ts(meta.get("mic_started_at"))
    tab = _parse_ts(meta.get("tab_started_at"))
    if not mic or not tab:
        return 0.0
    return (mic.timestamp() - tab.timestamp()) * 1000.0


def list_meetings() -> list[dict]:
    """Scan ROOT and return every meeting's meta, newest first."""
    out = []
    if not config.ROOT.exists():
        return out
    for company_dir in sorted(config.ROOT.iterdir()):
        if not company_dir.is_dir():
            continue
        for mdir in sorted(company_dir.iterdir()):
            if not mdir.is_dir() or not _DIRNAME_RE.match(mdir.name):
                continue
            try:
                meta = read_meta(mdir)
            except (FileNotFoundError, json.JSONDecodeError):
                continue
            meta.setdefault("id", f"{company_dir.name}/{mdir.name}")
            out.append(meta)
    out.sort(key=lambda m: m.get("started_at") or "", reverse=True)
    return out


def companies() -> list[str]:
    if not config.ROOT.exists():
        return []
    return sorted(p.name for p in config.ROOT.iterdir() if p.is_dir())


def read_transcript_json(meeting_id: str) -> Optional[list]:
    d = meeting_dir(meeting_id)
    p = d / "transcript.json"
    if not p.exists():
        return None
    with p.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def transcript_txt_path(meeting_id: str) -> Path:
    return meeting_dir(meeting_id) / "transcript.txt"


def reassign_company(meeting_id: str, new_company: str) -> dict:
    """Move the meeting folder under a new company dir; update meta.json."""
    new_company = _sanitize_company(new_company)
    src = meeting_dir(meeting_id)
    dest_parent = config.ROOT / new_company
    dest_parent.mkdir(parents=True, exist_ok=True)
    dest = dest_parent / src.name
    suffix = 0
    base = dest
    while dest.exists():
        suffix += 1
        dest = base.parent / f"{base.name}_{suffix}"
    shutil.move(str(src), str(dest))
    new_id = f"{new_company}/{dest.name}"
    meta = read_meta(dest)
    meta["company"] = new_company
    meta["id"] = new_id
    write_meta(dest, meta)
    return meta

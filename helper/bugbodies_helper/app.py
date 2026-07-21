"""FastAPI HTTP surface for the bugbodies helper.

The helper is the single source of truth: the extension records and displays,
but the list/status/transcripts all come from here (and ultimately from the
on-disk meta.json files).
"""

from __future__ import annotations

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from . import config, pipeline, store

app = FastAPI(title="bugbodies helper")

# CORS: allow the unpacked extension origin. Explicit list if provided, else a
# regex that matches any chrome-extension:// origin.
if config.ALLOW_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.ALLOW_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=config.ALLOW_ORIGIN_REGEX,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def _decode_id(meeting_id: str) -> str:
    # Routes receive the id url-encoded ("Acme/2026-...")
    from urllib.parse import unquote

    return unquote(meeting_id)


class CreateMeeting(BaseModel):
    company: str
    started_at: str | float | None = None


class PatchMeeting(BaseModel):
    company: str


@app.get("/health")
def health():
    return {"ok": True, "root": str(config.ROOT), "companies": store.companies()}


@app.get("/meetings")
def list_meetings():
    return {"meetings": store.list_meetings(), "companies": store.companies()}


@app.post("/meetings")
def create_meeting(body: CreateMeeting):
    meta = store.create_meeting(body.company, body.started_at)
    return meta


@app.post("/meetings/{meeting_id:path}/tracks")
async def upload_tracks(
    meeting_id: str,
    mic: UploadFile = File(...),
    tab: UploadFile = File(...),
    mic_started_at: str | None = Form(None),
    tab_started_at: str | None = Form(None),
    duration_sec: str | None = Form(None),
):
    mid = _decode_id(meeting_id)
    try:
        meta = store.save_tracks(
            mid,
            await mic.read(),
            await tab.read(),
            mic_started_at=mic_started_at,
            tab_started_at=tab_started_at,
            duration_sec=duration_sec,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return meta


@app.post("/meetings/{meeting_id:path}/process")
async def process_meeting(meeting_id: str):
    import asyncio

    mid = _decode_id(meeting_id)
    try:
        meta = store.set_status(mid, "processing")
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    # Run the CPU-heavy pipeline off the event loop; return immediately.
    asyncio.get_event_loop().run_in_executor(None, pipeline.process_meeting, mid)
    return meta


@app.get("/meetings/{meeting_id:path}/transcript.txt")
def get_transcript_txt(meeting_id: str):
    mid = _decode_id(meeting_id)
    try:
        path = store.transcript_txt_path(mid)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if not path.exists():
        raise HTTPException(status_code=404, detail="transcript.txt not ready")
    filename = mid.replace("/", "_") + ".txt"
    return FileResponse(
        path, media_type="text/plain", filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/meetings/{meeting_id:path}")
def get_meeting(meeting_id: str):
    mid = _decode_id(meeting_id)
    try:
        d = store.meeting_dir(mid)
        meta = store.read_meta(d)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    meta = dict(meta)
    meta["transcript"] = store.read_transcript_json(mid)
    return meta


@app.patch("/meetings/{meeting_id:path}")
def patch_meeting(meeting_id: str, body: PatchMeeting):
    mid = _decode_id(meeting_id)
    try:
        meta = store.reassign_company(mid, body.company)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return meta

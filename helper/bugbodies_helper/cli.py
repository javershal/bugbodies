"""Command-line entrypoints for the helper — usable without the browser.

    python -m helper serve                 start the localhost server
    python -m helper process <meeting-dir> run the pipeline on one folder
    python -m helper import <path>         adopt a fallback-saved recording
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from . import config, pipeline, store


def cmd_serve(_args) -> int:
    import uvicorn

    print(f"[bugbodies] root={config.ROOT}  model={config.MODEL}  port={config.PORT}")
    config.ROOT.mkdir(parents=True, exist_ok=True)
    uvicorn.run("bugbodies_helper.app:app", host="127.0.0.1", port=config.PORT, reload=False)
    return 0


def cmd_process(args) -> int:
    d = Path(args.meeting_dir).resolve()
    if not (d / "meta.json").exists():
        print(f"No meta.json in {d}", file=sys.stderr)
        return 1
    meta = pipeline.process_dir(d)
    print(f"status={meta.get('status')} error={meta.get('error')}")
    return 0 if meta.get("status") == "complete" else 1


def cmd_import(args) -> int:
    """Adopt a §6.1 fallback-saved recording into the tree.

    Accepts a folder that contains mic.webm + tab.webm and optionally meta.json.
    Company/date are taken from meta.json when present, else inferred from the
    path (…/<Company>/<Date>/) or flags.
    """
    src = Path(args.path).resolve()
    if not src.is_dir():
        print(f"Not a directory: {src}", file=sys.stderr)
        return 1

    company = args.company
    started_at = None
    src_meta = src / "meta.json"
    if src_meta.exists():
        m = json.loads(src_meta.read_text(encoding="utf-8"))
        company = company or m.get("company")
        started_at = m.get("started_at")
    if not company:
        # …/<Company>/<Date>/ layout from the downloads fallback.
        company = src.parent.name

    mic = src / "mic.webm"
    tab = src / "tab.webm"
    if not mic.exists() or not tab.exists():
        print(f"Expected mic.webm and tab.webm in {src}", file=sys.stderr)
        return 1

    meta = store.create_meeting(company, started_at)
    dest = store.meeting_dir(meta["id"])
    shutil.copy2(mic, dest / "mic.webm")
    shutil.copy2(tab, dest / "tab.webm")
    store.update_meta(meta["id"], status="recorded", has_tracks=True)
    print(f"Imported → {meta['id']}")
    if args.process:
        m = pipeline.process_meeting(meta["id"])
        print(f"status={m.get('status')} error={m.get('error')}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="helper", description="bugbodies helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("serve", help="start the localhost server").set_defaults(
        func=cmd_serve
    )

    p_proc = sub.add_parser("process", help="run the pipeline on one meeting folder")
    p_proc.add_argument("meeting_dir")
    p_proc.set_defaults(func=cmd_process)

    p_imp = sub.add_parser("import", help="adopt a fallback-saved recording")
    p_imp.add_argument("path")
    p_imp.add_argument("--company", default=None)
    p_imp.add_argument("--process", action="store_true", help="process after import")
    p_imp.set_defaults(func=cmd_import)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

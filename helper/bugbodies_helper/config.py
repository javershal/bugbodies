"""Configuration for the bugbodies local helper.

All values are env-overridable so the helper can be pointed at a different
recordings root, port, or Whisper model without editing code.
"""

import os
from pathlib import Path

# Repo root = bugbodies/ (…/helper/bugbodies_helper/config.py → up three).
_REPO_ROOT = Path(__file__).resolve().parents[2]

# Where the browsable <Company>/<Date>/ tree lives. Default: <repo>/recordings.
ROOT = Path(os.environ.get("BUGBODIES_ROOT", _REPO_ROOT / "recordings")).expanduser()

# Localhost port the server listens on. The extension uses a broad
# http://localhost/* host permission, so this can change without a manifest edit.
PORT = int(os.environ.get("BUGBODIES_PORT", "8137"))

# faster-whisper model. medium.en is best for interviews (~1.5GB first-run
# download); drop to small.en via BUGBODIES_MODEL for speed.
MODEL = os.environ.get("BUGBODIES_MODEL", "medium.en")

# CPU-only inference on this machine (no dedicated GPU).
DEVICE = os.environ.get("BUGBODIES_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("BUGBODIES_COMPUTE_TYPE", "int8")

# Re-segmentation gap (ms). Each track is transcribed alone, so while one person
# talks the other track is silence that VAD strips — Whisper then glues several
# of a speaker's utterances into one segment with a single start time, which
# breaks the timestamp-merge's interleaving. With word timestamps on, we split a
# segment wherever the pause between two consecutive words is >= this many ms
# (a long pause usually means the *other* person was talking). Lower = finer
# back-and-forth; too low over-splits one person's natural pauses. 0 disables.
SPLIT_GAP_MS = float(os.environ.get("BUGBODIES_SPLIT_GAP_MS", "700"))

# CORS: unpacked extensions get a random id, so allow any chrome-extension
# origin by default via a regex. Override with an explicit comma-separated list
# in BUGBODIES_ORIGINS if you want to lock it down.
_origins_env = os.environ.get("BUGBODIES_ORIGINS", "").strip()
ALLOW_ORIGINS = [o.strip() for o in _origins_env.split(",") if o.strip()]
# When no explicit list is given, app.py falls back to this origin regex.
ALLOW_ORIGIN_REGEX = r"^chrome-extension://.*$"

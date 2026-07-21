// Transcript page: renders the merged transcript for one meeting, You vs
// Interviewer visually distinct, chronological, timestamped.

const params = new URLSearchParams(location.search);
const id = params.get("id");

const statusEl = document.getElementById("status");
const linesEl = document.getElementById("lines");
const titleEl = document.getElementById("title");
const subEl = document.getElementById("sub");
const exportEl = document.getElementById("export");

function fmtTs(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

async function getBase() {
  const res = await chrome.runtime.sendMessage({ type: "GET_HELPER_BASE" });
  return res?.base || "http://localhost:8137";
}

function renderLine(seg) {
  const line = document.createElement("div");
  line.className = "line " + seg.speaker;

  const ts = document.createElement("div");
  ts.className = "ts";
  ts.textContent = fmtTs(seg.start);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const who = document.createElement("div");
  who.className = "speaker";
  who.textContent = seg.speaker;
  const text = document.createElement("div");
  text.textContent = seg.text;
  bubble.append(who, text);

  line.append(ts, bubble);
  return line;
}

(async () => {
  if (!id) {
    statusEl.textContent = "No meeting id.";
    statusEl.className = "err";
    return;
  }
  const base = await getBase();
  exportEl.href = `${base}/meetings/${encodeURIComponent(id)}/transcript.txt`;

  try {
    const res = await fetch(`${base}/meetings/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const m = await res.json();
    titleEl.textContent = m.company;
    subEl.textContent = [new Date(m.started_at).toLocaleString(), m.id]
      .filter(Boolean)
      .join(" · ");

    const segs = m.transcript;
    if (!segs) {
      statusEl.textContent =
        m.status === "complete" ? "No transcript found." : `Not processed yet (status: ${m.status}).`;
      return;
    }
    statusEl.textContent = "";
    for (const seg of segs) linesEl.append(renderLine(seg));
    if (segs.length === 0) statusEl.textContent = "Transcript is empty.";
  } catch (e) {
    statusEl.textContent = `Can't reach the helper. Start it with: uv run helper serve`;
    statusEl.className = "err";
  }
})();

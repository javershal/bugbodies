// Meetings page: reads the meeting list + statuses from the helper (the single
// source of truth), grouped by company, newest first. Polls while anything is
// processing. Process / View transcript / Export / reassign company.

const listEl = document.getElementById("list");
const bannerEl = document.getElementById("banner");
let base = "http://localhost:8137";
let pollTimer = null;

async function getBase() {
  const res = await chrome.runtime.sendMessage({ type: "GET_HELPER_BASE" });
  return res?.base || base;
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return "";
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

function banner(msg) {
  bannerEl.textContent = msg;
  bannerEl.classList.toggle("hidden", !msg);
}

async function api(path, opts) {
  const res = await fetch(`${base}${path}`, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  return res;
}

async function process(id, btn) {
  btn.disabled = true;
  btn.textContent = "Processing…";
  try {
    await api(`/meetings/${encodeURIComponent(id)}/process`, { method: "POST" });
    startPolling();
  } catch (e) {
    banner("Process failed: " + e.message);
    btn.disabled = false;
    btn.textContent = "Process";
  }
}

async function reassign(id) {
  const to = prompt("Reassign to which company?");
  if (!to) return;
  try {
    await api(`/meetings/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: to.trim() }),
    });
    load();
  } catch (e) {
    banner("Reassign failed: " + e.message);
  }
}

function meetingRow(m) {
  const row = document.createElement("div");
  row.className = "meeting";

  const meta = document.createElement("div");
  meta.className = "meta";
  const when = document.createElement("div");
  when.className = "when";
  when.textContent = fmtWhen(m.started_at);
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = [fmtDuration(m.duration_sec), m.id].filter(Boolean).join(" · ");
  meta.append(when, sub);

  const badge = document.createElement("span");
  badge.className = "badge " + m.status;
  badge.textContent = m.status;

  row.append(meta, badge);

  if (m.status !== "complete") {
    const p = document.createElement("button");
    p.textContent = m.status === "processing" ? "Processing…" : "Process";
    p.disabled = m.status === "processing";
    p.onclick = () => process(m.id, p);
    row.append(p);
  }
  if (m.status === "complete") {
    const view = document.createElement("a");
    view.className = "btn";
    view.textContent = "View transcript";
    view.href = `transcript.html?id=${encodeURIComponent(m.id)}`;
    view.target = "_blank";

    const exp = document.createElement("a");
    exp.className = "btn";
    exp.textContent = "Export .txt";
    exp.href = `${base}/meetings/${encodeURIComponent(m.id)}/transcript.txt`;
    row.append(view, exp);
  }

  const re = document.createElement("button");
  re.textContent = "Reassign";
  re.onclick = () => reassign(m.id);
  row.append(re);

  if (m.status === "error" && m.error) {
    const err = document.createElement("div");
    err.className = "err-msg";
    err.textContent = m.error;
    row.append(err);
  }
  return row;
}

async function load() {
  try {
    const data = await (await api("/meetings")).json();
    banner("");
    render(data.meetings || []);
  } catch (e) {
    banner(`Can't reach the helper at ${base}. Start it with: uv run helper serve`);
    listEl.innerHTML = "";
    stopPolling();
  }
}

function render(meetings) {
  listEl.innerHTML = "";
  if (meetings.length === 0) {
    listEl.textContent = "No meetings yet.";
    return;
  }
  const byCompany = {};
  for (const m of meetings) (byCompany[m.company] ||= []).push(m);

  for (const company of Object.keys(byCompany).sort()) {
    const h = document.createElement("h2");
    h.textContent = company;
    listEl.append(h);
    for (const m of byCompany[company]) listEl.append(meetingRow(m));
  }

  const anyProcessing = meetings.some((m) => m.status === "processing");
  if (anyProcessing) startPolling();
  else stopPolling();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(load, 3000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

(async () => {
  base = await getBase();
  load();
})();

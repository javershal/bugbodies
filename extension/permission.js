// Opened as a full tab (not a popup) so it survives the mic permission prompt.
// Once granted, the permission persists for the extension origin, so the
// offscreen document can acquire the mic silently.

const statusEl = document.getElementById("status");
const retryBtn = document.getElementById("retry");

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || "";
}

async function requestMic() {
  setStatus("Requesting…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    setStatus("Granted. You can close this tab, then click “Start 20s Test” again.", "ok");
  } catch (err) {
    setStatus(
      "Failed: " + (err?.message || String(err)) +
        "\nClick “Request microphone” to try again, or check Brave site settings for this extension.",
      "err"
    );
  }
}

retryBtn.addEventListener("click", requestMic);
requestMic();

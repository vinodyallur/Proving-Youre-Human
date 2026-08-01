/* TrustLayer — verify the person on the other end of a call.
   Captures the pixels of their video tile (via screen share) and runs
   visual liveness + challenge-response on a face region you select. */

const els = {
  video: document.getElementById("video"),
  work: document.getElementById("work"),
  wrap: document.getElementById("videoWrap"),
  selBox: document.getElementById("selBox"),
  hint: document.getElementById("hint"),
  challengeBanner: document.getElementById("challengeBanner"),
  shareBtn: document.getElementById("shareBtn"),
  verifyBtn: document.getElementById("verifyBtn"),
  askBtn: document.getElementById("askBtn"),
  verdictChip: document.getElementById("verdictChip"),
  scoreRing: document.getElementById("scoreRing"),
  scoreNum: document.getElementById("scoreNum"),
  scoreVerdict: document.getElementById("scoreVerdict"),
  reasons: document.getElementById("reasons"),
  apiRaw: document.getElementById("apiRaw")
};

let stream = null;
let roi = null; // normalized {x,y,w,h} of the selected face region
const state = { remote: true };

// ---------- Screen share ----------
els.shareBtn.addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    });
    els.video.srcObject = stream;
    els.video.dataset.screen = "1";
    els.hint.textContent = "Now drag a box over the other person's face.";
    els.shareBtn.textContent = "Sharing";
    els.shareBtn.disabled = true;

    stream.getVideoTracks()[0].addEventListener("ended", () => {
      els.hint.hidden = false;
      els.hint.textContent = "Share ended. Click “Share call window” to restart.";
      els.verifyBtn.disabled = true;
      els.askBtn.disabled = true;
    });
  } catch (e) {
    alert("Screen share is required to verify the other person.\n\n" + e.message);
  }
});

// ---------- ROI selection (drag a box over their face) ----------
let dragging = false, sx = 0, sy = 0;

els.wrap.addEventListener("mousedown", (e) => {
  if (!stream) return;
  const r = els.wrap.getBoundingClientRect();
  dragging = true;
  sx = e.clientX - r.left; sy = e.clientY - r.top;
  els.selBox.hidden = false;
  els.hint.hidden = true;
  updateBox(sx, sy, 0, 0);
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const r = els.wrap.getBoundingClientRect();
  const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
  const cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
  const x = Math.min(sx, cx), y = Math.min(sy, cy);
  const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
  updateBox(x, y, w, h);
});

window.addEventListener("mouseup", (e) => {
  if (!dragging) return;
  dragging = false;
  const r = els.wrap.getBoundingClientRect();
  const box = els.selBox.getBoundingClientRect();
  const bx = box.left - r.left, by = box.top - r.top;
  if (box.width < 20 || box.height < 20) {
    els.selBox.hidden = true;
    els.hint.hidden = false;
    els.hint.textContent = "Box too small — drag a larger box over their face.";
    return;
  }
  roi = {
    x: bx / r.width,
    y: by / r.height,
    w: box.width / r.width,
    h: box.height / r.height
  };
  els.verifyBtn.disabled = false;
  els.askBtn.disabled = false;
});

function updateBox(x, y, w, h) {
  els.selBox.style.left = x + "px";
  els.selBox.style.top = y + "px";
  els.selBox.style.width = w + "px";
  els.selBox.style.height = h + "px";
}

// ---------- Verify (pulse + motion on the selected tile) ----------
els.verifyBtn.addEventListener("click", async () => {
  if (!stream || !roi) return;
  els.verifyBtn.disabled = true;
  els.verifyBtn.textContent = "Analyzing ~10s…";
  setSignal("pulse", "warn", "measuring…");
  setSignal("motion", "warn", "measuring…");

  const pulseEst = new TrustLayer.PulseEstimator(els.video, els.work, roi);
  const motionDet = new TrustLayer.MotionDetector(els.video, els.work);

  const [motion, pulse] = await Promise.all([
    motionDet.run(3000, roi),
    pulseEst.run(10000)
  ]);

  if (pulse.detected) {
    setSignal("pulse", "ok", `~${pulse.bpm} BPM`);
    state.pulseDetected = true; state.bpm = pulse.bpm;
  } else {
    setSignal("pulse", "bad", "no pulse signal");
    state.pulseDetected = false;
  }

  if (motion.alive) setSignal("motion", "ok", "natural motion");
  else setSignal("motion", "bad", "static / looped");
  // Fold a frozen tile into the humanity signal.
  if (!motion.alive) state.pulseDetected = false;

  els.verifyBtn.disabled = false;
  els.verifyBtn.textContent = "Verify this person";
  await submitVerdict();
});

// ---------- Live challenge (ask them to move) ----------
els.askBtn.addEventListener("click", async () => {
  if (!stream || !roi) return;
  const ch = TrustLayer.pickChallenge();
  els.askBtn.disabled = true;
  els.challengeBanner.hidden = false;

  const det = new TrustLayer.MotionDetector(els.video, els.work);
  const res = await det.challenge({
    roi,
    onBaseline: () => { els.challengeBanner.textContent = "Measuring their baseline… (don't ask yet)"; },
    onPrompt: () => { els.challengeBanner.textContent = "ASK THEM: " + ch.text; }
  });

  els.challengeBanner.textContent = res.passed
    ? "✓ They responded live"
    : "✗ No real-time response";
  await wait(1500);
  els.challengeBanner.hidden = true;

  state.challengePassed = res.passed;
  setSignal("challenge", res.passed ? "ok" : "bad",
    res.passed ? `passed (${res.ratio}× baseline)` : `weak (${res.ratio}× baseline)`);
  els.askBtn.disabled = false;
  await submitVerdict();
});

// ---------- Shared UI helpers ----------
function setSignal(key, status, val) {
  const li = document.querySelector(`.signal[data-key="${key}"]`);
  if (!li) return;
  li.setAttribute("data-status", status);
  li.querySelector(".val").textContent = val;
}

function setScoreRing(score) {
  const color = score >= 70 ? "var(--ok)" : score >= 40 ? "var(--warn)" : "var(--bad)";
  els.scoreRing.style.background = `conic-gradient(${color} ${score / 100 * 360}deg, var(--panel-2) 0deg)`;
  els.scoreNum.textContent = score;
}

async function submitVerdict() {
  const resp = await fetch("/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
  const data = await resp.json();
  setScoreRing(data.confidence);
  els.scoreVerdict.textContent = prettyVerdict(data.verdict);

  const chip = data.confidence >= 70 ? "ok" : data.confidence >= 40 ? "warn" : "bad";
  els.verdictChip.setAttribute("data-state", chip);
  els.verdictChip.textContent = prettyVerdict(data.verdict);

  els.reasons.innerHTML = "";
  data.reasons.forEach((r) => {
    const li = document.createElement("li");
    li.className = r.level; li.textContent = r.text;
    els.reasons.appendChild(li);
  });
  if (!data.reasons.length) els.reasons.innerHTML = '<li class="muted">No signals yet.</li>';
  els.apiRaw.textContent = JSON.stringify(data, null, 2);
}

function prettyVerdict(v) {
  return {
    verified_live_human: "Verified live human",
    needs_step_up: "Needs step-up verification",
    likely_synthetic: "Likely synthetic / deepfake"
  }[v] || v;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

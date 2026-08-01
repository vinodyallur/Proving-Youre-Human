/* TrustLayer UI controller */

const els = {
  video: document.getElementById("video"),
  work: document.getElementById("work"),
  roi: document.getElementById("roi"),
  startBtn: document.getElementById("startBtn"),
  scanBtn: document.getElementById("scanBtn"),
  challengeBtn: document.getElementById("challengeBtn"),
  challengeBanner: document.getElementById("challengeBanner"),
  verdictChip: document.getElementById("verdictChip"),
  scoreRing: document.getElementById("scoreRing"),
  scoreNum: document.getElementById("scoreNum"),
  scoreVerdict: document.getElementById("scoreVerdict"),
  reasons: document.getElementById("reasons"),
  apiRaw: document.getElementById("apiRaw"),
  simDeepfake: document.getElementById("simDeepfake")
};

const isSim = () => els.simDeepfake && els.simDeepfake.checked;

let stream = null;
const state = {}; // accumulated signals sent to the API

function setSignal(key, status, val) {
  const li = document.querySelector(`.signal[data-key="${key}"]`);
  if (!li) return;
  li.setAttribute("data-status", status);
  li.querySelector(".val").textContent = val;
}

function setScoreRing(score) {
  const color =
    score >= 70 ? "var(--ok)" : score >= 40 ? "var(--warn)" : "var(--bad)";
  const deg = (score / 100) * 360;
  els.scoreRing.style.background = `conic-gradient(${color} ${deg}deg, var(--panel-2) 0deg)`;
  els.scoreNum.textContent = score;
}

// ---- Start capture ----
els.startBtn.addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: true
    });
    els.video.srcObject = stream;
    els.startBtn.textContent = "Camera running";
    els.startBtn.disabled = true;
    els.scanBtn.disabled = false;
    els.challengeBtn.disabled = false;

    // Immediate device check on start.
    const dev = await TrustLayer.inspectDevices(stream);
    applyDeviceResult(dev);
  } catch (e) {
    alert("Camera/mic permission is required for the demo.\n\n" + e.message);
  }
});

function applyDeviceResult(dev) {
  // Camera
  if (dev.camera.status === "virtual") {
    setSignal("camera", "bad", `Virtual: ${dev.camera.matched}`);
    state.virtualCameraDetected = true;
  } else if (dev.camera.status === "physical") {
    setSignal("camera", "ok", shorten(dev.camera.label));
    state.virtualCameraDetected = false;
  } else {
    setSignal("camera", "warn", "label hidden");
  }
  state.noHardwareCamera = dev.noHardwareCamera;

  // Mic
  if (dev.mic.status === "virtual") {
    setSignal("mic", "bad", `Virtual: ${dev.mic.matched}`);
    state.virtualMicDetected = true;
  } else if (dev.mic.status === "physical") {
    setSignal("mic", "ok", shorten(dev.mic.label));
    state.virtualMicDetected = false;
  } else {
    setSignal("mic", "warn", "label hidden");
  }
}

function shorten(s) {
  s = (s || "").replace(/\(.*?\)/g, "").trim();
  return s.length > 26 ? s.slice(0, 26) + "…" : s || "physical device";
}

// ---- Full scan ----
els.scanBtn.addEventListener("click", async () => {
  if (!stream) return;
  els.scanBtn.disabled = true;
  els.scanBtn.textContent = "Scanning…";
  els.roi.classList.add("active");

  // Deepfake simulation: force the synthetic-source signals so you can test
  // the non-human verdict without installing a virtual-camera tool.
  if (isSim()) {
    await runSimulatedScan();
    els.roi.classList.remove("active");
    els.scanBtn.disabled = false;
    els.scanBtn.textContent = "Run full scan";
    await submitVerdict();
    return;
  }

  // Re-check devices.
  const dev = await TrustLayer.inspectDevices(stream);
  applyDeviceResult(dev);

  // Run liveness detectors.
  setSignal("pulse", "warn", "measuring ~10s…");
  setSignal("motion", "warn", "measuring…");
  setSignal("audio", "warn", "listening…");

  const pulseEst = new TrustLayer.PulseEstimator(els.video, els.work);
  const motionDet = new TrustLayer.MotionDetector(els.video, els.work);
  const audioAn = new TrustLayer.AudioAnalyzer(stream);

  // Audio + motion are short; pulse needs ~10s. Run concurrently.
  const [audio, motion, pulse] = await Promise.all([
    audioAn.run(3000),
    motionDet.run(3000),
    pulseEst.run(10000)
  ]);

  // Pulse
  if (pulse.detected) {
    setSignal("pulse", "ok", `~${pulse.bpm} BPM`);
    state.pulseDetected = true; state.bpm = pulse.bpm;
  } else {
    setSignal("pulse", "bad", "no pulse signal");
    state.pulseDetected = false;
  }

  // Motion
  if (motion.alive) setSignal("motion", "ok", "natural micro-motion");
  else setSignal("motion", "bad", "static / frozen");

  // Audio
  if (audio.natural) { setSignal("audio", "ok", audio.note); state.audioNaturalNoiseFloor = true; }
  else if (audio.natural === false) { setSignal("audio", "bad", audio.note); state.audioNaturalNoiseFloor = false; }
  else setSignal("audio", "warn", audio.note);

  els.roi.classList.remove("active");
  els.scanBtn.disabled = false;
  els.scanBtn.textContent = "Run full scan";

  await submitVerdict();
});

// Forced "synthetic feed" signals for the simulation toggle.
async function runSimulatedScan() {
  setSignal("camera", "warn", "checking…");
  await wait(600);
  setSignal("camera", "bad", "Virtual: obs virtual camera");
  setSignal("mic", "bad", "Virtual: vb-audio cable");
  state.virtualCameraDetected = true;
  state.virtualMicDetected = true;
  state.noHardwareCamera = false;

  setSignal("pulse", "warn", "measuring…");
  setSignal("motion", "warn", "measuring…");
  setSignal("audio", "warn", "listening…");
  await wait(1200);

  setSignal("pulse", "bad", "no pulse signal");
  setSignal("motion", "bad", "static / looped");
  setSignal("audio", "bad", "unnaturally clean");
  state.pulseDetected = false;
  state.bpm = null;
  state.audioNaturalNoiseFloor = false;
  state.challengePassed = false;
  setSignal("challenge", "bad", "no live response");
}

// ---- Live challenge ----
els.challengeBtn.addEventListener("click", async () => {
  if (!stream) return;

  if (isSim()) {
    els.challengeBanner.hidden = false;
    els.challengeBanner.textContent = TrustLayer.pickChallenge().text;
    await wait(1500);
    els.challengeBanner.textContent = "✗ No response (synthetic feed)";
    await wait(1200);
    els.challengeBanner.hidden = true;
    state.challengePassed = false;
    setSignal("challenge", "bad", "failed");
    await submitVerdict();
    return;
  }

  const ch = TrustLayer.pickChallenge();
  els.challengeBtn.disabled = true;

  // Baseline motion, then issue challenge, then check for a response spike.
  const det = new TrustLayer.MotionDetector(els.video, els.work);
  els.challengeBanner.hidden = false;
  els.challengeBanner.textContent = "Get ready…";
  await wait(800);

  els.challengeBanner.textContent = ch.text;
  const res = await det.run(3500);
  els.challengeBanner.textContent = res.alive ? "✓ Response detected" : "✗ No response";
  await wait(1200);
  els.challengeBanner.hidden = true;

  state.challengePassed = res.alive;
  setSignal("challenge", res.alive ? "ok" : "bad", res.alive ? "passed" : "failed");
  els.challengeBtn.disabled = false;

  await submitVerdict();
});

// ---- Call the verification API ----
async function submitVerdict() {
  const resp = await fetch("/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
  const data = await resp.json();

  setScoreRing(data.confidence);
  els.scoreVerdict.textContent = prettyVerdict(data.verdict);

  const chipState =
    data.confidence >= 70 ? "ok" : data.confidence >= 40 ? "warn" : "bad";
  els.verdictChip.setAttribute("data-state", chipState);
  els.verdictChip.textContent = prettyVerdict(data.verdict);

  els.reasons.innerHTML = "";
  data.reasons.forEach((r) => {
    const li = document.createElement("li");
    li.className = r.level;
    li.textContent = r.text;
    els.reasons.appendChild(li);
  });
  if (!data.reasons.length) {
    els.reasons.innerHTML = '<li class="muted">No signals yet.</li>';
  }

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

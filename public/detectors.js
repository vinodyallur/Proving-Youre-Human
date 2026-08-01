/* TrustLayer detection engine — runs entirely in the browser. */

/**
 * Known virtual / injected capture devices used by deepfake and streaming tools.
 * Matched case-insensitively against device labels.
 */
const VIRTUAL_CAMERA_PATTERNS = [
  "obs virtual", "obs-camera", "obs camera",
  "manycam", "xsplit", "snap camera", "snapcamera",
  "droidcam", "iriun", "epoccam", "ndi",
  "virtual camera", "virtualcam", "vcam",
  "e2esoft", "avatarify", "deepfacelive", "deep face live",
  "unity video capture", "unreal", "splitcam", "webcamoid",
  "logi capture" // logitech virtual pipe – flag as soft signal
];

const VIRTUAL_MIC_PATTERNS = [
  "vb-audio", "vb audio", "cable output", "cable input", "vb-cable",
  "voicemeeter", "virtual audio", "virtualaudio",
  "obs-audio", "obs monitor", "soundflower", "blackhole",
  "stereo mix", "wave link", "elgato", "ndi audio",
  "voice changer", "clownfish", "morphvox"
];

function classifyDevice(label, patterns) {
  const l = (label || "").toLowerCase();
  if (!l) return { status: "unknown", label: "(permission needed for label)" };
  const hit = patterns.find((p) => l.includes(p));
  if (hit) return { status: "virtual", matched: hit, label };
  return { status: "physical", label };
}

/** Enumerate active devices and classify the ones currently in use. */
async function inspectDevices(stream) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");

  // Prefer the label of the track actually in the stream.
  const activeCamLabel = stream?.getVideoTracks?.()[0]?.label || cams[0]?.label || "";
  const activeMicLabel = stream?.getAudioTracks?.()[0]?.label || mics[0]?.label || "";

  const camera = classifyDevice(activeCamLabel, VIRTUAL_CAMERA_PATTERNS);
  const mic = classifyDevice(activeMicLabel, VIRTUAL_MIC_PATTERNS);

  return {
    camera,
    mic,
    cameraCount: cams.length,
    micCount: mics.length,
    noHardwareCamera: cams.length === 0
  };
}

/**
 * rPPG pulse estimate.
 * Samples the mean green-channel value of a face-region ROI over ~10s and
 * looks for a dominant periodicity in the human heart-rate band (0.7–4 Hz).
 * A live face has a subtle but real periodic signal; many synthetic feeds don't.
 */
class PulseEstimator {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.samples = [];
    this.times = [];
    this.running = false;
  }

  _sampleFrame() {
    const { video, canvas, ctx } = this;
    if (!video.videoWidth) return;
    canvas.width = 320; canvas.height = 240;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // ROI ~ center-face box matching the on-screen guide.
    const x = Math.floor(canvas.width * 0.35);
    const y = Math.floor(canvas.height * 0.22);
    const w = Math.floor(canvas.width * 0.30);
    const h = Math.floor(canvas.height * 0.34);
    const data = ctx.getImageData(x, y, w, h).data;
    let g = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) { g += data[i + 1]; n++; }
    this.samples.push(g / n);
    this.times.push(performance.now());
  }

  async run(ms = 10000) {
    this.samples = []; this.times = []; this.running = true;
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (!this.running || performance.now() - start > ms) {
          this.running = false;
          resolve(this._analyze());
          return;
        }
        this._sampleFrame();
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  _analyze() {
    const s = this.samples;
    if (s.length < 60) return { detected: false, bpm: null, quality: 0 };

    // Effective sample rate.
    const durSec = (this.times[this.times.length - 1] - this.times[0]) / 1000;
    const fs = s.length / durSec;

    // Detrend (remove mean) + simple normalization.
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const x = s.map((v) => v - mean);

    // Brute-force periodogram across the heart-rate band.
    let best = { bpm: null, power: 0 };
    for (let bpm = 42; bpm <= 180; bpm += 1) {
      const f = bpm / 60;
      let re = 0, im = 0;
      for (let i = 0; i < x.length; i++) {
        const t = (this.times[i] - this.times[0]) / 1000;
        re += x[i] * Math.cos(2 * Math.PI * f * t);
        im += x[i] * Math.sin(2 * Math.PI * f * t);
      }
      const power = (re * re + im * im);
      if (power > best.power) best = { bpm, power };
    }

    // Signal-to-noise: dominant power vs. total variance.
    const variance = x.reduce((a, b) => a + b * b, 0) || 1;
    const snr = best.power / variance;
    const detected = snr > 6 && best.bpm != null;

    return {
      detected,
      bpm: detected ? best.bpm : null,
      quality: Math.min(1, snr / 20),
      fs: Math.round(fs)
    };
  }
}

/**
 * Audio noise-floor analysis.
 * Real microphones in real rooms have a non-zero, textured noise floor.
 * Injected/synthetic audio is often unnaturally clean or spectrally flat.
 */
class AudioAnalyzer {
  constructor(stream) {
    this.stream = stream;
  }

  async run(ms = 3000) {
    const track = this.stream.getAudioTracks()[0];
    if (!track) return { natural: null, rms: 0, note: "no audio track" };

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const rmsReadings = [];
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        rmsReadings.push(Math.sqrt(sum / buf.length));
        if (performance.now() - start > ms) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
    ctx.close();

    const avg = rmsReadings.reduce((a, b) => a + b, 0) / rmsReadings.length;
    const min = Math.min(...rmsReadings);
    const jitter = avg - min; // real rooms fluctuate

    // Heuristic: some energy + some fluctuation => natural.
    const natural = avg > 0.0008 && jitter > 0.0002;
    return {
      natural,
      rms: avg,
      note: natural ? "textured room noise present" : "suspiciously flat / silent"
    };
  }
}

/**
 * Micro-motion detector — frame-to-frame pixel change in the ROI.
 * A completely static or looped feed shows near-zero natural micro-motion.
 */
class MotionDetector {
  constructor(video, canvas) {
    this.video = video; this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.prev = null;
  }
  async run(ms = 3000) {
    const diffs = [];
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const { video, canvas, ctx } = this;
        if (video.videoWidth) {
          canvas.width = 160; canvas.height = 120;
          ctx.drawImage(video, 0, 0, 160, 120);
          const cur = ctx.getImageData(0, 0, 160, 120).data;
          if (this.prev) {
            let d = 0;
            for (let i = 0; i < cur.length; i += 16) d += Math.abs(cur[i] - this.prev[i]);
            diffs.push(d);
          }
          this.prev = cur;
        }
        if (performance.now() - start > ms) return resolve();
        requestAnimationFrame(tick);
      };
      tick();
    });
    const avg = diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1);
    const variation = Math.max(...diffs, 0) - Math.min(...diffs, 0);
    // Natural: some motion but not frozen, and it fluctuates.
    const alive = avg > 200 && variation > 100;
    return { alive, avg: Math.round(avg) };
  }
}

/** Random live challenge to defeat pre-rendered / looped feeds. */
const CHALLENGES = [
  { text: "Turn your head slowly to the LEFT", type: "motion" },
  { text: "Turn your head slowly to the RIGHT", type: "motion" },
  { text: "Lean CLOSER to the camera", type: "motion" },
  { text: "Blink twice, slowly", type: "motion" },
  { text: "Raise your hand into frame", type: "motion" }
];

function pickChallenge() {
  return CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
}

window.TrustLayer = {
  inspectDevices,
  PulseEstimator,
  AudioAnalyzer,
  MotionDetector,
  pickChallenge
};

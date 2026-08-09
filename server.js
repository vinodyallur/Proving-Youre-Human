import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "public")));

/**
 * The "layer every app checks" endpoint.
 * A client submits the signals it gathered locally (device flags, liveness,
 * challenge result). The server applies a policy and returns a verdict.
 *
 * This mirrors how a bank / dating app / call platform would call TrustLayer:
 *   POST /api/verify  ->  { isHuman, isLiveHardware, confidence, reasons }
 *
 * Raw biometrics never leave the browser. We only receive derived signals.
 */
app.post("/api/verify", (req, res) => {
  const s = req.body || {};

  const reasons = [];
  let score = 100;

  // --- Capture-source authenticity ---
  if (s.virtualCameraDetected) {
    score -= 55;
    reasons.push({ level: "critical", text: "Virtual camera device detected (software feed, not a physical sensor)." });
  }
  if (s.virtualMicDetected) {
    score -= 40;
    reasons.push({ level: "critical", text: "Virtual/injected audio device detected." });
  }
  if (s.noHardwareCamera) {
    score -= 30;
    reasons.push({ level: "warn", text: "No recognizable physical camera present." });
  }

  // --- Liveness signals ---
  if (s.pulseDetected === false) {
    score -= 20;
    reasons.push({ level: "warn", text: "No physiological pulse (rPPG) signal detected in the face region." });
  } else if (s.pulseDetected === true) {
    reasons.push({ level: "ok", text: `Pulse signal present (~${s.bpm || "?"} BPM).` });
  }

  if (s.audioNaturalNoiseFloor === false) {
    score -= 15;
    reasons.push({ level: "warn", text: "Audio noise floor is unnaturally clean (possible synthetic audio)." });
  }

  // --- Challenge-response ---
  if (s.challengePassed === true) {
    reasons.push({ level: "ok", text: "Live challenge-response passed." });
  } else if (s.challengePassed === false) {
    score -= 25;
    reasons.push({ level: "warn", text: "Live challenge-response failed or timed out." });
  }

  score = Math.max(0, Math.min(100, score));

  let verdict = "verified_live_human";
  if (score < 40) verdict = "likely_synthetic";
  else if (score < 70) verdict = "needs_step_up";

  const result = {
    verdict,
    confidence: score,
    isLiveHardware:!s.virtualCameraDetected &&!s.virtualMicDetected &&!s.noHardwareCamera,
    isHuman: score >= 40,
    reasons,
    // A signed attestation an app could forward as proof it checked.
    attestation: sign({ verdict, confidence: score, ts: Date.now() }),
    issuedAt: new Date().toISOString()
  };

  res.json(result);
});

// Demo-only signing so the response carries a tamper-evident token.
const SECRET = process.env.TRUSTLAYER_SECRET || "dev-demo-secret-change-me";
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => {
  console.log(`TrustLayer demo running at http://localhost:${PORT}`);
});
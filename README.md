# TrustLayer

Is there a real, live human behind this camera — or a deepfake piped through a virtual device?

TrustLayer detects the common deepfake-attack path: a synthetic video/audio feed
injected through a **virtual camera / virtual microphone** (OBS Virtual Camera,
ManyCam, VB-Cable, Voicemeeter, DeepFaceLive, etc.). Instead of playing the losing
"is this face fake?" ML arms race, it asks the more tractable question:
**"is this stream coming from real physical capture hardware, and is a live human present?"**

## What it checks

**Capture-source authenticity**
- Enumerates active camera/mic devices and flags known virtual/injected drivers.

**Liveness signals**
- **Pulse (rPPG):** extracts a heartbeat signal from subtle skin-color changes in the face region.
- **Micro-motion:** detects natural movement vs. a frozen / looped feed.
- **Audio noise floor:** real rooms/mics have textured noise; synthetic audio is often unnaturally clean.
- **Challenge-response:** issues a random live prompt (turn head, blink, raise hand) and verifies a real-time reaction.

**Verdict**
- All signals are aggregated by a policy engine into a confidence score and one of:
  `verified_live_human` / `needs_step_up` / `likely_synthetic`.
- The server returns a signed attestation an app could forward as proof it checked — the
  "layer every bank, app, and video call checks before it trusts anyone."

## Privacy

Raw video and audio **never leave the browser**. Only derived signals
(device flags, pulse present y/n, challenge pass/fail) are sent to the verification API.

## Run

```bash
npm install
npm start
```

Then open http://localhost:5173 and click **Start camera & mic**.

To see it catch an attack: install OBS, enable **Start Virtual Camera**, select
"OBS Virtual Camera" as your webcam, and run a scan — the camera signal turns red.

## Architecture

- `public/detectors.js` — in-browser detection engine (device DB, rPPG, audio, motion, challenge).
- `public/app.js` — UI controller and signal aggregation.
- `server.js` — `/api/verify` policy engine + signed attestation (the productizable core).

## Limitations (be honest with investors)

- Browser sandboxes limit deep driver/hardware inspection. A **native desktop agent**
  goes much further (kernel-level device provenance, sensor fingerprinting).
- A determined attacker can rename a virtual device or use an HDMI capture card.
  This is **defense-in-depth**, not a single silver bullet — each layer raises attacker cost.
- The endgame is **hardware capture attestation (C2PA + secure enclave)** where the
  camera signs its own pixels. This demo is the wedge toward that.

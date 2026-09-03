#!/usr/bin/env node
// Manual end-to-end check for the Linux loopback renderer bridging (spike
// branch). Drives the REAL Electron app via Playwright's _electron API
// (same mechanism the repo's own e2e/fixtures/electron.ts uses), starts a
// recording, plays real audio into the default sink while it's running,
// stops it, and inspects the resulting file's channels with ffmpeg to prove
// system audio actually made it through: IPC chunk -> AudioData ->
// MediaStreamTrackGenerator -> AudioContext mix -> MediaRecorder -> disk.
//
// Not a permanent e2e spec — a throwaway verification script for this spike.
// Requires the renderer built (npm run build:renderer) and the PyInstaller
// backend at dist/stenoai/. Run from app/: node scripts/linux-loopback-e2e-check.js

const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { measurePeakRms } = require('../../scripts/measure-pcm');

const APP_DIR = path.resolve(__dirname, '..');

async function waitFor(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// A distro without the ALSA sample would otherwise play silence and the check
// would blame the bridge. Synthesise a tone instead of depending on a fixture
// that only some installs ship.
function resolveTone(dir) {
  const alsaSample = '/usr/share/sounds/alsa/Front_Center.wav';
  if (fs.existsSync(alsaSample)) return alsaSample;
  const out = path.join(dir, 'tone.wav');
  const rate = 48000;
  const seconds = 1;
  const frames = rate * seconds;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    // 440 Hz at roughly half scale — loud enough to clear any noise floor.
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);     // byte rate
  header.writeUInt16LE(2, 32);            // block align
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([header, data]));
  console.log(`ALSA sample missing; synthesised a 440 Hz tone at ${out}`);
  return out;
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stenoai-linux-loopback-check-'));
  // Mirrors e2e/fixtures/user-config.ts's enableDeterministicRecording: whisper
  // engine skips the parakeet-only live-transcript tap, system_audio_enabled
  // doesn't gate anything on non-mac (loopback is always-on when supported)
  // but is set for parity with the real fixture.
  fs.writeFileSync(
    path.join(userDataDir, 'config.json'),
    JSON.stringify({ system_audio_enabled: true, transcription_engine: 'whisper' }),
  );

  console.log('userDataDir:', userDataDir);
  const tonePath = resolveTone(userDataDir);

  const app = await electron.launch({
    args: [
      '.',
      // Fake the MIC only — system audio is real (that's what we're proving).
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    cwd: APP_DIR,
    env: {
      ...process.env,
      STENOAI_E2E: '1',
      STENOAI_E2E_HEADLESS: '1',
      STENOAI_USER_DATA_DIR: userDataDir,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-app-ready]', { timeout: 30_000 });
    console.log('app ready');

    const support = await page.evaluate(() => window.stenoai.recording.getSystemAudioSupport());
    console.log('getSystemAudioSupport():', support);
    if (!support?.data?.supported && !support?.supported) {
      throw new Error('system audio not reported as supported — cannot proceed');
    }

    const started = await page.evaluate((name) => window.stenoai.recording.start(name), 'LoopbackCheck');
    console.log('start():', started);
    if (!started.success) throw new Error('recording start failed: ' + started.error);

    // Wait for capture to be genuinely live rather than guessing with a fixed
    // delay. The renderer opens the on-disk file only after the loopback stream
    // is acquired and the audio graph is wired, so the file appearing is a real
    // signal — and needs no test-only hook in production code.
    const recordingsDir = path.join(userDataDir, 'recordings');
    await waitFor(
      () => fs.existsSync(recordingsDir)
        && fs.readdirSync(recordingsDir).some((f) => f.startsWith('sysaudio-')),
      'capture to start',
    );

    console.log(`playing test audio into the default sink (${tonePath})...`);
    const players = [];
    for (let i = 0; i < 5; i++) {
      players.push(spawn('pw-play', ['--volume=1.0', tonePath]));
      await new Promise((r) => setTimeout(r, 900));
    }
    await new Promise((r) => setTimeout(r, 600));
    for (const p of players) { try { p.kill(); } catch { /* already exited */ } }

    const stopped = await page.evaluate(() => window.stenoai.recording.stop());
    console.log('stop():', stopped);
    if (!stopped.success) throw new Error('recording stop failed: ' + stopped.error);

    // Poll for a file whose size has stopped changing rather than guessing:
    // scanning mid-flush yields either "no file" or a truncated WebM, both of
    // which read as a broken bridge. Needs several consecutive unchanged reads
    // — MediaRecorder writes a timeslice per second, so two 250ms samples can
    // both land in the gap between chunks and call a growing file finished
    // (which shows up as ffmpeg's "File ended prematurely" and mismatched
    // per-channel sample counts).
    const STABLE_READS = 6;
    let webmPath = null;
    let lastSize = -1;
    let stableReads = 0;
    await waitFor(async () => {
      const files = fs.existsSync(recordingsDir)
        ? fs.readdirSync(recordingsDir).filter((f) => f.startsWith('sysaudio-'))
        : [];
      if (files.length === 0) return false;
      webmPath = path.join(recordingsDir, files[0]);
      const size = fs.statSync(webmPath).size;
      stableReads = size > 0 && size === lastSize ? stableReads + 1 : 0;
      lastSize = size;
      return stableReads >= STABLE_READS;
    }, 'the recording to finish flushing');
    console.log('recording file:', webmPath, lastSize, 'bytes');

    // Split L (mic, faked/silent) and R (system, real pw-record capture)
    // channels to raw PCM and measure each independently.
    const lPath = path.join(userDataDir, 'left.raw');
    const rPath = path.join(userDataDir, 'right.raw');
    // Same approach as the backend's _split_stereo_to_channels (src/transcriber.py):
    // ffmpeg's pan filter, not -map_channel (removed/finicky across ffmpeg builds).
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webmPath, '-af', 'pan=mono|c0=c0', '-f', 's16le', lPath]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webmPath, '-af', 'pan=mono|c0=c1', '-f', 's16le', rPath]);

    const left = measurePeakRms(fs.readFileSync(lPath));
    const right = measurePeakRms(fs.readFileSync(rPath));
    console.log('L (mic, faked device):', left);
    console.log('R (system loopback, real pw-record):', right);

    const THRESHOLD = 500; // out of 32768 — well above any residual noise floor
    if (right.peak < THRESHOLD) {
      throw new Error(
        `FAIL: R channel peak ${right.peak} is below threshold ${THRESHOLD} — ` +
          'system audio did not make it through the MediaStreamTrackGenerator bridge.',
      );
    }
    console.log('\nPASS: real system audio was captured end-to-end through the Linux loopback bridge into the actual recording file.');
  } finally {
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('close-timeout')), 10_000)),
      ]);
    } catch {
      try { app.process()?.kill('SIGKILL'); } catch { /* already gone */ }
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

main().catch((err) => {
  console.error('\nCHECK FAILED:', err.message);
  process.exit(1);
});

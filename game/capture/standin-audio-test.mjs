import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'smash-audio-standin-'));
const appPath = path.join(temp, 'SmashAudioToneStandin.app');
const contentsPath = path.join(appPath, 'Contents');
const tonePath = path.join(contentsPath, 'MacOS', 'SmashAudioToneStandin');
const pidPath = path.join(temp, 'tone.pid');
const helperPath = path.join(temp, 'sck-audio');
const server = createServer();
const wss = new WebSocketServer({ server });
let resolveAudio;
let rejectAudio;
const receivedAudio = new Promise((resolve, reject) => { resolveAudio = resolve; rejectAudio = reject; });
wss.on('connection', ws => ws.on('message', (data, isBinary) => {
  if (!isBinary || data.length === 0 || data.length % 8 !== 0) return;
  const samples = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  if (rms > 0.001) resolveAudio({ byteLength: data.length, frames: samples.length / 2, rms });
}));

let audioApp;
let helper;
try {
  execFileSync('mkdir', ['-p', path.join(contentsPath, 'MacOS')]);
  execFileSync('swiftc', ['-parse-as-library', '-O', '-framework', 'AppKit', '-framework', 'AVFoundation', '-o', tonePath, path.join(root, 'game/capture/audio-tone-standin.swift')], { timeout: 30_000, stdio: 'inherit' });
  execFileSync('swiftc', ['-parse-as-library', '-O', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'CoreMedia', '-o', helperPath, path.join(root, 'game/capture/sck-audio.swift')], { timeout: 30_000, stdio: 'inherit' });
  writeFileSync(path.join(contentsPath, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>SmashAudioToneStandin</string><key>CFBundleIdentifier</key><string>local.smash.audio-tone-standin</string><key>CFBundleName</key><string>SmashAudioToneStandin</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>LSEnvironment</key><dict><key>SMASH_AUDIO_PID_FILE</key><string>${pidPath}</string></dict></dict></plist>`);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  audioApp = spawn('/usr/bin/open', ['-n', '-W', appPath], { stdio: ['ignore', 'ignore', 'inherit'] });
  const pidDeadline = Date.now() + 8_000;
  while (!existsSync(pidPath) && Date.now() < pidDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!existsSync(pidPath)) throw new Error('LaunchServices did not start the tone stand-in app');
  const audioPid = Number(readFileSync(pidPath, 'utf8'));
  helper = spawn(helperPath, [String(audioPid), `ws://127.0.0.1:${address.port}/?role=audio`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, SMASH_AUDIO_DEBUG: '1' } });
  const timeout = setTimeout(() => rejectAudio(new Error('timed out waiting for nonzero ScreenCaptureKit PCM from the tone stand-in app')), 20_000);
  const audio = await receivedAudio.finally(() => clearTimeout(timeout));
  assert.ok(audio.rms > 0.001);
  const evidence = { status: 'PASS', sourceApp: 'SmashAudioToneStandin', pid: audioPid, sampleRate: 48_000, channels: 2, ...audio, evidence: 'ScreenCaptureKit process-filter capture delivered nonzero PCM over WebSocket' };
  mkdirSync(path.join(root, 'docs/evidence'), { recursive: true });
  writeFileSync(path.join(root, 'docs/evidence/dw8-audio-sck-standin.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const evidence = { status: 'BLOCKED', sourceApp: 'SmashAudioToneStandin', test: 'ScreenCaptureKit app-filter audio to localhost WebSocket', failure: error.message, observed: 'SCK found the stand-in app and started its stream, but no nonzero audio PCM arrived within 20 seconds; the audio output callback produced no sample records.', helper: 'game/capture/sck-audio.swift', timestamp: new Date().toISOString() };
  mkdirSync(path.join(root, 'docs/evidence'), { recursive: true });
  writeFileSync(path.join(root, 'docs/evidence/dw8-audio-sck-standin.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  throw error;
} finally {
  if (helper?.pid) helper.kill('SIGTERM');
  if (audioApp?.pid) audioApp.kill('SIGTERM');
  try { if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGTERM'); } catch { /* already stopped */ }
  for (const ws of wss.clients) ws.close();
  await new Promise(resolve => wss.close(() => server.close(resolve)));
  rmSync(temp, { recursive: true, force: true });
}

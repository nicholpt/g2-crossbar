// "Ask" by voice: glasses mic PCM → speech segmentation → local Whisper
// (whisper.cpp's whisper-server, started on demand and kept loaded).
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const RATE = 16000;
const FRAME = 480; // 30 ms of 16-bit mono samples
const FRAME_MS = 30;
const WHISPER_PORT = Number(process.env.WHISPER_PORT || 8178);
const MODEL = process.env.WHISPER_MODEL || join(import.meta.dirname, 'models', 'ggml-small.en.bin');
const MIN_RMS = Number(process.env.VOICE_MIN_RMS || 400);
// A descriptive hint helps Whisper with agent names and coding words.
const PROMPT = process.env.WHISPER_PROMPT || 'Voice notes for coding agents such as Claude, Codex, Gemini and Kimi.';

// --- speech segmentation (energy VAD with an adaptive noise floor) --------------
export class Segmenter {
  constructor(onUtterance) {
    this.onUtterance = onUtterance;
    this.rest = Buffer.alloc(0);
    this.noise = 300;
    this.pre = [];
    this.speech = null;
    this.voiced = 0;
    this.silent = 0;
  }
  push(chunk) {
    let buf = Buffer.concat([this.rest, chunk]);
    while (buf.length >= FRAME * 2) {
      this.frame(buf.subarray(0, FRAME * 2));
      buf = buf.subarray(FRAME * 2);
    }
    this.rest = Buffer.from(buf);
  }
  frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i += 2) { const s = f.readInt16LE(i); sum += s * s; }
    const rms = Math.sqrt(sum / FRAME);
    const loud = rms > Math.max(this.noise * 3, MIN_RMS);
    if (!this.speech) {
      if (!loud) this.noise = this.noise * 0.95 + rms * 0.05;
      this.pre.push(Buffer.from(f));
      if (this.pre.length > 10) this.pre.shift(); // 300 ms pre-roll
      this.voiced = loud ? this.voiced + 1 : 0;
      if (this.voiced >= 3) { this.speech = this.pre; this.pre = []; this.silent = 0; }
      return;
    }
    this.speech.push(Buffer.from(f));
    this.silent = loud ? 0 : this.silent + 1;
    const ms = this.speech.length * FRAME_MS;
    if (this.silent * FRAME_MS >= 700 || ms >= 20_000) {
      const pcm = Buffer.concat(this.speech);
      const voicedMs = ms - this.silent * FRAME_MS;
      this.speech = null;
      this.voiced = 0;
      if (voicedMs >= 300) this.onUtterance(pcm);
    }
  }
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// --- local Whisper (whisper.cpp server, model kept loaded) -------------------------
let whisper = null;
let whisperReady = null;
const whisperUp = () => fetch(`http://127.0.0.1:${WHISPER_PORT}/`).then(() => true, () => false);

function ensureWhisper() {
  if (whisperReady) return whisperReady;
  whisperReady = (async () => {
    // Reuse a server a crashed bridge left behind instead of spawning one that
    // can't bind the port.
    if (await whisperUp()) return;
    whisper = spawn('whisper-server', ['-m', MODEL, '--host', '127.0.0.1', '--port', String(WHISPER_PORT), '-nt'],
      { stdio: 'ignore' });
    whisper.on('exit', () => { whisper = null; whisperReady = null; });
    for (let i = 0; i < 60; i++) {
      if (await whisperUp()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('whisper-server did not start');
  })();
  whisperReady.catch(() => { whisperReady = null; });
  return whisperReady;
}

export async function transcribe(pcm) {
  await ensureWhisper();
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'utterance.wav');
  form.append('response_format', 'json');
  form.append('prompt', PROMPT);
  try {
    const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
    return String((await r.json()).text || '').trim();
  } catch (e) {
    whisperReady = null; // a reused server may have died: respawn next time
    throw e;
  }
}

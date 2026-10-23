// "Ask" by voice and live subtitles: glasses mic PCM → speech segmentation →
// local Whisper (whisper.cpp's whisper-server, started on demand and kept loaded).
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
  constructor(onUtterance, { maxMs = 20_000 } = {}) {
    this.onUtterance = onUtterance;
    this.maxMs = maxMs; // a phrase this long is cut even without a pause
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
    if (this.silent * FRAME_MS >= 700 || ms >= this.maxMs) {
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

/** prompt: a hint for Whisper ('' for none: conversation, not agent names). */
export async function transcribe(pcm, prompt = PROMPT) {
  await ensureWhisper();
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'utterance.wav');
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt);
  try {
    const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
    return String((await r.json()).text || '').trim();
  } catch (e) {
    whisperReady = null; // a reused server may have died: respawn next time
    throw e;
  }
}

// --- subtitles: rolling captions of the conversation around you ---------------------
// While someone talks, the phrase so far is re-transcribed every everyMs, so words
// show up as they're said (final: false); when the phrase ends (a pause, or maxMs
// of talk) it's transcribed once more (final: true). One Whisper request at a
// time: a finished phrase waits for the one in flight, partials are skipped while
// busy. No speech for idleMs: onIdle (the bridge turns subtitles off).
// "[BLANK_AUDIO]", "(wind)": Whisper's labels for what isn't speech
export const caption = (text) => text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

export class Captioner {
  constructor(transcribe, emit, { everyMs = 1500, maxMs = 8000, idleMs = 5 * 60_000, onIdle = () => {} } = {}) {
    this.transcribe = transcribe;
    this.emit = emit;
    this.phrase = 0; // which phrase a partial belongs to: a late one for an ended phrase is dropped
    this.done = []; // ended phrases waiting for Whisper
    this.busy = false;
    this.heard = Date.now();
    this.seg = new Segmenter((pcm) => { this.phrase++; this.done.push(pcm); this.next(); }, { maxMs });
    this.ticker = setInterval(() => this.partial(), everyMs);
    this.idler = setInterval(() => { if (Date.now() - this.heard > idleMs) onIdle(); }, Math.min(idleMs, 30_000));
  }
  push(chunk) {
    this.seg.push(chunk);
    if (this.seg.speech) this.heard = Date.now();
  }
  partial() {
    if (this.busy || !this.seg.speech || this.seg.speech.length * FRAME_MS < 600) return;
    const phrase = this.phrase;
    this.run(Buffer.concat(this.seg.speech), (text) => { if (phrase === this.phrase && text) this.emit({ text, final: false }); });
  }
  next() {
    if (this.busy || !this.done.length) return;
    this.run(this.done.shift(), (text) => this.emit({ text, final: true })); // '' too: the partial goes
  }
  run(pcm, then) {
    this.busy = true;
    this.transcribe(pcm).then((text) => { if (!this.stopped) then(caption(text)); },
      (e) => { if (!this.stopped) this.emit({ error: `speech: ${e.message}` }); })
      .finally(() => { this.busy = false; if (!this.stopped) this.next(); });
  }
  stop() {
    this.stopped = true;
    clearInterval(this.ticker);
    clearInterval(this.idler);
  }
}

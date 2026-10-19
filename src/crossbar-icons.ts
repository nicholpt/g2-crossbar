// Crossbar category icons for the glasses, drawn as small images (the firmware font
// has one size and few symbols). Line icons on a 24-unit grid in the spirit of
// SF Symbols: rounded strokes, white on black; the display maps grey to dimmer.

type Draw = (g: CanvasRenderingContext2D) => void;

const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
};

const ICONS: Record<string, Draw> = {
  // bell
  needs: (g) => {
    g.beginPath();
    g.moveTo(5.5, 17);
    g.lineTo(6.5, 15.2);
    g.lineTo(6.5, 10.5);
    g.arc(12, 10.5, 5.5, Math.PI, 0);
    g.lineTo(17.5, 15.2);
    g.lineTo(18.5, 17);
    g.closePath();
    g.stroke();
    g.beginPath();
    g.arc(12, 19.6, 1.7, 0, Math.PI);
    g.stroke();
  },
  // gear
  system: (g) => {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      g.beginPath();
      g.moveTo(12 + Math.cos(a) * 6.6, 12 + Math.sin(a) * 6.6);
      g.lineTo(12 + Math.cos(a) * 9.4, 12 + Math.sin(a) * 9.4);
      g.save(); g.lineWidth *= 1.7; g.lineCap = 'butt'; g.stroke(); g.restore();
    }
    g.beginPath(); g.arc(12, 12, 6.6, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(12, 12, 2.6, 0, Math.PI * 2); g.stroke();
  },
  // terminal window with a prompt
  agents: (g) => {
    rr(g, 2.5, 4, 19, 16, 3.2); g.stroke();
    g.beginPath(); g.moveTo(7, 9.5); g.lineTo(10, 12); g.lineTo(7, 14.5); g.stroke();
    g.beginPath(); g.moveTo(12.5, 15); g.lineTo(17, 15); g.stroke();
  },
  // folder
  projects: (g) => {
    g.beginPath();
    g.moveTo(2.5, 7);
    g.arcTo(2.5, 4.5, 5, 4.5, 2);
    g.lineTo(9, 4.5);
    g.lineTo(11, 6.8);
    g.lineTo(19, 6.8);
    g.arcTo(21.5, 6.8, 21.5, 9.3, 2);
    g.lineTo(21.5, 17.5);
    g.arcTo(21.5, 20, 19, 20, 2);
    g.lineTo(5, 20);
    g.arcTo(2.5, 20, 2.5, 17.5, 2);
    g.closePath();
    g.stroke();
    g.beginPath(); g.moveTo(2.5, 10); g.lineTo(21.5, 10); g.stroke();
  },
  // two stacked windows
  running: (g) => {
    rr(g, 8, 3.5, 13.5, 10.5, 2.2); g.stroke();
    rr(g, 2.5, 9.5, 13.5, 10.5, 2.2);
    // hide the back window's corner: black on the glasses, see-through on the phone
    g.save(); if (clearBg) g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.fill(); g.restore();
    g.stroke();
  },
  // 3x3 grid of app tiles
  apps: (g) => {
    for (const x of [3, 10, 17]) for (const y of [3, 10, 17]) { rr(g, x, y, 4.2, 4.2, 1.3); g.fill(); }
  },
  // two beamed notes
  music: (g) => {
    g.beginPath(); g.ellipse(7, 18, 2.8, 2.2, -0.35, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(17.5, 16, 2.8, 2.2, -0.35, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(9.6, 17.4); g.lineTo(9.6, 6); g.lineTo(20.1, 3.8); g.lineTo(20.1, 15.4); g.stroke();
    g.beginPath(); g.moveTo(9.6, 9); g.lineTo(20.1, 6.8); g.stroke();
  },
  // globe
  network: (g) => {
    g.beginPath(); g.arc(12, 12, 9.2, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.ellipse(12, 12, 4, 9.2, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(3.5, 8.6); g.lineTo(20.5, 8.6); g.moveTo(3.5, 15.4); g.lineTo(20.5, 15.4); g.stroke();
  },
  // page with lines
  notes: (g) => {
    rr(g, 4.5, 2.5, 15, 19, 2.6); g.stroke();
    g.beginPath();
    for (const y of [8, 12, 16]) { g.moveTo(8, y); g.lineTo(y === 16 ? 13 : 16, y); }
    g.stroke();
  },
};

const canvas = document.createElement('canvas');
let clearBg = false;

type Opts = { dim?: boolean; badge?: number; clear?: boolean; ring?: boolean }; // ring: a rounded outline (the focused category)

function paint(id: string, size: number, opts: Opts) {
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d')!;
  clearBg = !!opts.clear;
  if (opts.clear) g.clearRect(0, 0, size, size);
  else { g.fillStyle = '#000'; g.fillRect(0, 0, size, size); }
  const ink = opts.dim ? '#7a7a7a' : '#ffffff';
  const inset = size * (opts.ring ? 0.2 : 0.08); // breathing room inside the image (more inside a ring)
  const s = (size - inset * 2) / 24;
  g.save();
  g.translate(inset, inset);
  g.scale(s, s);
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineWidth = size >= 48 ? 1.6 : 1.9; // heavier at small sizes so lines survive the display
  g.lineCap = 'round';
  g.lineJoin = 'round';
  (ICONS[id] ?? ICONS.apps)(g);
  g.restore();
  if (opts.ring) {
    g.strokeStyle = ink;
    g.lineWidth = 2;
    rr(g, 1, 1, size - 2, size - 2, size * 0.24);
    g.stroke();
  }
  if (opts.badge) {
    // iOS-style count badge, top-right
    const r = Math.max(7, size * 0.17);
    const cx = size - r - 1, cy = r + 1;
    if (!opts.clear) { g.beginPath(); g.arc(cx, cy, r + 2, 0, Math.PI * 2); g.fillStyle = '#000'; g.fill(); }
    // on the glasses: white with black digits; on the phone: iOS red with white digits
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = opts.clear ? '#ff3b30' : '#fff'; g.fill();
    g.fillStyle = opts.clear ? '#fff' : '#000';
    g.font = `bold ${Math.round(r * 1.35)}px -apple-system, Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(opts.badge > 9 ? '9+' : String(opts.badge), cx, cy + 0.5);
  }
}

/** PNG bytes (number[], what the glasses accept) for a category icon. */
export function iconPng(id: string, size: number, opts: Opts = {}): number[] {
  paint(id, size, opts);
  const b64 = canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  return Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Same icon for the phone: transparent background, as a data URL (cached). */
const urls = new Map<string, string>();
export function iconUrl(id: string, size: number, badge = 0): string {
  const key = `${id}|${size}|${badge}`;
  if (!urls.has(key)) { paint(id, size, { clear: true, badge }); urls.set(key, canvas.toDataURL('image/png')); }
  return urls.get(key)!;
}

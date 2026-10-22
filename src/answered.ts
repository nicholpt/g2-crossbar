// A glasses command (a Bluetooth write through the Even app) that hasn't been
// answered in time isn't coming: the link is in trouble. Without a limit the
// glasses would wait for it forever and freeze while the phone carries on.
// Pure, so it's unit-tested.
export class NoAnswer extends Error {
  constructor(ms: number) { super(`no answer in ${ms} ms`); }
}

/** p, or a NoAnswer rejection after ms. */
export function answered<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new NoAnswer(ms)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

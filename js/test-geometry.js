/* === РАСПАД — node-тесты генератора: node js/test-geometry.js === */
import { makeCycle } from './geometry.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };

const fnv = (arr) => {
  let h = 0x811c9dc5;
  const u8 = new Uint8Array(arr.buffer, 0, Math.min(arr.byteLength, 1 << 20));
  for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};

const N = 65536, CAP = 1024;

/* T1: детерминизм */
const a = makeCycle({ seed: 7, count: N, clusterCap: CAP, word: null });
const b = makeCycle({ seed: 7, count: N, clusterCap: CAP, word: null });
ok(fnv(a.rest) === fnv(b.rest), 'T1 детерминизм');

/* T2: разные сиды -> разные формы */
const c = makeCycle({ seed: 8, count: N, clusterCap: CAP, word: null });
ok(fnv(a.rest) !== fnv(c.rest), 'T2 сиды различимы');

/* T3: заполненность */
{
  let nan = 0, zeros = 0;
  for (let i = 0; i < N; i++) {
    if (!isFinite(a.rest[i * 4]) || !isFinite(a.rest[i * 4 + 1])) nan++;
    if (a.rest[i * 4] === 0 && a.rest[i * 4 + 1] === 0 && a.rest[i * 4 + 2] === 0) zeros++;
  }
  ok(nan === 0 && zeros < N * 0.01, 'T3 все слоты заполнены');
}

/* T4: кластеры */
{
  let bad = 0;
  for (let i = 0; i < N; i++) {
    const ci = a.rest[i * 4 + 3];
    if (ci < 0 || ci >= a.clusterCount || ci !== (ci | 0)) bad++;
  }
  let cbad = 0;
  for (let ci = 0; ci < a.clusterCount; ci++) {
    const x = a.clusterCentroid[ci * 4], y = a.clusterCentroid[ci * 4 + 1], z = a.clusterCentroid[ci * 4 + 2];
    const r = a.clusterCentroid[ci * 4 + 3];
    if (x < a.bounds.min[0] || x > a.bounds.max[0] || y < a.bounds.min[1] - 0.01 || y > a.bounds.max[1] || z < a.bounds.min[2] || z > a.bounds.max[2]) cbad++;
    for (let e = 0; e < 8; e++) {
      const o = (ci * 8 + e) * 4;
      const m = Math.hypot(a.clusterExtremes[o], a.clusterExtremes[o + 1], a.clusterExtremes[o + 2]);
      if (m > r * 1.01) cbad++;
    }
  }
  ok(bad === 0 && cbad === 0 && a.clusterCount <= CAP, 'T4 кластеры валидны');
}

/* T5: uv/ao в диапазоне */
{
  let bad = 0;
  for (let i = 0; i < N; i++) {
    if (a.uv[i * 2] < -0.001 || a.uv[i * 2] > 1.001 || a.uv[i * 2 + 1] < -0.001 || a.uv[i * 2 + 1] > 1.001) bad++;
    if (a.ao[i] < 0 || a.ao[i] > 1) bad++;
  }
  ok(bad === 0, 'T5 uv/ao в [0,1]');
}

/* T6: слово в node через фолбэк-шрифт */
{
  const w = makeCycle({ seed: 3, count: N, clusterCap: CAP, word: 'РАСПАД' });
  ok(w.bounds.min[1] === 0 && w.bounds.max[1] > 2 && w.clusterCount > 8, 'T6 слово стоит на полу');
}

/* T7: скорость 262k */
{
  const t0 = Date.now();
  makeCycle({ seed: 5, count: 262144, clusterCap: CAP, word: null });
  ok(Date.now() - t0 < 3000, 'T7 время < 3с (' + (Date.now() - t0) + 'мс)');
}

console.log(`${pass}/${pass + fail} — геометрия по контракту`);
process.exit(fail ? 1 : 0);

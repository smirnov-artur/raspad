/* === РАСПАД — geometry. Процедурный брутализм: вокселизация здания/слова,
   Вороной-кластеры для обрушения, Morton-порядок для стаггера сборки. ===
   Контракт makeCycle() заморожен — на него смотрят шейдеры и main.js.
   Работает и в браузере, и в node (для слова — встроенный 5×7 шрифт). */

/* детерминированный PRNG */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Morton-код 3×10 бит */
function part1by2(n) {
  n &= 0x3ff;
  n = (n | (n << 16)) & 0x30000ff;
  n = (n | (n << 8)) & 0x300f00f;
  n = (n | (n << 4)) & 0x30c30c3;
  n = (n | (n << 2)) & 0x9249249;
  return n;
}
const morton3 = (x, y, z) => part1by2(x) | (part1by2(y) << 1) | (part1by2(z) << 2);

/* --- 5×7 шрифт для node-фолбэка (буквы обоих слов + запас) --- */
const FONT = {
  'Р': ['1110', '1001', '1001', '1110', '1000', '1000', '1000'],
  'А': ['0110', '1001', '1001', '1111', '1001', '1001', '1001'],
  'С': ['0111', '1000', '1000', '1000', '1000', '1000', '0111'],
  'П': ['1111', '1001', '1001', '1001', '1001', '1001', '1001'],
  'Д': ['0110', '0101', '0101', '0101', '0101', '1111', '1001'],
  'D': ['1110', '1001', '1001', '1001', '1001', '1001', '1110'],
  'E': ['1111', '1000', '1000', '1110', '1000', '1000', '1111'],
  'C': ['0111', '1000', '1000', '1000', '1000', '1000', '0111'],
  'A': ['0110', '1001', '1001', '1111', '1001', '1001', '1001'],
  'Y': ['1001', '1001', '0110', '0100', '0100', '0100', '0100'],
};

/* растр слова -> функция ink(u,v) в [0,1]², true = буква */
function wordRaster(word) {
  const hasCanvas = typeof document !== 'undefined';
  if (hasCanvas) {
    const c = document.createElement('canvas');
    const px = 90;
    const ctx = c.getContext('2d');
    ctx.font = `900 ${px}px system-ui, 'Arial Black', sans-serif`;
    const w = Math.ceil(ctx.measureText(word).width) + 12;
    c.width = w; c.height = Math.ceil(px * 1.16);
    const ctx2 = c.getContext('2d');
    ctx2.fillStyle = '#000'; ctx2.fillRect(0, 0, c.width, c.height);
    ctx2.fillStyle = '#fff';
    ctx2.font = `900 ${px}px system-ui, 'Arial Black', sans-serif`;
    ctx2.textBaseline = 'top';
    ctx2.fillText(word, 6, px * 0.06);
    const img = ctx2.getImageData(0, 0, c.width, c.height).data;
    return {
      aspect: c.width / c.height,
      ink: (u, v) => img[((Math.min(c.height - 1, (v * c.height) | 0) * c.width + Math.min(c.width - 1, (u * c.width) | 0)) * 4)] > 128,
    };
  }
  /* node: грубый растр из 5×7 глифов (4 колонки + 1 пробел) */
  const glyphs = [...word].map((ch) => FONT[ch] || ['1111', '1111', '1111', '1111', '1111', '1111', '1111']);
  const cols = glyphs.length * 5 - 1, rows = 7;
  return {
    aspect: cols / rows,
    ink: (u, v) => {
      const x = Math.min(cols - 1, (u * cols) | 0), y = Math.min(rows - 1, (v * rows) | 0);
      const g = (x / 5) | 0, cx = x % 5;
      if (cx === 4 || g >= glyphs.length) return false;
      return glyphs[g][y][cx] === '1';
    },
  };
}

/* ============================================================
   Структуры. Каждая — булева функция inside(x,y,z) над миром.
   Все с ВНУТРЕННИМ устройством: перекрытия, ядро, фермы —
   чтобы обрушение вскрывало нутро, а не однородный фарш.
   ============================================================ */

/* 1. Решётчатая башня (силуэт Эйфелевой): четыре гнутые ноги,
      два пояса-платформы, ферменная решётка, шпиль. */
function towerSolid(rng) {
  const H = 34 + rng() * 10;
  const base = 9 + rng() * 3;            // полуширина у земли
  const top = 0.55 + rng() * 0.25;       // полуширина под шпилем
  const p1 = H * 0.30, p2 = H * 0.62;    // высоты платформ
  const legT = 0.62 + rng() * 0.22;      // толщина стойки
  const W = base * 2.4;
  /* профиль ноги: гипербола — как у настоящей башни */
  const prof = (y) => {
    const t = Math.min(y / H, 1);
    return base * Math.pow(1 - t, 1.65) + top;
  };
  return {
    H, W, D: W, kind: 'tower',
    inside(x, y, z) {
      if (y < 0 || y > H) return false;
      const r = prof(y);
      const ax = Math.abs(x), az = Math.abs(z);
      /* шпиль */
      if (y > H * 0.9) return ax < 0.55 && az < 0.55;
      /* платформы: сплошные плиты с бортом */
      for (const p of [p1, p2]) {
        if (y > p && y < p + 1.1) {
          const rr = prof(p) + 1.4;
          return ax < rr && az < rr && (ax > rr - 2.6 || az > rr - 2.6 || y < p + 0.5);
        }
      }
      /* четыре ноги в углах текущего профиля */
      const dx = Math.abs(ax - r), dz = Math.abs(az - r);
      if (dx < legT && dz < legT) return true;
      /* ферменная решётка между ногами: редкие X-раскосы + пояса, грань ажурная */
      const cell = 5.2;
      const onFaceX = Math.abs(ax - r) < legT * 0.55 && az < r - legT;
      const onFaceZ = Math.abs(az - r) < legT * 0.55 && ax < r - legT;
      if (onFaceX || onFaceZ) {
        const u = onFaceX ? az : ax;
        const a = Math.abs(((u + y) % cell) - cell / 2);
        const b = Math.abs(((u - y + 1000 * cell) % cell) - cell / 2);
        if (Math.min(a, b) < 0.28) return true;                            // раскосы
        if (Math.abs((y % cell) - cell / 2) < 0.26) return true;           // горизонтальные пояса
      }
      /* арки в основании: дуга между соседними ногами, строго в габарите */
      if (y < H * 0.24) {
        const R0 = base * 0.95;
        for (const face of [0, 1]) {
          const u = face ? ax : az, w = face ? az : ax;
          if (w < r + legT * 0.6 && w > r - legT * 1.6) {          // строго на плоскости грани
            const d2 = Math.hypot(u, y - H * 0.235);
            if (u < r - legT * 0.8 && d2 > R0 * 0.80 && d2 < R0 * 0.80 + 0.75) return true;
          }
        }
      }
      return false;
    },
  };
}

/* 2. Собор-обелиск: массивное тело, контрфорсы, арочные проёмы, купол-навершие. */
function templeSolid(rng) {
  const H = 26 + rng() * 8;
  const W = 7 + rng() * 3, D = 11 + rng() * 4;
  const buts = 2 + ((rng() * 3) | 0);
  return {
    H, W: W * 2.6, D: D * 2, kind: 'temple',
    inside(x, y, z) {
      if (y < 0 || y > H) return false;
      const ax = Math.abs(x), az = Math.abs(z);
      const taper = 1 - 0.18 * (y / H);
      /* купол */
      if (y > H * 0.82) {
        const r = Math.hypot(ax, az, (y - H * 0.82) * 1.4);
        return r < W * 0.62 * (1 - (y - H * 0.82) / (H * 0.2)) + 0.6;
      }
      const inBody = ax < W * taper && az < D * taper;
      /* контрфорсы по бокам */
      let inBut = false;
      for (let i = 0; i < buts; i++) {
        const zc = -D * 0.7 + (D * 1.4 * (i + 0.5)) / buts;
        if (Math.abs(z - zc) < 1.1 && ax > W * taper - 0.6 && ax < W * taper + 2.6 && y < H * 0.6)
          inBut = y < H * 0.6 - (ax - W * taper) * 3.0;
      }
      if (!inBody && !inBut) return false;
      if (inBut && !inBody) return true;
      /* нутро: неф пустой, стены 1.6, перекрытия каждые 4.5 */
      const wall = 1.6;
      const shell = Math.min(W * taper - ax, D * taper - az);
      if (shell > wall) {
        const floorY = y % 4.5;
        if (floorY > 0.55) {
          /* арочные проёмы в стенах */
          return false;
        }
      }
      /* окна-арки в стене */
      if (shell <= wall && y > 3 && y < H * 0.75) {
        const step = 3.4;
        const u = (shell === D * taper - az) ? x : z;
        const fu = Math.abs(((u + 1000 * step) % step) - step / 2);
        const fy = (y % 6.5);
        if (fu < 0.85 && fy > 1.2 && fy < 4.6) return false;
      }
      return true;
    },
  };
}

/* 3. Брутальное здание (было) — коробки, уступы, оконный ритм + перекрытия и ядро. */
function buildingSolid(rng) {
  const H = 26 + rng() * 9;                       // высота, ед. — монументальность
  const W = 10 + rng() * 5, D = 9 + rng() * 5;    // основной объём
  const boxes = [{ x0: -W / 2, x1: W / 2, y0: 0, y1: H, z0: -D / 2, z1: D / 2 }];
  /* уступ: верхняя треть уже */
  const setbackY = H * (0.55 + rng() * 0.2), sb = 0.55 + rng() * 0.25;
  /* крылья */
  const wings = 1 + ((rng() * 2.2) | 0);
  for (let i = 0; i < wings; i++) {
    const side = rng() < 0.5 ? 1 : -1, alongX = rng() < 0.5;
    const wh = H * (0.28 + rng() * 0.3), ww = 4 + rng() * 5, wd = 4 + rng() * 4;
    if (alongX) boxes.push({ x0: side * W * 0.5 - (side < 0 ? ww : 0), x1: side * W * 0.5 + (side > 0 ? ww : 0), y0: 0, y1: wh, z0: -wd / 2, z1: wd / 2 });
    else boxes.push({ x0: -ww / 2, x1: ww / 2, y0: 0, y1: wh, z0: side * D * 0.5 - (side < 0 ? wd : 0), z1: side * D * 0.5 + (side > 0 ? wd : 0) });
  }
  /* консоль-плита сверху */
  if (rng() < 0.6) {
    const py = H * (0.8 + rng() * 0.15);
    boxes.push({ x0: -W * 0.75, x1: W * 0.75, y0: py, y1: py + 1.2, z0: -D * 0.72, z1: D * 0.72 });
  }
  const floorH = 1.0 + rng() * 0.3;               // шаг «этажа» для окон
  const colW = 0.9 + rng() * 0.5;                 // шаг пилонов
  const winPh = rng() * 7;
  return {
    H, W, D, boxes,
    inside(x, y, z) {
      let inMain = false, inAny = false;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1) {
          if (i === 0) {
            if (y > setbackY && (x < -W / 2 * sb || x > W / 2 * sb || z < -D / 2 * sb || z > D / 2 * sb)) continue;
            inMain = true;
          }
          inAny = true;
        }
      }
      if (!inAny) return false;
      /* НУТРО: корка стен 1.3, внутри — этажные перекрытия 0.5 и ядро жёсткости.
         Обрушение вскрывает слоёный пирог этажей, а не однородный фарш. */
      if (inMain && y > 1.2) {
        const upW = y > setbackY ? W * sb : W, upD = y > setbackY ? D * sb : D;
        const shell = Math.min(upW / 2 - Math.abs(x), upD / 2 - Math.abs(z));
        const core = Math.abs(x) < upW * 0.14 && Math.abs(z) < upD * 0.14;
        const slab = (y % floorH) < 0.42;
        if (shell > 1.3 && !core && !slab) return false;
      }
      /* оконные ниши: только внешняя корка основного объёма */
      if (inMain && y > floorH * 1.5 && y < this.H - 1) {
        const upperW = y > setbackY ? W * sb : W, upperD = y > setbackY ? D * sb : D;
        const shellX = Math.min(x + upperW / 2, upperW / 2 - x);
        const shellZ = Math.min(z + upperD / 2, upperD / 2 - z);
        const shell = Math.min(shellX, shellZ);
        if (shell < 0.65) {
          const fy = (y / floorH) % 1;
          const axis = shellX < shellZ ? z : x;
          const fc = ((axis + winPh) / colW) % 1;
          if (fy > 0.3 && fy < 0.82 && Math.abs(fc) > 0.42) return false;
        }
      }
      return true;
    },
  };
}

/* --- основной генератор --- */
export function makeCycle(opts) {
  const { seed, count, clusterCap, word = null } = opts;
  const rng = mulberry32(seed);

  /* — вокселизация с подбором размера вокселя под count — */
  let vox = null, v = 0, dims = null, origin = null;
  if (word) {
    const r = wordRaster(word);
    const height = 6.2, width = height * r.aspect, depth = 1.1;
    /* подбор v: nx*ny*nz*fill ≈ 0.85*count; fill измеряем растром */
    let fill = 0; const S = 48;
    for (let i = 0; i < S * S; i++) fill += r.ink((i % S) / S, ((i / S) | 0) / S) ? 1 : 0;
    fill /= S * S;
    v = Math.cbrt((width * height * depth * fill) / (0.85 * count));
    const nx = Math.ceil(width / v), ny = Math.ceil(height / v), nz = Math.max(3, Math.round(depth / v));
    dims = [nx, ny, nz];
    origin = [-width / 2, 0, -(nz * v) / 2];
    vox = (xi, yi, zi) => r.ink(xi / nx, 1 - (yi + 0.5) / ny);
  } else {
    /* тип структуры по сиду: башня-ферма / собор / брутальный монолит */
    const pick = rng();
    const b = pick < 0.34 ? towerSolid(rng) : (pick < 0.62 ? templeSolid(rng) : buildingSolid(rng));
    /* грубая оценка заполнения на пробной сетке */
    const probe = 34; let fill = 0;
    const px = b.W * 1.5, pz = b.D * 1.5;
    for (let i = 0; i < probe ** 3; i++) {
      const xi = i % probe, yi = ((i / probe) | 0) % probe, zi = (i / (probe * probe)) | 0;
      if (b.inside((xi / probe - 0.5) * px, (yi / probe) * b.H, (zi / probe - 0.5) * pz)) fill++;
    }
    fill = Math.max(fill / probe ** 3, 0.012);   // ажурная ферма — очень малая доля объёма
    v = Math.cbrt((px * b.H * pz * fill) / (0.85 * count));
    v = Math.max(v, 0.16);                       // не мельчить: воксель должен читаться
    const nx = Math.min(300, Math.ceil(px / v)), ny = Math.min(400, Math.ceil(b.H / v) + 1), nz = Math.min(300, Math.ceil(pz / v));
    dims = [nx, ny, nz];
    origin = [-px / 2, 0, -pz / 2];
    vox = (xi, yi, zi) => b.inside(origin[0] + (xi + 0.5) * v, (yi + 0.5) * v, origin[2] + (zi + 0.5) * v);
  }

  /* — сбор солидных вокселей (не больше count) — */
  const [nx, ny, nz] = dims;
  const solid = new Uint8Array(nx * ny * nz);
  const idx = (x, y, z) => (z * ny + y) * nx + x;
  let voxels = [];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        if (vox(x, y, z)) { solid[idx(x, y, z)] = 1; voxels.push([x, y, z]); }
  if (voxels.length > count) {              /* решётка чуть плотнее нужного — прореживаем детерминированно */
    const step = voxels.length / count;
    const keep = [];
    for (let i = 0; keep.length < count; i += step) keep.push(voxels[i | 0]);
    voxels = keep;
  }
  const real = voxels.length;

  /* — Morton-порядок — */
  voxels.sort((a, b2) => morton3(a[0], a[1], a[2]) - morton3(b2[0], b2[1], b2[2]));

  /* — кластеры Вороного через коарс-бакеты — */
  const K = Math.max(24, Math.min(clusterCap, (real / 256) | 0));
  const seeds = [];
  const maxYw = ny * v;
  for (let tries = 0; seeds.length < K && tries < K * 30; tries++) {
    const p = voxels[(rng() * real) | 0];
    if (rng() < 0.4 + 0.6 * (p[1] / ny)) seeds.push(p);   // верх бьётся мельче
  }
  while (seeds.length < K) seeds.push(voxels[(rng() * real) | 0]);
  /* бакеты */
  const C = 9;
  const buckets = new Map();
  const bkey = (x, y, z) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
  const cell = (p) => [Math.floor(p[0] / nx * C), Math.floor(p[1] / ny * C), Math.floor(p[2] / nz * C)];
  seeds.forEach((s, i) => {
    const c = cell(s), k = bkey(c[0], c[1], c[2]);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  });
  const clusterOf = new Int32Array(real);
  for (let i = 0; i < real; i++) {
    const p = voxels[i], c = cell(p);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 3 && best < 0; r++) {         // расширяем окно, пока не найдём сид
      for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const arr = buckets.get(bkey(c[0] + dx, c[1] + dy, c[2] + dz));
        if (!arr) continue;
        for (const si of arr) {
          const s = seeds[si];
          const d = (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2 + (p[2] - s[2]) ** 2;
          if (d < bd) { bd = d; best = si; }
        }
      }
    }
    clusterOf[i] = best < 0 ? 0 : best;
  }

  /* — переиндексация непустых кластеров — */
  const remap = new Int32Array(K).fill(-1);
  let kUsed = 0;
  for (let i = 0; i < real; i++) {
    const c = clusterOf[i];
    if (remap[c] < 0) remap[c] = kUsed++;
    clusterOf[i] = remap[c];
  }

  /* — мировые позиции, bounds — */
  const world = (p) => [origin[0] + (p[0] + 0.5) * v, (p[1] + 0.5) * v, origin[2] + (p[2] + 0.5) * v];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const wpos = new Float32Array(real * 3);
  for (let i = 0; i < real; i++) {
    const w = world(voxels[i]);
    wpos[i * 3] = w[0]; wpos[i * 3 + 1] = w[1]; wpos[i * 3 + 2] = w[2];
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], w[a] - v); max[a] = Math.max(max[a], w[a] + v); }
  }
  min[1] = 0;

  /* — центроиды/радиусы/экстремумы — */
  const cSum = new Float64Array(kUsed * 3), cN = new Float64Array(kUsed);
  for (let i = 0; i < real; i++) {
    const c = clusterOf[i];
    cSum[c * 3] += wpos[i * 3]; cSum[c * 3 + 1] += wpos[i * 3 + 1]; cSum[c * 3 + 2] += wpos[i * 3 + 2];
    cN[c]++;
  }
  const clusterCentroid = new Float32Array(clusterCap * 4);
  for (let c = 0; c < kUsed; c++) {
    clusterCentroid[c * 4] = cSum[c * 3] / cN[c];
    clusterCentroid[c * 4 + 1] = cSum[c * 3 + 1] / cN[c];
    clusterCentroid[c * 4 + 2] = cSum[c * 3 + 2] / cN[c];
  }
  const DIRS = [];
  for (let i = 0; i < 8; i++) DIRS.push([(i & 1) ? 1 : -1, (i & 2) ? 1 : -1, (i & 4) ? 1 : -1]);
  const extBest = new Float64Array(kUsed * 8).fill(-Infinity);
  const clusterExtremes = new Float32Array(clusterCap * 8 * 4);
  for (let i = 0; i < real; i++) {
    const c = clusterOf[i];
    const ox = wpos[i * 3] - clusterCentroid[c * 4];
    const oy = wpos[i * 3 + 1] - clusterCentroid[c * 4 + 1];
    const oz = wpos[i * 3 + 2] - clusterCentroid[c * 4 + 2];
    const r = ox * ox + oy * oy + oz * oz;
    if (r > clusterCentroid[c * 4 + 3]) clusterCentroid[c * 4 + 3] = r;
    for (let d = 0; d < 8; d++) {
      const dd = DIRS[d];
      const dot = ox * dd[0] + oy * dd[1] + oz * dd[2];
      if (dot > extBest[c * 8 + d]) {
        extBest[c * 8 + d] = dot;
        const o = (c * 8 + d) * 4;
        clusterExtremes[o] = ox; clusterExtremes[o + 1] = oy; clusterExtremes[o + 2] = oz;
      }
    }
  }
  for (let c = 0; c < kUsed; c++) clusterCentroid[c * 4 + 3] = Math.sqrt(clusterCentroid[c * 4 + 3]) || v;

  /* — выходные массивы частиц + паддинг — */
  const rest = new Float32Array(count * 4);
  const uvArr = new Float32Array(count * 2);
  const aoArr = new Float32Array(count);
  const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
  const cx = (max[0] + min[0]) / 2, cz = (max[2] + min[2]) / 2;
  for (let i = 0; i < count; i++) {
    const src = i < real ? i : (rng() * real) | 0;
    let x = wpos[src * 3], y = wpos[src * 3 + 1], z = wpos[src * 3 + 2];
    if (i >= real) {
      x += (rng() - 0.5) * v * 0.3; y += (rng() - 0.5) * v * 0.3; z += (rng() - 0.5) * v * 0.3;
    }
    rest[i * 4] = x; rest[i * 4 + 1] = y; rest[i * 4 + 2] = z;
    rest[i * 4 + 3] = clusterOf[src];
    /* UV-атлас фасадов 2×2: +X / −X / +Z / −Z по четвертям — нагрев одного фасада
       не зеркалится на противоположный (формула повторяется в raycast main.js) */
    const lx = (x - cx) / sx, lz = (z - cz) / sz;
    let fu, fv, qx, qy;
    if (Math.abs(lx) > Math.abs(lz)) { fu = (z - min[2]) / sz; fv = (y - min[1]) / sy; qx = lx > 0 ? 0 : 0.5; qy = 0; }
    else { fu = (x - min[0]) / sx; fv = (y - min[1]) / sy; qx = lz > 0 ? 0 : 0.5; qy = 0.5; }
    uvArr[i * 2] = qx + fu * 0.5;
    uvArr[i * 2 + 1] = qy + fv * 0.5;
    /* AO из 6-соседей */
    const p = voxels[src];
    let n6 = 0;
    if (p[0] > 0 && solid[idx(p[0] - 1, p[1], p[2])]) n6++;
    if (p[0] < nx - 1 && solid[idx(p[0] + 1, p[1], p[2])]) n6++;
    if (p[1] > 0 && solid[idx(p[0], p[1] - 1, p[2])]) n6++;
    if (p[1] < ny - 1 && solid[idx(p[0], p[1] + 1, p[2])]) n6++;
    if (p[2] > 0 && solid[idx(p[0], p[1], p[2] - 1)]) n6++;
    if (p[2] < nz - 1 && solid[idx(p[0], p[1], p[2] + 1)]) n6++;
    aoArr[i] = 1 - (n6 / 6) * 0.72;
  }

  return {
    rest, uv: uvArr, ao: aoArr,
    clusterCount: kUsed,
    clusterCentroid, clusterExtremes,
    bounds: { min, max },
    voxel: v,
  };
}

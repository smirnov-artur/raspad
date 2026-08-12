/* === РАСПАД — оркестровка: акты, камера, ввод, рендер, пост. ===
   Машина агрегатных состояний: A0 сборка → A1 напряжение → A2 срыв →
   A3 плавление → A4 катастрофа → A5 реверс к новому сиду. Цикл 0 — слово. */

import * as THREE from 'three';
import { PingPong, Passer, passMaterial, dataTexture } from './sim.js';
import * as SH from './shaders.js';
import { makeCycle } from './geometry.js';
import { RaspadAudio } from './audio.js';

(function () {
  'use strict';

  /* ---------- язык, тексты ---------- */
  const EN = (document.documentElement.lang || 'ru').startsWith('en');
  const T = EN ? {
    word: 'DECAY',
    acts: ['ACT 0 · DUST', 'ACT I · FIRE', 'ACT II · COLLAPSE', 'ACT III · ASHES', 'ACT IV · ASHES', 'ACT V · REBUILD'],
    sound: ['SOUND OFF', 'SOUND ON'],
    nogl: 'This demo needs WebGL2 with float render targets. The machine of matter refuses to run here — try a desktop browser.',
  } : {
    word: 'РАСПАД',
    acts: ['АКТ 0 · ПЫЛЬ', 'АКТ I · ОГОНЬ', 'АКТ II · СРЫВ', 'АКТ III · ПЕПЕЛ', 'АКТ IV · ПЕПЕЛ', 'АКТ V · ЗАНОВО'],
    sound: ['ЗВУК ВЫКЛ', 'ЗВУК ВКЛ'],
    nogl: 'Демо требует WebGL2 с float-рендертаргетами. Машина материи здесь не заведётся — откройте в десктопном браузере.',
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* отладочная бисекция: ?nosim&nocubes&nopoints&nofloor&nopost&nocrack&nocluster&n=128 */
  const FLAGS = new URLSearchParams(location.search);
  const OFF = (k) => FLAGS.has(k);

  /* ---------- каркас/фолбэк ---------- */
  const canvas = document.getElementById('gl');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) { return fail(); }
  const gl = renderer.getContext();
  if (!renderer.capabilities.isWebGL2 || !gl.getExtension('EXT_color_buffer_float')) return fail();
  function fail() {
    document.getElementById('nogl').textContent = T.nogl;
    document.getElementById('nogl').hidden = false;
    if (canvas) canvas.hidden = true;
    return null;
  }

  /* ---------- тиры ---------- */
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const TIERS = { ULTRA: 512, HIGH: 256, MOBILE: 128 };
  /* десктоп сразу получает 262k — масштаб и есть вау; бенч только ДАУНГРЕЙДИТ слабые машины */
  let side = isTouch ? TIERS.MOBILE : TIERS.ULTRA;
  if (FLAGS.get('n')) side = +FLAGS.get('n') || side;
  let benchTimes = [];
  let tierLocked = false;

  const DPR = () => Math.min(devicePixelRatio || 1, isTouch ? 1.5 : 2);
  renderer.setPixelRatio(1); // DPR учитываем сами через renderScale
  let renderScale = 1.0;

  /* ---------- сцена/камера ---------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050506);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 240);

  /* ---------- состояние приложения ---------- */
  const app = {
    act: 0, actT: 0, cycle: 0, seed: (Math.random() * 1e6) | 0,
    timeScale: 1, timeTarget: 1,
    heat: 0, HEAT_MAX: 6,
    shake: 0, flash: 0,
    idleT: 0, auto: false,
    frozen: false, froseAt: 0,
    bassFired: false,
    soundOn: false, userMuted: false,
    cineSlow: false,
    fixSeed: false,
  };
  const simT = { t: 0 };

  /* ---------- GPGPU ---------- */
  const passer = new Passer(renderer);
  const N = () => side * side;
  let particles = null, clusters = null, crack = null;
  let texRest, texMeta, texCStatic, texCExtremes, texCUV = null;
  let geoData = null;
  let releasedFrac = 0;   // доля сорвавшихся кластеров (readback раз в ~0.4с) — драйвер драматургии
  let targetsFresh = false;   // FBO пересозданы (смена тира) — ретег из них читал бы нули

  function makeTargets() {
    if (particles) { particles.dispose(); clusters.dispose(); crack.dispose(); }
    particles = new PingPong(side, side, 2, OFF('phist') ? THREE.FloatType : THREE.HalfFloatType);
    clusters = new PingPong(32, 32, 4, THREE.FloatType);
    crack = new PingPong(512, 512, 1, THREE.HalfFloatType);   // атлас 2×2 → 256² на фасад
    for (const rt of [crack.a, crack.b]) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
    }
  }

  /* ---------- загрузка цикла (геометрия -> текстуры) ---------- */
  function loadCycle(firstFrame) {
    const seed = FLAGS.get('seed') != null ? +FLAGS.get('seed') + app.cycle : (app.fixSeed ? 7 : app.seed + app.cycle);
    const word = (app.cycle === 0 && !OFF('nw')) ? T.word : null;
    geoData = makeCycle({ seed, count: N(), clusterCap: 1024, word });
    const n = N();

    if (texRest) { texRest.dispose(); texMeta.dispose(); texCStatic.dispose(); texCExtremes.dispose(); }
    texRest = dataTexture(geoData.rest, side, side);

    const meta = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      meta[i * 4] = geoData.uv[i * 2];
      meta[i * 4 + 1] = geoData.uv[i * 2 + 1];
      meta[i * 4 + 2] = geoData.ao[i];
      meta[i * 4 + 3] = i / n;                      // Morton-ранг для стаггера
    }
    texMeta = dataTexture(meta, side, side);
    texCStatic = dataTexture(geoData.clusterCentroid, 32, 32);

    /* extremes: кластер-мажорный массив -> текстура 256×32 (8 текселей подряд на кластер) */
    const ext = new Float32Array(256 * 32 * 4);
    for (let ci = 0; ci < 1024; ci++) {
      const cx = ci % 32, cy = (ci / 32) | 0;
      for (let e = 0; e < 8; e++) {
        const src = (ci * 8 + e) * 4, dst = ((cy * 256) + cx * 8 + e) * 4;
        ext[dst] = geoData.clusterExtremes[src];
        ext[dst + 1] = geoData.clusterExtremes[src + 1];
        ext[dst + 2] = geoData.clusterExtremes[src + 2];
      }
    }
    texCExtremes = dataTexture(ext, 256, 32);

    /* причинность обрушения: UV центроида в атласе фасадов (кластер чувствует СВОЙ нагрев)
       + индекс кластера-опоры снизу (потерял опору — складывается) */
    const b = geoData.bounds;
    const bsx = b.max[0] - b.min[0], bsy = b.max[1] - b.min[1], bsz = b.max[2] - b.min[2];
    const bcx = (b.max[0] + b.min[0]) / 2, bcz = (b.max[2] + b.min[2]) / 2;
    const cuv = new Float32Array(32 * 32 * 4).fill(-1);
    const K = geoData.clusterCount;
    for (let ci = 0; ci < K; ci++) {
      const x = geoData.clusterCentroid[ci * 4], y = geoData.clusterCentroid[ci * 4 + 1], z = geoData.clusterCentroid[ci * 4 + 2];
      const r = geoData.clusterCentroid[ci * 4 + 3];
      const lx = (x - bcx) / bsx, lz = (z - bcz) / bsz;
      let fu, qx, qy;
      if (Math.abs(lx) > Math.abs(lz)) { fu = (z - b.min[2]) / bsz; qx = lx > 0 ? 0 : 0.5; qy = 0; }
      else { fu = (x - b.min[0]) / bsx; qx = lz > 0 ? 0 : 0.5; qy = 0.5; }
      cuv[ci * 4] = qx + fu * 0.5;
      cuv[ci * 4 + 1] = qy + ((y - b.min[1]) / bsy) * 0.5;
      /* опора: ближайший кластер ниже с пересечением по XZ; нижним — земля (-1) */
      let best = -1, bd = Infinity;
      for (let cj = 0; cj < K; cj++) {
        if (cj === ci) continue;
        const yj = geoData.clusterCentroid[cj * 4 + 1];
        if (yj >= y - 0.6) continue;
        const dx = geoData.clusterCentroid[cj * 4] - x, dz = geoData.clusterCentroid[cj * 4 + 2] - z;
        const rj = geoData.clusterCentroid[cj * 4 + 3];
        if (Math.hypot(dx, dz) > (r + rj) * 0.9) continue;
        const d = dx * dx + dz * dz + (yj - y) * (yj - y);
        if (d < bd) { bd = d; best = cj; }
      }
      cuv[ci * 4 + 2] = y < 2.0 ? -1 : best;
      cuv[ci * 4 + 3] = y / bsy;
    }
    if (texCUV) texCUV.dispose();
    texCUV = dataTexture(cuv, 32, 32);

    /* rest в сим-материалы */
    for (const m of [matParticle, matCubes, matPoints, matSplatPts]) {
      if (m) { m.uniforms.tRest && (m.uniforms.tRest.value = texRest); }
    }
    if (matParticle) {
      matParticle.uniforms.tMeta.value = texMeta;
      matParticle.uniforms.uMaxY.value = geoData.bounds.max[1];
      matParticle.uniforms.uSeed.value = seed % 100;
    }
    if (matCluster) {
      matCluster.uniforms.tStatic.value = texCStatic;
      matCluster.uniforms.tExtremes.value = texCExtremes;
      matCluster.uniforms.tCUV.value = texCUV;
      matCluster.uniforms.uMaxY.value = geoData.bounds.max[1];
      matCluster.uniforms.uSeed.value = seed % 100;
    }
    releasedFrac = 0;
    if (matCubes) {
      matCubes.uniforms.tMeta.value = texMeta;
      matCubes.uniforms.tCStatic.value = texCStatic;
      matCubes.uniforms.uVoxel.value = geoData.voxel;
      matCubes.uniforms.uMaxY.value = geoData.bounds.max[1];
    }
    if (matFloor) {
      matFloor.uniforms.uBMin.value.fromArray(geoData.bounds.min);
      matFloor.uniforms.uBMax.value.fromArray(geoData.bounds.max);
    }

    /* сброс поля трещин и кластеров */
    passer.run(matClear, crack.a); passer.run(matClear, crack.b);
    matCInit.uniforms.tStatic.value = texCStatic;
    passer.run(matCInit, clusters.a); passer.run(matCInit, clusters.b);

    if (firstFrame || targetsFresh) {
      /* свежие FBO: ретег читал бы нули — сеем пыль заново */
      matInit.uniforms.tRest.value = texRest;
      passer.run(matInit, particles.a); passer.run(matInit, particles.b);
      targetsFresh = false;
    }
    else {
      /* реверс: те же позиции, фаза 6 */
      matRetag.uniforms.tPos.value = particles.read.textures[0];
      matRetag.uniforms.tVel.value = particles.read.textures[1];
      passer.run(matRetag, particles.write);
      particles.swap();
    }
  }

  /* ---------- материалы сим-пассов ---------- */
  const U = (v) => ({ value: v });
  const matInit = passMaterial(SH.VERT_PASS, SH.CHUNK_HASH + `
in vec2 vUv;
layout(location=0) out vec4 oPos;
layout(location=1) out vec4 oVel;
uniform sampler2D tRest;
void main(){
  vec4 R = texelFetch(tRest, ivec2(gl_FragCoord.xy), 0);
  vec3 h = hash33(R.xyz*3.1) - 0.5;
  oPos = vec4(R.x*2.6 + h.x*14.0, 0.06 + abs(h.y)*0.5, R.z*2.6 + h.z*14.0, 6.0);
  oVel = vec4(0.0);
}`, { tRest: U(null) });

  const matRetag = passMaterial(SH.VERT_PASS, `
in vec2 vUv;
layout(location=0) out vec4 oPos;
layout(location=1) out vec4 oVel;
uniform sampler2D tPos, tVel;
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(tPos, tc, 0);
  oPos = vec4(P.xyz, 6.0);
  oVel = vec4(texelFetch(tVel, tc, 0).xyz * 0.2, 0.0);
}`, { tPos: U(null), tVel: U(null) });

  const matClear = passMaterial(SH.VERT_PASS, `
in vec2 vUv; out vec4 oC; void main(){ oC = vec4(1.0, 0.0, 0.0, 1.0); }`, {});

  const matCInit = passMaterial(SH.VERT_PASS, `
in vec2 vUv;
layout(location=0) out vec4 oPos;
layout(location=1) out vec4 oVel;
layout(location=2) out vec4 oQuat;
layout(location=3) out vec4 oAng;
uniform sampler2D tStatic;
void main(){
  vec4 s = texelFetch(tStatic, ivec2(gl_FragCoord.xy), 0);
  oPos = vec4(s.xyz, 0.0); oVel = vec4(0.0); oQuat = vec4(0,0,0,1); oAng = vec4(0.0);
}`, { tStatic: U(null) });

  const matCluster = passMaterial(SH.VERT_PASS, SH.FRAG_CLUSTER, {
    tPos: U(null), tVel: U(null), tQuat: U(null), tAng: U(null),
    tStatic: U(null), tExtremes: U(null), tCUV: U(null), tCrack: U(null),
    uDt: U(0), uTime: U(0), uAct: U(0), uCollapseT: U(0), uMaxY: U(20), uSeed: U(0),
    uGravity: U(new THREE.Vector3(0, -22, 0)), uShear: U(new THREE.Vector3(1, 0, 0)),
    uFire: U(new THREE.Vector4(0, 8, 0, 0)),
  });

  const matParticle = passMaterial(SH.VERT_PASS, SH.FRAG_PARTICLE, {
    tPos: U(null), tVel: U(null), tRest: U(null), tMeta: U(null), tCrack: U(null),
    tCPos: U(null), tCQuat: U(null), tCAng: U(null), tCVel: U(null), tCStatic: U(null),
    uDt: U(0), uTime: U(0), uAct: U(0), uActT: U(0), uAssembleT: U(0), uSeed: U(0),
    uMaxY: U(20), uMeltR: U(0), uImplode: U(0),
    uGravity: U(new THREE.Vector3(0, -22, 0)),
    uCursor: U(new THREE.Vector3(0, 5, 0)), uSink: U(new THREE.Vector3(0, 0, 0)),
    uCursorOn: U(0), uHeatK: U(0),
  });

  const matCrack = passMaterial(SH.VERT_PASS, SH.FRAG_CRACK, {
    tPrev: U(null), uPx: U(new THREE.Vector2(1 / 512, 1 / 512)),
    uBrush: U(new THREE.Vector2(0.5, 0.5)), uBrushOn: U(0), uDt: U(0),
  });

  /* ---------- объекты сцены ---------- */
  let matCubes, matPoints, matSplatPts, matFloor;
  let cubes, points, splatPts, floor;

  function buildScene() {
    if (cubes) {
      scene.remove(cubes, points, floor);
      if (splatPts) scene.remove(splatPts);
      cubes.dispose();                 // instanceMatrix-буфер (до 16 МБ на ULTRA)
      cubes.geometry.dispose(); points.geometry.dispose();
      matCubes.dispose(); matPoints.dispose(); matSplatPts.dispose();
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    matCubes = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SH.VERT_CUBES, fragmentShader: SH.FRAG_CUBES,
      uniforms: {
        tPos: U(null), tVel: U(null), tRest: U(null), tMeta: U(null), tCQuat: U(null), tCStatic: U(null),
        uSide: U(side), uVoxel: U(0.3), uTime: U(0), uCam: U(camera.position), uMaxY: U(20),
        uFire: U(new THREE.Vector4(0, 8, 0, 0)),
      },
    });
    cubes = new THREE.InstancedMesh(box, matCubes, N());
    cubes.frustumCulled = false;
    scene.add(cubes);

    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N() * 3), 3));
    const pUniforms = () => ({
      tPos: U(null), tVel: U(null), uSide: U(side), uMode: U(0), uProj: U(1000),
      uNoSplat: U(0), uSmoke: U(0), uTime: U(0), uCam: U(camera.position),
      uFire: U(new THREE.Vector4(0, 8, 0, 0)),
    });
    matPoints = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SH.VERT_POINTS, fragmentShader: SH.FRAG_POINTS,
      uniforms: pUniforms(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    points = new THREE.Points(pgeo, matPoints);
    points.frustumCulled = false;
    scene.add(points);

    /* дым — отдельный слой: обычный блендинг, иначе тёмных клубов не бывает */
    matSplatPts = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SH.VERT_POINTS, fragmentShader: SH.FRAG_POINTS,
      uniforms: pUniforms(), transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    matSplatPts.uniforms.uSmoke.value = 1;
    splatPts = new THREE.Points(pgeo, matSplatPts);
    splatPts.frustumCulled = false;
    splatPts.renderOrder = 2;
    scene.add(splatPts);

    if (!floor) {
      matFloor = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: SH.VERT_FLOOR, fragmentShader: SH.FRAG_FLOOR,
        uniforms: {
          uCam: U(camera.position), uBMin: U(new THREE.Vector3()), uBMax: U(new THREE.Vector3()),
          uPresence: U(1), uFire: U(new THREE.Vector4(0, 8, 0, 0)), uTime: U(0),
        },
      });
      floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), matFloor);
      floor.frustumCulled = false;
      scene.add(floor);
    } else scene.add(floor);
  }

  /* ---------- пост ---------- */
  let rtScene, rtSplat, rtSplatB, rtBrightA, rtBrightB;
  const matBright = passMaterial(SH.VERT_PASS, SH.FRAG_BRIGHT, { tScene: U(null) });
  const matBlur = passMaterial(SH.VERT_PASS, SH.FRAG_BLUR, { tSrc: U(null), uDir: U(new THREE.Vector2()) });
  const matComposite = passMaterial(SH.VERT_PASS, SH.FRAG_COMPOSITE, {
    tScene: U(null), tBloom: U(null), tSplat: U(null),
    uSplatPx: U(new THREE.Vector2()), uTime: U(0), uFlash: U(0), uShake: U(0),
    uVig: U(0.9), uLiquid: U(0),
  });

  function makePost() {
    for (const rt of [rtScene, rtSplat, rtSplatB, rtBrightA, rtBrightB]) rt && rt.dispose();
    const w = Math.max(2, Math.round(innerWidth * DPR() * renderScale));
    const h = Math.max(2, Math.round(innerHeight * DPR() * renderScale));
    const o = { depthBuffer: true, stencilBuffer: false, type: THREE.HalfFloatType };
    rtScene = new THREE.WebGLRenderTarget(w, h, o);
    const q = { depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    rtSplat = new THREE.WebGLRenderTarget(w >> 1, h >> 1, q);
    rtSplatB = new THREE.WebGLRenderTarget(w >> 1, h >> 1, q);
    rtBrightA = new THREE.WebGLRenderTarget(w >> 2, h >> 2, q);
    rtBrightB = new THREE.WebGLRenderTarget(w >> 2, h >> 2, q);
    matComposite.uniforms.uSplatPx.value.set(2 / w, 2 / h);
    /* перспективный фактор точек следует за renderScale, не только за resize */
    const pf = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    if (matPoints) { matPoints.uniforms.uProj.value = pf; matSplatPts.uniforms.uProj.value = pf * 0.5; }
  }

  /* ---------- ввод ---------- */
  const pointer = { x: 0.5, y: 0.5, has: false, downT: 0, lastTap: 0 };
  const cursor3 = new THREE.Vector3(0, 5, 0);   // сглаженная сингулярность
  const sink3 = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const bbox = new THREE.Box3();
  let brushUV = new THREE.Vector2(0.5, 0.5);
  let brushOn = 0;
  const fireLight = new THREE.Vector3(0, 8, 0);   // точка живого света от пожара
  let fireK = 0;                                   // его сила 0..1
  const cursorEl = document.getElementById('cursor');

  function onMove(x, y) {
    pointer.x = x / innerWidth; pointer.y = y / innerHeight; pointer.has = true;
    app.idleT = 0; app.auto = false;
    if (cursorEl) { cursorEl.style.left = x + 'px'; cursorEl.style.top = y + 'px'; }
  }
  let activePointers = 0;
  addEventListener('pointermove', (e) => { if (e.isPrimary) onMove(e.clientX, e.clientY); }, { passive: true });
  addEventListener('pointerdown', (e) => {
    activePointers++;
    if (!e.isPrimary || activePointers > 1) { pointer.lastTap = 0; return; }  // щипок ≠ дабл-тап
    onMove(e.clientX, e.clientY);
    audio.resume().then(() => { if (!app.soundOn && !app.userMuted) toggleSound(true); });
    if (e.pointerType === 'touch' && DeviceOrientationEvent.requestPermission) {
      try { DeviceOrientationEvent.requestPermission().catch(() => {}); } catch (err) {}
    }
    const now = performance.now();
    if (now - pointer.lastTap < 320) nextAct();
    pointer.lastTap = now;
  });
  const pointerGone = () => { activePointers = Math.max(0, activePointers - 1); };
  addEventListener('pointerup', pointerGone);
  addEventListener('pointercancel', pointerGone);
  addEventListener('wheel', (e) => {
    app.timeTarget = THREE.MathUtils.clamp(app.timeTarget * (e.deltaY > 0 ? 1.25 : 0.8), 0.05, 1);
    app.idleT = 0; app.auto = false; app.cineSlow = false;   // пользователь взял время в руки
  }, { passive: true });
  /* щипок — время */
  let pinchD = 0;
  addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (pinchD) app.timeTarget = THREE.MathUtils.clamp(app.timeTarget * (d > pinchD ? 0.96 : 1.04), 0.05, 1);
      pinchD = d;
    }
  }, { passive: true });
  addEventListener('touchend', () => { pinchD = 0; });
  /* наклон телефона — вектор гравитации в фазе обрушения */
  addEventListener('deviceorientation', (e) => {
    if (e.beta == null || app.act < 2) return;
    const b = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(e.beta - 45, -40, 40));
    const g = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(e.gamma || 0, -40, 40));
    matCluster.uniforms.uGravity.value.set(Math.sin(g), -Math.cos(b) * Math.cos(g), -Math.sin(b)).multiplyScalar(22);
    matParticle.uniforms.uGravity.value.copy(matCluster.uniforms.uGravity.value);
  });

  function nextAct() {
    if (app.act < 5) setAct(app.act + 1);
  }

  /* ---------- звук ---------- */
  const audio = new RaspadAudio();
  const soundBtn = document.getElementById('sound');
  function toggleSound(on, manual) {
    app.soundOn = on;
    if (manual) app.userMuted = !on;   // ручной мьют не перебивается кликами по сцене
    soundBtn.textContent = T.sound[on ? 1 : 0];
    soundBtn.setAttribute('aria-pressed', String(on));
    if (!on) { audio.drone(false, 0); audio.rumble(0); audio.hiss(0); }
  }
  soundBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.resume().then(() => toggleSound(!app.soundOn, true));
  });
  /* скрытая вкладка не должна гудеть */
  document.addEventListener('visibilitychange', () => {
    const ctx = audio._ctx;
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else if (app.soundOn) ctx.resume();
  });

  /* ---------- акты ---------- */
  const actEl = document.getElementById('act');
  function setAct(a) {
    app.act = a; app.actT = 0;
    actEl.textContent = T.acts[a];
    actEl.classList.remove('flip'); void actEl.offsetWidth; actEl.classList.add('flip');
    if (a === 1) {
      app.heat = 0; app.bassFired = false;
      matParticle.uniforms.uAssembleT.value = 1.2;   // дабл-клик из сборки: досняпить всех к rest
    }
    if (a === 2) {
      const dir = new THREE.Vector3(cursor3.x, 0, cursor3.z).sub(new THREE.Vector3(0, 0, 0));
      dir.setLength(-1.4); dir.y = 0; // рушится ОТ курсора
      matCluster.uniforms.uShear.value.copy(dir.lengthSq() > 0.01 ? dir : new THREE.Vector3(1.4, 0, 0));
      if (app.soundOn) audio.rumble(0.9);
      if (!REDUCED) { app.timeTarget = 0.32; app.cineSlow = true; }   // кино: срыв в полу-slow-mo
    }
    if (a === 3 && app.soundOn) { audio.rumble(0.18); audio.hiss(0.45); hissRamp = 0.45; }
    if (a === 4) { setAct(5); return; }   // акт «сингулярность» выкинут — сразу к пересборке
    if (a === 5) {
      app.cycle++;
      if (!tierLocked) retier();
      loadCycle(false);
      app.frozen = false;
      matParticle.uniforms.uImplode.value = 0;   // дабл-клик из имплозии не должен тащить её в новый цикл
      if (app.soundOn) { audio.hiss(0); audio.rumble(0); }
    }
  }
  let hissRamp = 0;

  /* тир по медиане кадра первых секунд; апгрейд только на границе цикла */
  function retier() {
    tierLocked = true;
    if (isTouch || !benchTimes.length) return;
    benchTimes.sort((a, b) => a - b);
    const med = benchTimes[benchTimes.length >> 1];
    if (med > 15 && side > TIERS.HIGH) { side = TIERS.HIGH; rebuild(); }
    else if (med > 24 && side > TIERS.MOBILE) { side = TIERS.MOBILE; rebuild(); }
  }
  function rebuild() {
    makeTargets(); buildScene();
    targetsFresh = true;
    matParticle.uniforms.tCrack.value = crack.read.texture;
    matCubes.uniforms.uSide.value = side;
    matPoints.uniforms.uSide.value = side;
    matSplatPts.uniforms.uSide.value = side;
    resize();
  }

  /* ---------- автопилот ---------- */
  function autopilot(dt, rt) {
    app.idleT += dt;
    if (app.idleT > 8) app.auto = true;
    if (cursorEl) cursorEl.classList.toggle('auto', app.auto);
    if (!app.auto) return;
    const t = rt * 0.35;
    /* в актах 3-4 сингулярность держится у центра сцены — камера и материя не разбегаются */
    const ax = app.act >= 3 ? 0.07 : 0.33, ay = app.act >= 3 ? 0.05 : 0.2;
    pointer.x = 0.5 + ax * Math.sin(t) * Math.sin(t * 0.31 + 1.7);
    pointer.y = (app.act >= 3 ? 0.5 : 0.42) + ay * Math.sin(t * 0.77 + 0.4);
    if (app.act === 1) app.heat += dt * 0.55;                       // сам греет
    if (cursorEl) { cursorEl.style.left = pointer.x * innerWidth + 'px'; cursorEl.style.top = pointer.y * innerHeight + 'px'; }
  }

  /* ---------- камера ---------- */
  const camRig = { az: 0.6, el: 0.32, r: 34, taz: 0.6, tel: 0.32, tr: 34, look: new THREE.Vector3(0, 7, 0), tlook: new THREE.Vector3(0, 7, 0) };
  function updateCamera(dt, rt) {
    const b = geoData ? geoData.bounds : { max: [8, 20, 8], min: [-8, 0, -8] };
    const H = b.max[1];
    const R = Math.max(b.max[0] - b.min[0], H, b.max[2] - b.min[2]) * 1.45 + 6;
    camRig.taz += dt * (REDUCED ? 0 : 0.021);   // reduced-motion: без непрерывной орбиты
    switch (app.act) {
      case 0: case 5: {
        const p = Math.min(app.actT / 2.8, 1);
        camRig.tel = 0.06 + 0.3 * p; camRig.tr = R * (1.25 - 0.25 * p);
        camRig.tlook.set(0, H * (0.25 + 0.3 * p), 0); break;
      }
      case 1: camRig.tel = 0.24; camRig.tr = R; camRig.tlook.set(0, H * 0.5, 0); break;
      case 2: camRig.tel = 0.28; camRig.tr = R * 0.95; camRig.tlook.set(0, H * 0.32, 0); break;
      /* пепел: камера отъезжает и поднимает взгляд вслед восходящим углям */
      case 3: case 4: {
        const p = Math.min(app.actT / 9, 1);
        camRig.tel = 0.2 + 0.16 * p; camRig.tr = R * (0.85 + 0.35 * p);
        camRig.tlook.set(0, 2 + H * 0.45 * p, 0); break;
      }
    }
    /* параллакс от указателя */
    const pk = REDUCED ? 0.35 : 1;
    const px = (pointer.x - 0.5) * 0.24 * pk, py = (pointer.y - 0.5) * 0.14 * pk;
    const k = 1 - Math.pow(0.0015, dt);
    camRig.az += (camRig.taz + px - camRig.az) * k;
    camRig.el += (camRig.tel - py - camRig.el) * k;
    camRig.r += (camRig.tr - camRig.r) * k;
    camRig.look.lerp(camRig.tlook, k);
    const sh = REDUCED ? 0 : app.shake;
    const off = new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    camera.position.set(
      camRig.look.x + camRig.r * Math.cos(camRig.el) * Math.cos(camRig.az),
      camRig.look.y + camRig.r * Math.sin(camRig.el),
      camRig.look.z + camRig.r * Math.cos(camRig.el) * Math.sin(camRig.az)
    ).add(off);
    camera.lookAt(camRig.look.clone().add(off.multiplyScalar(0.4)));
  }

  /* ---------- дебаг ---------- */
  const dbg = document.getElementById('debug');
  let fpsAcc = 0, fpsN = 0, fps = 0;
  addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') dbg.hidden = !dbg.hidden;
    if (!dbg.hidden) {
      if (e.code.startsWith('Digit')) { const a = +e.code.slice(5) - 1; if (a >= 0 && a <= 5) setAct(a); }
      if (e.code === 'KeyR') setAct(5);   // setAct(5) сам инкрементирует цикл и перегенерирует
      if (e.code === 'KeyG') app.fixSeed = !app.fixSeed;
    }
  });

  /* ---------- кадр ---------- */
  let prevNow = performance.now();
  let realT = 0;
  let crackAcc = 0;
  let needResize = false;

  function frame() {
    requestAnimationFrame(frame);
    if (needResize) { needResize = false; resize(); }
    const now = performance.now();
    const rdt = Math.min((now - prevNow) / 1000, 0.05);
    prevNow = now;
    realT += rdt;
    /* bullet-time: плавно к цели; в заморозке — ноль */
    app.timeScale += (app.timeTarget - app.timeScale) * (1 - Math.pow(0.001, rdt));
    const frozen = app.frozen;
    const dt = frozen ? 0 : rdt * app.timeScale;
    simT.t += dt;
    audio.setTimeScale(frozen ? 0.05 : app.timeScale);

    autopilot(rdt, realT);

    /* — тайминги актов: физические акты идут по sim-времени — */
    app.actT += (app.act === 1 || app.act === 4) ? rdt : dt;

    /* — курсор в мир — */
    ndc.set(pointer.x * 2 - 1, -(pointer.y * 2 - 1));
    ray.setFromCamera(ndc, camera);
    brushOn = 0;
    if (geoData) {
      bbox.min.fromArray(geoData.bounds.min); bbox.max.fromArray(geoData.bounds.max);
      bbox.expandByScalar(0.4);
      const hit = ray.ray.intersectBox(bbox, new THREE.Vector3());
      if (hit && app.act === 1) {
        brushOn = 1;
        /* UV-атлас фасадов 2×2 — формула зеркалит geometry.js */
        const c = bbox.getCenter(new THREE.Vector3()), s = bbox.getSize(new THREE.Vector3());
        const lx = (hit.x - c.x) / s.x, lz = (hit.z - c.z) / s.z;
        let fu, qx, qy;
        if (Math.abs(lx) > Math.abs(lz)) { fu = (hit.z - bbox.min.z) / s.z; qx = lx > 0 ? 0 : 0.5; qy = 0; }
        else { fu = (hit.x - bbox.min.x) / s.x; qx = lz > 0 ? 0 : 0.5; qy = 0.5; }
        brushUV.set(qx + fu * 0.5, qy + ((hit.y - bbox.min.y) / s.y) * 0.5);
        fireLight.lerp(hit, 0.2);
        app.shake = Math.max(app.shake, 0.02 + 0.1 * releasedFrac);
        if (app.soundOn && Math.random() < rdt * 9) audio.crackle(0.3 + 0.5 * releasedFrac);
      }
      fireK += ((brushOn && app.act === 1) ? 1.4 : -0.6) * rdt;
      fireK = THREE.MathUtils.clamp(fireK, 0, 1);
      const gHit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      /* сингулярность и сток не уходят от здания дальше ~радиуса сцены,
         иначе автопилот утаскивает камеру и материю в чистое поле */
      const rMax = Math.max(bbox.max.x - bbox.min.x, bbox.max.z - bbox.min.z) * 0.9 + 4;
      const clampXZ = (v) => {
        const l = Math.hypot(v.x, v.z);
        if (l > rMax) { v.x *= rMax / l; v.z *= rMax / l; }
        return v;
      };
      if (gHit) sink3.lerp(clampXZ(gHit), 0.08);
      const target = clampXZ((hit || gHit || cursor3).clone());
      cursor3.lerp(new THREE.Vector3(target.x, Math.max(target.y, 4.2), target.z), 0.06);
    }

    /* — драматургия — */
    switch (app.act) {
      case 0: case 5: {
        /* fast ускоряет только нулевой акт: реверс — магический бит, его не комкаем */
        const at = Math.min(app.actT / 2.8, 1.2) * (OFF('fast') && app.act === 0 ? 4 : 1);
        matParticle.uniforms.uAssembleT.value = Math.min(at, 1.2);
        /* россыпь защёлкивающихся вокселей: плотность — колокол по прогрессу сборки */
        if (app.soundOn && at > 0.03 && at < 1.05) {
          const dens = Math.min(1, at * (1.1 - at) * 5);
          if (Math.random() < rdt * 30 * dens) audio.tinkle(dens, Math.min(at, 1));
        }
        if (at > 0.92 && !app.bassFired) {
          app.bassFired = true;
          app.shake = REDUCED ? 0 : 0.5;
          if (app.soundOn) audio.bassDrop(1);
        }
        if (at >= 1.18) setAct(1);
        break;
      }
      case 1: {
        /* драматургию ведёт МАТЕРИЯ: акт срыва наступает, когда реально сорвалась половина */
        matParticle.uniforms.uHeatK.value = releasedFrac;
        if (app.soundOn) audio.drone(true, Math.min(1, releasedFrac * 2));
        if (releasedFrac > 0.5 || app.actT > 55) setAct(2);
        break;
      }
      case 2: {
        matCluster.uniforms.uCollapseT.value = app.actT;
        app.shake = Math.max(app.shake, 0.25 * Math.exp(-app.actT * 0.7));
        if (app.soundOn) audio.rumble(Math.max(0.05, 0.9 * Math.exp(-app.actT * 0.4)));
        if (app.cineSlow && app.actT > 1.5) { app.timeTarget = 1; app.cineSlow = false; }  // отпустить slow-mo
        if (app.actT > 6.5) setAct(3);
        break;
      }
      /* акт III — пепел: пожарище догорает, угли всплывают и гаснут; акт IV пропущен */
      case 3: case 4: {
        if (app.soundOn) { hissRamp = Math.max(0, hissRamp - rdt * 0.12); audio.hiss(hissRamp); }
        if (app.actT > 9) setAct(5);
        break;
      }
    }
    app.shake *= Math.pow(0.02, rdt);
    app.flash *= Math.pow(0.03, rdt);   // вспышка живёт ~1.5с — стоп-кадр и реверс успевают прочитаться

    /* — сим-пассы — */
    if (!frozen && !OFF('nosim')) {
      /* акт для шейдеров: ветки написаны под монотонную шкалу 0–4,
         реверс (5) для них — это «акт 0», иначе материя испаряется при сборке */
      const shaderAct = app.act === 5 ? 0 : app.act;
      /* кластеры */
      const cu = matCluster.uniforms;
      cu.tPos.value = clusters.read.textures[0];
      cu.tVel.value = clusters.read.textures[1];
      cu.tQuat.value = clusters.read.textures[2];
      cu.tAng.value = clusters.read.textures[3];
      cu.uDt.value = Math.min(dt, 0.033); cu.uAct.value = shaderAct;
      cu.uTime.value = simT.t;
      cu.tCrack.value = crack.read.texture;
      cu.uFire.value.set(fireLight.x, fireLight.y, fireLight.z, fireK);
      if (!OFF('nocluster')) { passer.run(matCluster, clusters.write); clusters.swap(); }

      /* трещины: ~170 итераций/с независимо от герцовки, честно замирают в bullet-time */
      crackAcc += rdt * app.timeScale * 170;
      let crackIters = Math.min(4, Math.floor(crackAcc));
      crackAcc -= crackIters;
      if (OFF('nocrack')) crackIters = 0;
      for (let i = 0; i < crackIters; i++) {
        matCrack.uniforms.tPrev.value = crack.read.texture;
        matCrack.uniforms.uBrush.value.copy(brushUV);
        matCrack.uniforms.uBrushOn.value = brushOn * (app.act === 1 ? 1 : 0);
        passer.run(matCrack, crack.write);
        crack.swap();
      }

      /* частицы */
      const pu = matParticle.uniforms;
      pu.tPos.value = particles.read.textures[0];
      pu.tVel.value = particles.read.textures[1];
      pu.tRest.value = texRest;
      pu.tCrack.value = crack.read.texture;
      pu.tCPos.value = clusters.read.textures[0];
      pu.tCVel.value = clusters.read.textures[1];
      pu.tCQuat.value = clusters.read.textures[2];
      pu.tCAng.value = clusters.read.textures[3];
      pu.tCStatic.value = texCStatic;
      pu.uDt.value = Math.min(dt, 0.033);
      pu.uTime.value = simT.t;
      pu.uAct.value = shaderAct;
      pu.uActT.value = app.actT;
      pu.uCursor.value.copy(cursor3);
      pu.uSink.value.copy(sink3);
      if (!OFF('nopart')) { passer.run(matParticle, particles.write); particles.swap(); }
    }

    /* — рендер сцены — */
    matCubes.uniforms.tPos.value = particles.read.textures[0];
    matCubes.uniforms.tVel.value = particles.read.textures[1];
    matCubes.uniforms.tRest.value = texRest;
    matCubes.uniforms.tCQuat.value = clusters.read.textures[2];
    matCubes.uniforms.uTime.value = simT.t;
    matPoints.uniforms.tPos.value = particles.read.textures[0];
    matPoints.uniforms.tVel.value = particles.read.textures[1];
    matPoints.uniforms.uTime.value = simT.t;
    matSplatPts.uniforms.tPos.value = particles.read.textures[0];
    matSplatPts.uniforms.tVel.value = particles.read.textures[1];
    matSplatPts.uniforms.uTime.value = simT.t;
    splatPts.visible = !OFF('nopoints') && side > TIERS.MOBILE;
    matFloor.uniforms.uPresence.value = app.act <= 1 ? 1 : (app.act >= 4 ? 0 : 0.5);
    matFloor.uniforms.uTime.value = simT.t;
    matCubes.uniforms.uFire.value.set(fireLight.x, fireLight.y, fireLight.z, fireK);
    matFloor.uniforms.uFire.value.copy(matCubes.uniforms.uFire.value);
    matSplatPts.uniforms.uFire.value.copy(matCubes.uniforms.uFire.value);
    matPoints.uniforms.uFire.value.copy(matCubes.uniforms.uFire.value);
    cubes.visible = !OFF('nocubes');
    points.visible = !OFF('nopoints');
    floor.visible = !OFF('nofloor');

    if (OFF('nopost')) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      updateCamera(rdt, realT);
      return;
    }
    renderer.setRenderTarget(rtScene);
    renderer.render(scene, camera);

    /* метабол-жидкость выкинута вместе с актом «плавление» — пепел рисуется точками */
    matComposite.uniforms.uLiquid.value = 0;

    /* — блум — */
    matBright.uniforms.tScene.value = rtScene.texture;
    passer.run(matBright, rtBrightA);
    matBlur.uniforms.tSrc.value = rtBrightA.texture; matBlur.uniforms.uDir.value.set(1.6 / rtBrightA.width, 0);
    passer.run(matBlur, rtBrightB);
    matBlur.uniforms.tSrc.value = rtBrightB.texture; matBlur.uniforms.uDir.value.set(0, 1.6 / rtBrightA.height);
    passer.run(matBlur, rtBrightA);

    /* — композит на экран — */
    const cc = matComposite.uniforms;
    cc.tScene.value = rtScene.texture;
    cc.tBloom.value = rtBrightA.texture;
    cc.tSplat.value = rtSplat.texture;
    cc.uTime.value = realT;
    cc.uFlash.value = app.flash;
    cc.uShake.value = app.shake;
    passer.run(matComposite, null);

    /* — доля сорвавшихся кластеров: дешёвый readback 32×32 раз в ~0.4с — */
    if (fpsN % 24 === 0 && app.act >= 1 && app.act <= 2 && geoData) {
      const cb = new Float32Array(32 * 32 * 4);
      renderer.readRenderTargetPixels(clusters.read, 0, 0, 32, 32, cb);
      let rel = 0;
      for (let i = 0; i < geoData.clusterCount; i++) if (cb[i * 4 + 3] > 0.5) rel++;
      releasedFrac = rel / Math.max(1, geoData.clusterCount);
    }

    /* — бенч/адаптация — */
    const ft = rdt * 1000;
    if (!tierLocked && realT > 1 && realT < 4) benchTimes.push(ft);
    fpsAcc += ft; fpsN++;
    if (fpsN >= 30) {
      fps = 30000 / fpsAcc;
      const avg = fpsAcc / 30; fpsAcc = 0; fpsN = 0;
      if (avg > 17 && renderScale > 0.7) { renderScale -= 0.1; makePost(); }
      else if (avg < 11 && renderScale < 1) { renderScale += 0.1; makePost(); }
      if (!dbg.hidden) dbg.textContent =
        `fps ${fps.toFixed(0)} · ${side}² = ${(N() / 1000).toFixed(0)}k · scale ${renderScale.toFixed(1)}\n` +
        `act ${app.act} t=${app.actT.toFixed(1)} cycle ${app.cycle} seed ${app.fixSeed ? 7 : app.seed + app.cycle}\n` +
        `released ${(releasedFrac * 100).toFixed(0)}% · ts ${app.timeScale.toFixed(2)}`;
    }

    updateCamera(rdt, realT);
  }

  /* ---------- resize/старт ---------- */
  function resize() {
    renderer.setSize(innerWidth * DPR(), innerHeight * DPR(), false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    makePost();
  }
  addEventListener('resize', () => { needResize = true; });   // дебаунс: 5 таргетов не пересоздаются на каждый твик окна
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    const nogl = document.getElementById('nogl');
    nogl.textContent = T.nogl;
    nogl.hidden = false;
  });

  makeTargets();
  buildScene();
  loadCycle(true);
  setAct(0);
  if (FLAGS.get('act')) {   // прямой прыжок в акт для отладки/скриншотов
    matParticle.uniforms.uAssembleT.value = 1.2;
    setAct(Math.max(0, Math.min(5, +FLAGS.get('act') || 0)));
  }
  resize();
  frame();
  if (FLAGS.has('expose')) window.__R = { app, matPoints, matCubes, matParticle, matCluster, particles: () => particles, clusters: () => clusters, renderer, scene, camera, points, cubes, setAct, THREE };
  /* телеметрия в title: видна даже когда CDP/консоль недоступны */
  if (FLAGS.has('tele')) setInterval(() => {
    let ph = '';
    if (OFF('phist')) {
      /* гистограмма фаз по блоку 64×64 + контроль NaN */
      const n = 64, buf = new Float32Array(n * n * 4);
      renderer.readRenderTargetPixels(particles.read, (side - n) >> 1, (side - n) >> 1, n, n, buf);
      const hist = [0, 0, 0, 0, 0, 0, 0]; let nan = 0, ymin = 1e9, ymax = -1e9;
      for (let i = 0; i < n * n; i++) {
        const y = buf[i * 4 + 1], w = buf[i * 4 + 3];
        if (!isFinite(y) || !isFinite(w)) { nan++; continue; }
        hist[Math.max(0, Math.min(6, Math.round(w)))]++;
        ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      }
      ph = ` ph[${hist.join(',')}] nan${nan} y${ymin.toFixed(1)}..${ymax.toFixed(1)}`;
    }
    document.title = `A${app.act} t${app.actT.toFixed(1)} fps${fps.toFixed(0)} ts${app.timeScale.toFixed(2)} as${matParticle.uniforms.uAssembleT.value.toFixed(2)}` + ph;
  }, 1000);
})();

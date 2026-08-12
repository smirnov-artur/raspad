/* === РАСПАД — GPGPU-ядро: ping-pong FBO с MRT, фуллскрин-пассы. ===
   Никакого GPUComputationRenderer — свой минимум: он не умеет MRT,
   а нам нужен один пасс на пару pos+vel и один на четвёрку кластера. */

import * as THREE from 'three';

/* пара MRT рендертаргетов с обменом */
export class PingPong {
  constructor(w, h, count, type) {
    const opts = {
      count,
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.a = new THREE.WebGLRenderTarget(w, h, opts);
    this.b = new THREE.WebGLRenderTarget(w, h, opts);
    this.w = w; this.h = h;
  }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/* исполнитель фуллскрин-пассов: один треугольник, материал подставляется */
export class Passer {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.mesh = new THREE.Mesh(geo, null);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  run(material, target) {
    this.mesh.material = material;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }
}

/* материал сим-пасса: GLSL3, без света/тумана */
export function passMaterial(vert, frag, uniforms) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

/* DataTexture float32 из массива */
export function dataTexture(arr, w, h) {
  const tex = new THREE.DataTexture(arr, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

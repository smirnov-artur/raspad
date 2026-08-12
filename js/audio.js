/* === РАСПАД — audio. Полный синтез звука сцены: дрон, удар, треск, гул, имплозия — без единого аудиофайла. === */

// Уровни подобраны под лимитер: суммарные пики после цепи не выше −6 dBFS.
const MASTER_LEVEL = 0.9;  // суммирующий гейн до лимитера, линейный
const OUT_CEIL     = 0.5;  // потолок после лимитера: 0.5 ≈ −6 dBFS
const SUB_HZ       = 55;   // опорная частота саб-дрона, Гц
const NOISE_S      = 2;    // длина зацикленных шумовых буферов, с
const SEAM         = 2048; // сэмплов кроссфейда на стыке лупа — иначе щелчок раз в 2 с
const EPS          = 1e-4; // пол огибающих: exponentialRamp с нуля бросает исключение
const IR_S         = 1.5;  // длина процедурного импульса «зала обрушения», с
const RAMP_S       = 0.2;  // стандартная рампа уровня при повторных вызовах, с

export class RaspadAudio {
  // Конструктор не трогает WebAudio: модуль обязан импортироваться в node без ошибок.
  constructor() {
    this._ctx = null;
    this._nodes = null;     // мастер-цепь + ленивые постоянные цепи (drone/rumble/hiss)
    this._timeScale = 1;
    this._tension = 0;
  }

  get ready() { return !!this._ctx && this._ctx.state === 'running'; }

  // Вызывается из жеста пользователя: autoplay-политика не даст создать контекст раньше.
  async resume() {
    if (this._ctx) {
      if (this._ctx.state === 'suspended') await this._ctx.resume();
      return;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return; // среда без WebAudio (node, старые браузеры) — остаёмся немыми
    this._ctx = new AC();
    this._build();
    if (this._ctx.state === 'suspended') await this._ctx.resume();
  }

  // Саб-дрон: два расстроенных синуса через сатуратор — биения и «рык» без сэмплов.
  drone(on, tension = 0) {
    if (!this.ready) return;
    this._tension = Math.min(1, Math.max(0, tension));
    const N = this._nodes;
    if (!N.drone) {
      const c = this._ctx;
      const o1 = c.createOscillator(); o1.type = 'sine';
      const o2 = c.createOscillator(); o2.type = 'sine';
      const mix = c.createGain(); mix.gain.value = 0.5; // два голоса в сатуратор без перегруза краёв кривой
      const ws = this._shaper(2.5);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
      lp.frequency.value = 160; // Гц, тёмный старт
      const g = c.createGain(); g.gain.value = 0;
      o1.connect(mix); o2.connect(mix);
      mix.connect(ws).connect(lp).connect(g).connect(N.sum);
      o1.start(); o2.start();
      N.drone = { o1, o2, lp, g }; // осцилляторы живут постоянно, гейтим гейном — без утечек
    }
    this._tuneDrone();
    this._ramp(N.drone.g.gain, on ? 0.22 + 0.1 * this._tension : 0);
  }

  // Bullet-time: мир глохнет (мастер-lowpass вниз), дрон проваливается на октаву.
  setTimeScale(s) {
    this._timeScale = Math.min(1, Math.max(0.05, s));
    if (!this.ready) return;
    const t = this._ctx.currentTime;
    const n = (this._timeScale - 0.05) / 0.95;
    // лог-интерполяция среза 280 Гц … 16 кГц: линейная звучит как резкий обрыв верха
    const f = 280 * Math.pow(16000 / 280, n);
    this._nodes.lp.frequency.setTargetAtTime(f, t, 0.15);
    this._tuneDrone();
  }

  // Посадка здания: суб-свип 90→30 Гц + щелчок (читаемость на ноутбучных динамиках) + пыль.
  bassDrop(power = 1) {
    if (!this.ready) return;
    const p = Math.min(1, Math.max(0, power));
    const c = this._ctx, N = this._nodes, t = c.currentTime;
    const amp = 0.35 + 0.45 * p;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.5);
    const g = c.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.008);
    g.gain.setTargetAtTime(EPS, t + 0.08, 0.28); // длинный суб-хвост, к 1.4 с уже неслышен
    o.connect(g).connect(N.sum);
    o.start(t); o.stop(t + 1.4);
    o.onended = () => { o.disconnect(); g.disconnect(); };
    this._grain({ when: t, dur: 0.012, peak: 0.5 * amp, type: 'highpass', freq: 1500, q: 0.7, attack: 0.001 });
    this._grain({ when: t + 0.01, dur: 0.35, peak: 0.22 * amp, type: 'lowpass', freq: 500, q: 0.5, attack: 0.005 });
  }

  // Треск: очередь из 1–4 гранул по 5–15 мс, разброс до 60 мс — иначе слипаются в один клик.
  crackle(intensity = 0.5) {
    if (!this.ready) return;
    const k = Math.min(1, Math.max(0, intensity));
    const t = this._ctx.currentTime;
    const n = 1 + Math.floor(Math.random() * (1 + k * 3));
    for (let i = 0; i < n; i++) {
      const when = t + Math.random() * 0.06;
      const dur = 0.005 + Math.random() * 0.010;
      const freq = 700 + Math.random() * (1300 + 5500 * k); // Гц: ярче при высокой интенсивности
      this._grain({ when, dur, peak: 0.10 + 0.16 * k, type: 'bandpass', freq, q: 5, attack: 0.001 });
    }
  }

  // Гул обрушения: коричневый шум → лёгкая сатурация → свёртка с процедурным импульсом.
  rumble(level = 0) {
    if (!this.ready) return;
    const v = Math.min(1, Math.max(0, level));
    const N = this._nodes;
    if (!N.rumble) {
      const c = this._ctx;
      const src = this._loop(N.brown);
      const ws = this._shaper(1.6); // грязь до свёртки: рык, а не фузз
      const conv = c.createConvolver();
      conv.buffer = N.ir; // normalize по умолчанию — уровень не зависит от длины IR
      const g = c.createGain(); g.gain.value = 0;
      src.connect(ws).connect(conv).connect(g).connect(N.sum);
      N.rumble = { src, g }; // цепь одна на весь сеанс, повторные вызовы только двигают гейн
    }
    this._ramp(N.rumble.g.gain, v * 0.5, 0.25);
  }

  // Кипение/испарение: розовый шум в bandpass, центр медленно дрейфует 2.2–5.8 кГц.
  hiss(level = 0) {
    if (!this.ready) return;
    const v = Math.min(1, Math.max(0, level));
    const N = this._nodes;
    if (!N.hiss) {
      const c = this._ctx;
      const src = this._loop(N.pink);
      const bp = c.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 4000; bp.Q.value = 0.9;
      const lfo = c.createOscillator(); lfo.type = 'sine';
      lfo.frequency.value = 0.13;  // Гц — «дыхание», а не вибрато
      const lfoAmp = c.createGain(); lfoAmp.gain.value = 1800; // девиация центра, Гц
      lfo.connect(lfoAmp).connect(bp.frequency);
      lfo.start();
      const g = c.createGain(); g.gain.value = 0;
      src.connect(bp).connect(g).connect(N.sum);
      N.hiss = { src, lfo, g };
    }
    this._ramp(N.hiss.g.gain, v * 0.16, 0.15);
  }

  // Всасывание: резонансный свип вверх 1.5 с → мгновенный гейт в ноль → 1.2 с вакуума → щелчок-вспышка.
  implosion() {
    if (!this.ready) return;
    const c = this._ctx, N = this._nodes, t = c.currentTime;
    const gate = c.createGain();
    gate.connect(N.sum);
    const src = c.createBufferSource(); src.buffer = N.white;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 14; // острый резонанс — «воет»
    bp.frequency.setValueAtTime(120, t);
    bp.frequency.exponentialRampToValueAtTime(2800, t + 1.5);
    const o = c.createOscillator(); o.type = 'sine'; // тональный стержень внутри шумового свипа
    o.frequency.setValueAtTime(50, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 1.5);
    const og = c.createGain(); og.gain.value = 0.35;
    const env = c.createGain();
    env.gain.setValueAtTime(EPS, t);
    env.gain.exponentialRampToValueAtTime(0.5, t + 1.45); // нарастает до самого обрыва
    src.connect(bp).connect(env);
    o.connect(og).connect(env);
    env.connect(gate);
    // setValueAtTime(0) здесь легален и намеренен: щелчок обрыва — часть эффекта
    gate.gain.setValueAtTime(1, t);
    gate.gain.setValueAtTime(0, t + 1.5);
    src.start(t, Math.random() * (NOISE_S - 1.6), 1.55);
    o.start(t); o.stop(t + 1.55);
    o.onended = () => {
      src.disconnect(); bp.disconnect(); o.disconnect();
      og.disconnect(); env.disconnect(); gate.disconnect();
    };
    const flash = t + 1.5 + 1.2;
    this._grain({ when: flash, dur: 0.010, peak: 0.55, type: 'highpass', freq: 2000, q: 0.7, attack: 0.001 });
    this._grain({ when: flash, dur: 0.09, peak: 0.30, type: 'bandpass', freq: 3800, q: 2, attack: 0.002 });
  }

  // Россыпь сборки: тональные пинги по пентатонике — каждый воксель «дзинькает»,
  // волна плотнеет и поднимается по высоте с прогрессом. density 0..1, progress 0..1.
  tinkle(density, progress) {
    if (!this.ready) return;
    const c = this._ctx, N = this._nodes, t = c.currentTime;
    const PENTA = [0, 2, 4, 7, 9]; // мажорная пентатоника, полутоны от C
    const n = 1 + Math.min(3, (density * 3.2) | 0);
    for (let i = 0; i < n; i++) {
      const oct = 3 + ((Math.random() * 0.7 + progress * 1.6) | 0);      // выше к финалу
      const semi = PENTA[(Math.random() * PENTA.length) | 0] + 12 * oct;
      const f = 261.63 * Math.pow(2, (semi - 48) / 12) * (0.995 + Math.random() * 0.01) * 4;
      const t0 = t + Math.random() * 0.06;
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.01;
      const g2 = c.createGain(); g2.gain.value = 0.22;                    // призвук октавой выше
      const g = c.createGain();
      const amp = (0.028 + 0.04 * density) * (0.7 + Math.random() * 0.6);
      g.gain.setValueAtTime(EPS, t0);
      g.gain.exponentialRampToValueAtTime(amp, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(EPS, t0 + 0.1 + Math.random() * 0.12);
      let tail = g;
      if (c.createStereoPanner) {
        tail = c.createStereoPanner();
        tail.pan.value = Math.random() * 1.6 - 0.8;
        g.connect(tail);
      }
      o.connect(g); o2.connect(g2).connect(g);
      tail.connect(N.sum);
      o.start(t0); o2.start(t0);
      o.stop(t0 + 0.3); o2.stop(t0 + 0.3);
      o.onended = () => { g.disconnect(); if (tail !== g) tail.disconnect(); };
    }
  }

  dispose() {
    const c = this._ctx;
    if (!c) return;
    const N = this._nodes;
    const stop = (n) => { try { n.stop(); } catch { /* уже остановлен */ } };
    if (N) {
      if (N.drone) { stop(N.drone.o1); stop(N.drone.o2); }
      if (N.rumble) stop(N.rumble.src);
      if (N.hiss) { stop(N.hiss.src); stop(N.hiss.lfo); }
      try { N.sum.disconnect(); } catch { /* контекст мог умереть первым */ }
    }
    try { c.close(); } catch { /* повторный close бросает */ }
    this._ctx = null;
    this._nodes = null;
  }

  // ---- внутреннее ----

  // Мастер: сумма → lowpass (bullet-time) → лимитер → потолок −6 dBFS → выход.
  _build() {
    const c = this._ctx;
    const sum = c.createGain(); sum.gain.value = MASTER_LEVEL;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = 16000; lp.Q.value = 0.3; // почти прозрачен при timeScale = 1
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -24; // дБ
    comp.knee.value = 30;       // дБ
    comp.ratio.value = 12;      // фактически лимитер
    comp.attack.value = 0.003;  // с
    comp.release.value = 0.25;  // с
    const out = c.createGain(); out.gain.value = OUT_CEIL;
    sum.connect(lp).connect(comp).connect(out).connect(c.destination);
    this._nodes = {
      sum, lp,
      white: this._noise('white'),
      brown: this._noise('brown'),
      pink: this._noise('pink'),
      ir: this._impulse(),
      drone: null, rumble: null, hiss: null,
    };
  }

  // Шум генерируется один раз в AudioBuffer и зацикливается: ScriptProcessor
  // deprecated и дёргает главный поток, AudioWorklet — лишний файл. Буфера 2 с хватает.
  _noise(kind) {
    const c = this._ctx, len = (NOISE_S * c.sampleRate) | 0;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let br = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'brown') { br = (br + 0.02 * w) / 1.02; d[i] = br * 3.5; }
      else {
        // розовый: 3-полюсная аппроксимация Келлета — для шипения точности достаточно
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
      }
    }
    // кроссфейд хвоста в голову; луп потом идёт с отсчёта SEAM (см. _loop) — стык бесшовный
    for (let i = 0; i < SEAM; i++) {
      const a = i / SEAM;
      d[len - SEAM + i] = d[len - SEAM + i] * (1 - a) + d[i] * a;
    }
    return buf;
  }

  // Процедурный импульс «бетонного зала»: стереошум с затуханием до ≈ −60 дБ к концу.
  _impulse() {
    const c = this._ctx, len = (IR_S * c.sampleRate) | 0;
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); // каналы независимы — даёт ширину
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-6.9 * i / len);
    }
    return buf;
  }

  _loop(buf) {
    const s = this._ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.loopStart = SEAM / this._ctx.sampleRate; // пропускаем голову, вшитую в хвост кроссфейдом
    s.loopEnd = buf.duration;
    s.start();
    return s;
  }

  _shaper(k) {
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1));
    const ws = this._ctx.createWaveShaper();
    ws.curve = curve; ws.oversample = '2x'; // tanh почти не алиасит, 2x дешевле 4x
    return ws;
  }

  // Плавное обновление уровня без наслоения расписаний при частых вызовах.
  _ramp(p, v, dur = RAMP_S) {
    const t = this._ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(v, t + dur);
  }

  // Одноразовая шумовая гранула: срез общего белого буфера через biquad с огибающей.
  // Ноды самоуничтожаются по onended — утечек при любом числе вызовов нет.
  _grain({ when, dur, peak, type = 'bandpass', freq, q = 1, freqEnd = 0, attack = 0.002 }) {
    const c = this._ctx, N = this._nodes;
    const src = c.createBufferSource();
    src.buffer = N.white;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, when);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, when + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(EPS, when);
    g.gain.exponentialRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(EPS, when + dur);
    src.connect(f).connect(g).connect(N.sum);
    src.start(when, Math.random() * (NOISE_S - dur - 0.05), dur + 0.02);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
  }

  // Ступени тона: tension квантуется в 0…3 полутона — питч подтягивается рывками, как трос.
  _tuneDrone() {
    const N = this._nodes;
    if (!N || !N.drone) return;
    const t = this._ctx.currentTime;
    const semi = Math.round(this._tension * 3);
    const oct = this._timeScale < 0.3 ? 0.5 : 1; // на глубоком bullet-time дрон падает на октаву
    const f = SUB_HZ * Math.pow(2, semi / 12) * oct;
    const beat = 0.4 + 3.6 * this._tension; // Гц биений между голосами
    N.drone.o1.frequency.setTargetAtTime(f, t, 0.15);
    N.drone.o2.frequency.setTargetAtTime(f + beat, t, 0.15);
    N.drone.lp.frequency.setTargetAtTime(160 + 900 * this._tension, t, 0.1);
  }
}

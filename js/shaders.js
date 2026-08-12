/* === РАСПАД — все GLSL-шейдеры строками. ES 3.00 (three glslVersion: GLSL3). ===
   Соглашения:
   - texPos: xyz позиция, w фаза (0 solid, 1 rigid-кластер, 2 debris, 3 liquid, 4 gas, 5 аккреция, 6 сборка-полёт)
   - texVel: xyz скорость, w тепло частицы 0..1
   - texRest: xyz rest-позиция, w индекс кластера
   - texMeta: xy UV фасада, z запечённый AO, w нормированный Morton-ранг (стаггер сборки)
   - кластеры 32×32 MRT: pos+state / vel+impact / quat / angVel
   ShaderMaterial: three сам объявляет position/uv/матрицы — не редекларировать. */

/* ---------- общие куски ---------- */

export const CHUNK_HASH = /* glsl */`
float hash11(float p){ p = fract(p*443.8975); p += dot(vec2(p,p+19.19), vec2(p+7.13,p)); return fract(p*p); }
float hash13(vec3 p){ p = fract(p*443.8975); p += dot(p, p.yzx+19.19); return fract((p.x+p.y)*p.z); }
vec3 hash33(vec3 p){ return vec3(hash13(p), hash13(p+31.7), hash13(p+91.3)); }
`;

/* компактный 3D value-noise с градиентной интерполяцией — хватает для curl */
export const CHUNK_NOISE = /* glsl */`
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  float a = hash13(i), b = hash13(i+vec3(1,0,0)), c = hash13(i+vec3(0,1,0)), d = hash13(i+vec3(1,1,0));
  float e = hash13(i+vec3(0,0,1)), g = hash13(i+vec3(1,0,1)), h = hash13(i+vec3(0,1,1)), k = hash13(i+vec3(1,1,1));
  return mix(mix(mix(a,b,u.x), mix(c,d,u.x), u.y), mix(mix(e,g,u.x), mix(h,k,u.x), u.y), u.z);
}
vec3 curl(vec3 p){
  const float e = 0.35;
  float x1 = vnoise(p+vec3(0,e,0)), x2 = vnoise(p-vec3(0,e,0));
  float y1 = vnoise(p+vec3(0,0,e)+11.3), y2 = vnoise(p-vec3(0,0,e)+11.3);
  float z1 = vnoise(p+vec3(e,0,0)+47.9), z2 = vnoise(p-vec3(e,0,0)+47.9);
  return normalize(vec3(x1-x2, y1-y2, z1-z2) + 1e-5);
}
`;

export const CHUNK_QUAT = /* glsl */`
vec4 qmul(vec4 a, vec4 b){
  return vec4(a.w*b.xyz + b.w*a.xyz + cross(a.xyz,b.xyz), a.w*b.w - dot(a.xyz,b.xyz));
}
vec3 qrot(vec4 q, vec3 v){ return v + 2.0*cross(q.xyz, cross(q.xyz,v) + q.w*v); }
`;

/* ---------- фуллскрин-треугольник ---------- */

export const VERT_PASS = /* glsl */`
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* ---------- пасс кластеров: 1024 rigid-тел ---------- */

export const FRAG_CLUSTER = CHUNK_HASH + CHUNK_QUAT + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 oPos;   // xyz, w state: 0 locked / 1 falling / 2 asleep
layout(location = 1) out vec4 oVel;   // xyz, w сила последнего удара (для эрозии в debris)
layout(location = 2) out vec4 oQuat;
layout(location = 3) out vec4 oAng;   // xyz угловая скорость

uniform sampler2D tPos, tVel, tQuat, tAng, tStatic;  // tStatic: центроид+радиус
uniform sampler2D tExtremes;                          // 256×32: 8 крайних точек на кластер
uniform sampler2D tCUV;                               // uv центроида в атласе, индекс опоры, y-норм
uniform sampler2D tCrack;                             // поле Грея-Скотта — локальный нагрев
uniform float uDt, uTime, uAct, uCollapseT, uMaxY, uSeed;
uniform vec3 uGravity, uShear;
uniform vec4 uFire;                                   // мировая точка огня + сила

void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int id = tc.y*32 + tc.x;
  vec4 st = texelFetch(tStatic, tc, 0);      // центроид, радиус
  vec4 P = texelFetch(tPos, tc, 0);
  vec4 V = texelFetch(tVel, tc, 0);
  vec4 Q = texelFetch(tQuat, tc, 0);
  vec4 A = texelFetch(tAng, tc, 0);
  float state = P.w;

  if (uAct < 0.5) { // сборка/реверс — прибит к rest
    oPos = vec4(st.xyz, 0.0); oVel = vec4(0.0); oQuat = vec4(0,0,0,1); oAng = vec4(0.0);
    return;
  }

  if (state < 0.5) {
    vec4 meta = texelFetch(tCUV, tc, 0);
    /* 1. ЛОКАЛЬНЫЙ нагрев: поле трещин в моей зоне ЛИБО прямая близость к очагу */
    float myCrack = texture(tCrack, meta.xy).g;
    bool heatBreak = myCrack > 0.24;
    if (uFire.w > 0.5 && distance(st.xyz, uFire.xyz) < 2.4
        && hash11(float(id)*7.7 + floor(uTime*8.0)) < uDt*3.5) heatBreak = true;
    /* 2. Потеря опоры: кластер подо мной сорвался — складываюсь следом (стохастическая задержка ~0.25с) */
    bool supportBreak = false;
    int si = int(meta.z + 0.5);
    if (meta.z > -0.5) {
      float supState = texelFetch(tPos, ivec2(si % 32, si / 32), 0).w;
      supportBreak = supState > 0.5 && hash11(float(id)*3.17 + floor(uTime*12.0)) < uDt*4.5;
    }
    /* 3. Сценарный дожим: акт II (автопилот/дабл-клик) добивает остатки стаггером */
    float rel = hash11(float(id)*0.713 + uSeed) * 1.6 * (0.35 + 0.65*(st.y/uMaxY));
    bool actBreak = (uAct > 1.5 && uCollapseT > rel) || uAct > 2.5;

    if (heatBreak || supportBreak || actBreak) {
      state = 1.0;
      if (heatBreak && uAct < 1.5) {
        /* локальный отвал: наружу от оси здания, со скольжением вниз — не «взрыв» */
        vec3 out2 = normalize(vec3(st.x, 0.0, st.z) + 1e-3);
        V.xyz = out2 * 1.6 + vec3(0.0, -0.4, 0.0) + (hash33(st.xyz+uSeed)-0.5)*0.6;
      } else if (supportBreak && uAct < 1.5) {
        V.xyz = vec3(0.0, -0.8, 0.0) + (hash33(st.xyz+uSeed)-0.5)*0.5;   // складывается вниз
      } else {
        V.xyz = uShear * (0.4 + 1.6*st.y/uMaxY) + (hash33(st.xyz+uSeed)-0.5)*1.2;
      }
      A.xyz = (hash33(st.xyz*1.7+uSeed)-0.5) * 3.0;
    } else {
      oPos = vec4(st.xyz, 0.0); oVel = vec4(0.0); oQuat = vec4(0,0,0,1); oAng = vec4(0.0);
      return;
    }
  }

  float impact = 0.0;
  if (state < 1.5) { // падает
    V.xyz += uGravity * uDt;
    P.xyz += V.xyz * uDt;
    // интеграция кватерниона
    vec4 dq = qmul(vec4(A.xyz, 0.0), Q) * 0.5 * uDt;
    Q = normalize(Q + dq);
    // контакт пола по 8 крайним точкам
    float invI = 1.0 / max(0.15, st.w*st.w*0.4);
    for (int e = 0; e < 8; e++) {
      vec3 ext = texelFetch(tExtremes, ivec2(tc.x*8+e, tc.y), 0).xyz;
      vec3 off = qrot(Q, ext);
      float pen = -(P.y + off.y);
      if (pen > 0.0) {
        P.y += pen * 0.6;
        vec3 vp = V.xyz + cross(A.xyz, off);
        if (vp.y < 0.0) {
          float j = -vp.y * 0.32;                 // 8 точек делят импульс
          impact = max(impact, -vp.y);
          V.y += j * 2.2;
          V.xz *= 0.86;
          A.xyz += cross(off, vec3(0.0, j, 0.0)) * invI * 2.0;
        }
      }
    }
    A.xyz *= (1.0 - 0.55*uDt);                    // угловое демпфирование
    V.xyz *= (1.0 - 0.06*uDt);
    A.xyz = clamp(A.xyz, vec3(-8.0), vec3(8.0));  // анти-взрыв
    // сон
    if (P.y < st.w*1.2 && dot(V.xyz,V.xyz) + dot(A.xyz,A.xyz) < 0.035) {
      state = 2.0; V.xyz = vec3(0.0); A.xyz = vec3(0.0);
    }
    P.y = max(P.y, -st.w*0.4); // страховка от провала
  }

  oPos = vec4(P.xyz, state);
  oVel = vec4(V.xyz, max(V.w*(1.0-2.0*uDt), impact));
  oQuat = Q;
  oAng = vec4(A.xyz, 0.0);
}
`;

/* ---------- пасс частиц: машина состояний ---------- */

export const FRAG_PARTICLE = CHUNK_HASH + CHUNK_NOISE + CHUNK_QUAT + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;

uniform sampler2D tPos, tVel, tRest, tMeta, tCrack;
uniform sampler2D tCPos, tCQuat, tCAng, tCVel, tCStatic;
uniform float uDt, uTime, uAct, uActT, uAssembleT, uSeed, uMaxY, uMeltR, uImplode;
uniform vec3 uGravity, uCursor, uSink;
uniform float uCursorOn, uHeatK;

const float FLOOR_H = 0.14;

void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(tPos, tc, 0);
  vec4 V = texelFetch(tVel, tc, 0);
  vec4 R = texelFetch(tRest, tc, 0);
  vec4 M = texelFetch(tMeta, tc, 0);
  float phase = floor(P.w + 0.5);
  float heat = V.w;
  float idh = hash13(R.xyz + uSeed);

  int ci = int(R.w + 0.5);
  ivec2 ctc = ivec2(ci % 32, ci / 32);

  /* --- 6: полёт сборки/реверса --- */
  if (phase > 5.5) {
    float t0 = M.w * 0.62;                                   // стаггер по Morton-рангу
    float t = clamp((uAssembleT - t0) / 0.38, 0.0, 1.0);
    if (t <= 0.0) {
      // пыль ждёт: кружит у земли
      P.xyz += curl(P.xyz*0.22 + uTime*0.05) * uDt * 1.6;
      P.y = abs(P.y)*0.4 + 0.05;
    } else {
      vec3 tgt = R.xyz;
      vec3 dir = tgt - P.xyz;
      float d = length(dir);
      float sp = mix(26.0, 4.0, t) * (0.6 + 0.8*idh);
      V.xyz = normalize(dir + 1e-4) * min(sp, d/max(uDt,1e-4))
            + curl(P.xyz*0.35 + uSeed) * (1.0-t) * 7.0;
      P.xyz += V.xyz * uDt;
      if (d < 0.05 || t >= 1.0) { P.xyz = tgt; V.xyz = vec3(0.0); phase = 0.0; heat = 0.0; }
    }
    oPos = vec4(P.xyz, phase); oVel = vec4(V.xyz, heat); return;
  }

  /* --- 0: заперт в монолите --- */
  if (phase < 0.5) {
    vec4 ck = texture(tCrack, M.xy);
    /* огонь = скорость реакции A·B² (фронт горения): кромка пылает, выгоревшее ядро гаснет */
    float rate = ck.r * ck.g * ck.g * 14.0;
    heat = max(heat*(1.0 - 0.5*uDt), min(1.0, rate));
    // дрожь от тепла
    float tr = heat*heat * 0.09 + uHeatK*0.012;
    P.xyz = R.xyz + (hash33(R.xyz + floor(uTime*31.0)) - 0.5) * tr;
    /* горячий фронт сыплет искрами и курится дымом */
    if (heat > 0.5) {
      float roll = hash13(R.xyz + floor(uTime*8.0));
      if (roll < 0.004) {
        phase = 2.0;
        vec3 h3 = hash33(R.xyz + uTime);
        V.xyz = vec3((h3.x-0.5)*2.4, 1.2 + h3.y*2.2, (h3.z-0.5)*2.4);
        oPos = vec4(P.xyz, phase); oVel = vec4(V.xyz, 1.0); return;
      }
      if (roll > 0.9965) {
        phase = 4.0; V.xyz = vec3(0.0, 0.7, 0.0);
        oPos = vec4(P.xyz, phase); oVel = vec4(V.xyz, 0.35); return;
      }
    }
    /* мой кластер сорвался (локальный нагрев/опора/акт) — лечу с ним */
    float cState = texelFetch(tCPos, ctc, 0).w;
    if (cState > 0.5) phase = 1.0;
    oPos = vec4(P.xyz, phase); oVel = vec4(0.0,0.0,0.0, heat); return;
  }

  /* --- 1: rigid-кластер --- */
  if (phase < 1.5) {
    vec4 cp = texelFetch(tCPos, ctc, 0);
    vec4 cq = texelFetch(tCQuat, ctc, 0);
    vec4 cs = texelFetch(tCStatic, ctc, 0);
    vec3 off = R.xyz - cs.xyz;
    vec3 np = cp.xyz + qrot(cq, off);
    V.xyz = (np - P.xyz) / max(uDt, 1e-4);
    P.xyz = np;
    float imp = texelFetch(tCVel, ctc, 0).w;
    if (imp > 3.2 && idh > 0.72) phase = 2.0;                // сильный удар выбивает крошку
    /* удар о пол поднимает столб пыли из нижних вокселей куска */
    if (imp > 2.0 && (R.y - cs.y) < 0.0 && hash13(P.xyz + uTime) < uDt*5.0) {
      vec3 h3 = hash33(P.xyz*2.3 + uTime);
      phase = 4.0;
      V.xyz = vec3((h3.x-0.5)*7.0, 0.6 + h3.y*1.8, (h3.z-0.5)*7.0);
      heat = 0.12;
      oPos = vec4(P.xyz, phase); oVel = vec4(V.xyz, heat); return;
    }
    if (uAct > 2.5) {                                        // догорание: горячие рассыпаются в пепел первыми
      float mp = clamp(uActT * (0.12 + 0.30*heat), 0.0, 1.0);
      if (idh < mp) { phase = 4.0; V.xyz = V.xyz*0.2 + vec3(0.0, 0.6, 0.0); heat = max(heat, 0.55); }
    }
    oPos = vec4(P.xyz, phase); oVel = vec4(V.xyz, heat); return;
  }

  /* --- 2: свободная крошка --- */
  if (phase < 2.5) {
    V.xyz += uGravity * uDt;
    P.xyz += V.xyz * uDt;
    if (P.y < 0.06) { P.y = 0.06; V.y = abs(V.y)*0.3; V.xz *= 0.8; }
    if (uAct > 2.5 && idh < clamp(uActT*0.22, 0.0, 1.0)) {
      phase = 4.0; heat = max(heat, 0.6); V.y = 0.8;
    }
    oPos = vec4(P.xyz, phase); oVel = vec4(V.xyz, heat); return;
  }

  /* --- 4: пепел (фаза 3 не используется — расплав выкинут) ---
     угли отрываются от пожарища, всплывают в тёплой тяге, гаснут по дороге */
  {
    float rise = mix(1.4, 3.2, heat);
    V.xyz = mix(V.xyz, vec3(0.0, rise, 0.0) + curl(P.xyz*0.35 + uTime*0.25) * (1.4 + 2.2*heat), 0.10);
    P.xyz += V.xyz * uDt;
    heat *= (1.0 - 0.16*uDt);                 // остывает, поднимаясь
    oPos = vec4(P.xyz, 4.0); oVel = vec4(V.xyz, heat);
  }
}
`;

/* ---------- поле трещин: Грей-Скотт ---------- */

export const FRAG_CRACK = /* glsl */`
in vec2 vUv;
out vec4 oC;
uniform sampler2D tPrev;
uniform vec2 uPx, uBrush;      // uPx = 1/размер, uBrush = UV точки нагрева
uniform float uBrushOn, uDt;
void main(){
  vec2 c = texture(tPrev, vUv).rg;
  vec2 l = vec2(0.0);
  l += texture(tPrev, vUv + vec2(uPx.x,0)).rg + texture(tPrev, vUv - vec2(uPx.x,0)).rg;
  l += texture(tPrev, vUv + vec2(0,uPx.y)).rg + texture(tPrev, vUv - vec2(0,uPx.y)).rg;
  l += 0.5*(texture(tPrev, vUv + uPx).rg + texture(tPrev, vUv - uPx).rg
       + texture(tPrev, vUv + vec2(uPx.x,-uPx.y)).rg + texture(tPrev, vUv - vec2(uPx.x,-uPx.y)).rg);
  l = l/6.0 - c;
  const float Da = 1.0, Db = 0.42, f = 0.0367, k = 0.0625;
  float abb = c.x * c.y * c.y;
  vec2 n = c + vec2(Da*l.x - abb + f*(1.0-c.x),
                    Db*l.y + abb - (k+f)*c.y) * 1.0;
  /* огонь ГАСНЕТ без подпитки: держит его только курсор, иначе реакция-диффузия
     сама расползается по всему фасаду и зритель не чувствует своей роли */
  n.y *= 0.9955;
  if (uBrushOn > 0.5) {
    float d = distance(vUv, uBrush);
    n.y += smoothstep(0.045, 0.0, d) * 0.9;      // жирная кисть: отклик виден сразу
    n.x -= smoothstep(0.02, 0.0, d) * 0.25;      // выжигаем топливо в самом очаге
  }
  oC = vec4(clamp(n, 0.0, 1.0), 0.0, 1.0);
}
`;

/* ---------- рендер: инстансированные кубы ---------- */

export const VERT_CUBES = CHUNK_HASH + CHUNK_QUAT + /* glsl */`
uniform sampler2D tPos, tVel, tRest, tMeta, tCQuat, tCStatic;
uniform float uSide, uVoxel, uTime;
out vec3 vN;
out vec3 vWp;
out float vHeat;
out float vAo;
out float vHash;
flat out float vPhase;

void main(){
  int id = gl_InstanceID;
  ivec2 tc = ivec2(id % int(uSide), id / int(uSide));
  vec4 P = texelFetch(tPos, tc, 0);
  vec4 V = texelFetch(tVel, tc, 0);
  vec4 R = texelFetch(tRest, tc, 0);
  vec4 M = texelFetch(tMeta, tc, 0);
  float phase = floor(P.w + 0.5);
  vPhase = phase;
  vHeat = V.w;
  vAo = M.z;
  vHash = hash13(R.xyz);

  vec4 q = vec4(0,0,0,1);
  if (phase > 0.5 && phase < 1.5) {
    int ci = int(R.w + 0.5);
    q = texelFetch(tCQuat, ivec2(ci % 32, ci / 32), 0);
  } else if (phase > 1.5 && phase < 2.5) {
    /* вращение от пройденного пути: летит — кувыркается, лёг — замер (не юла на месте) */
    vec3 ax = normalize(hash33(R.xyz) - 0.5 + 1e-3);
    float a = dot(P.xyz, hash33(R.xyz*3.7) * 2.0 - 1.0) * 2.6 + vHash * 6.28;
    q = vec4(ax * sin(a*0.5), cos(a*0.5));
  }
  float s = phase < 2.5 ? 1.0 : 0.0;                 // пепел кубами не рисуем
  if (phase > 5.5) s = 0.9;                          // полёт — чуть мельче
  /* РАСТВОРЕНИЕ: раскалённый бетон выгорает и съёживается — между кубами растут щели,
     кромка истончается в решето, и только потом воксель уходит пеплом */
  float burn = smoothstep(0.25, 1.0, V.w);
  s *= 1.0 - burn * (0.72 + 0.28 * hash13(R.xyz * 5.1));
  vec3 local = position * uVoxel * s;
  vec3 wp = P.xyz + qrot(q, local);
  vN = qrot(q, normal);
  vWp = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const FRAG_CUBES = CHUNK_HASH + /* glsl */`
in vec3 vN;
in vec3 vWp;
in float vHeat;
in float vAo;
in float vHash;
flat in float vPhase;
out vec4 oC;
uniform vec3 uCam;
uniform float uMaxY, uTime;
uniform vec4 uFire;   // xyz точка пожара, w сила 0..1
void main(){
  vec3 n = normalize(vN);
  vec3 V = normalize(uCam - vWp);
  // бетон: тёплый ключ + холодная подсветка + рим-контур + запечённый AO
  float l = 0.34
    + 0.85*max(dot(n, normalize(vec3(0.5, 0.85, 0.3))), 0.0)
    + 0.30*max(dot(n, normalize(vec3(-0.6, 0.2, -0.7))), 0.0);
  vec3 base = vec3(0.72, 0.71, 0.685) * (0.86 + 0.14*vHash);
  vec3 col = base * l * mix(0.55, 1.0, vAo);
  col *= mix(0.72, 1.05, clamp(vWp.y / max(uMaxY, 1.0), 0.0, 1.0)); // высотный AO: низ темнее, верх ловит свет
  col += vec3(0.45, 0.5, 0.6) * pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.22; // холодный рим
  /* живой свет пожара на соседних стенах: тёплый point-light с мерцанием */
  if (uFire.w > 0.01) {
    vec3 toF = uFire.xyz - vWp;
    float df = length(toF);
    float fl = uFire.w * (0.85 + 0.3*hash13(vec3(floor(uTime*17.0)))) / (1.0 + df*df*0.06);
    col += vec3(1.0, 0.38, 0.10) * fl * max(dot(n, toF/max(df,0.1)), 0.1) * 0.7;
  }
  /* раскал: обугленная корка, жар в щелях, пламя тянет вверх — не заливка кубика */
  float h = clamp(vHeat, 0.0, 1.0);
  if (h > 0.02) {
    col *= mix(1.0, 0.18, smoothstep(0.05, 0.45, h));              // бетон сначала чернеет
    float up = max(n.y, 0.0);                                       // верхние грани — пламя
    float side = 1.0 - abs(n.y);
    float flick = 0.55 + 0.75 * hash13(floor(vWp*6.0) + floor(uTime*26.0));
    float crust = smoothstep(0.35, 0.95, hash13(floor(vWp*9.0)));   // рваная кромка угля
    vec3 ember = mix(vec3(0.85, 0.13, 0.02), vec3(1.0, 0.52, 0.10), smoothstep(0.2, 0.7, h));
    ember = mix(ember, vec3(1.0, 0.88, 0.6), smoothstep(0.82, 1.0, h) * up);
    col += ember * h * (0.9 + 1.9*up + 0.5*side*crust) * flick;
  }
  // лёгкий туман к горизонту
  float fog = smoothstep(30.0, 95.0, length(vWp - uCam));
  col = mix(col, vec3(0.028, 0.027, 0.03), fog);
  oC = vec4(col, 1.0);
}
`;

/* ---------- рендер: точки (жидкость на сплат-буфер, газ/аккреция в сцену) ---------- */

export const VERT_POINTS = /* glsl */`
uniform sampler2D tPos, tVel;
uniform float uSide, uMode, uProj, uNoSplat, uSmoke;   // uSmoke: 1 = слой дымовых клубов
// uMode: 0 = газ+аккреция в сцену, 1 = жидкость в сплат
// uProj = высота_вьюпорта_px / (2·tan(fov/2)); uNoSplat = мобильный тир без метаболов
out float vKind;                    // 4 = пепел/дым
out float vHeat;
out float vSeed;                    // индивидуальная фаза клуба
out vec3 vVel;
out vec3 vWp;
void main(){
  int id = gl_VertexID;
  vSeed = fract(float(id) * 0.6180339887);
  ivec2 tc = ivec2(id % int(uSide), id / int(uSide));
  vec4 P = texelFetch(tPos, tc, 0);
  vec4 V = texelFetch(tVel, tc, 0);
  float phase = floor(P.w + 0.5);
  vKind = phase; vHeat = V.w; vVel = V.xyz; vWp = P.xyz;
  /* горячее — угли (аддитив), остывшее — дым (тёмные клубы отдельным слоем) */
  bool isAsh = phase > 3.5 && phase < 5.5;
  bool show = isAsh && (uSmoke > 0.5 ? V.w < 0.30 : V.w >= 0.30);
  vec4 mv = viewMatrix * vec4(P.xyz, 1.0);
  gl_Position = show ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  /* клуб расширяется, поднимаясь: молодой у земли плотный, старый наверху рыхлый */
  float ws = uSmoke > 0.5 ? (1.4 + clamp(P.y * 0.09, 0.0, 2.6)) : 0.5;
  gl_PointSize = clamp(ws * uProj / max(-mv.z, 1.0), 2.0, 220.0);
}
`;

export const FRAG_POINTS = CHUNK_HASH + CHUNK_NOISE + /* glsl */`
in float vKind;
in float vHeat;
in float vSeed;
in vec3 vVel;
in vec3 vWp;
out vec4 oC;
uniform float uMode, uSmoke, uTime;
uniform vec3 uCam;
uniform vec4 uFire;
void main(){
  vec2 d = gl_PointCoord*2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float a = exp(-r2*3.0);
  if (uSmoke > 0.5) {
    /* клуб дыма живёт: своя фаза вращения, кипящая изнутри кромка, дрейф шума */
    float seed = vSeed * 37.0;
    float ang = seed + uTime * (0.25 + 0.5 * fract(seed));
    vec2 rd = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * d;
    float puff = vnoise(vec3(rd * 2.2 + vec2(uTime * 0.35, -uTime * 0.22), seed + uTime * 0.4));
    float mask = smoothstep(1.0, 0.15, r2 + puff * 0.55);
    if (mask < 0.01) discard;
    float fade = smoothstep(34.0, 6.0, vWp.y);                 // высоко — рассеялся
    /* дым в темноте почти невидим — его лепит только свет пожара снизу */
    float lit = uFire.w / (1.0 + distance(vWp, uFire.xyz) * 0.16);
    vec3 col = mix(vec3(0.018, 0.017, 0.018), vec3(0.075, 0.07, 0.068), puff)
             + vec3(0.42, 0.17, 0.05) * lit * (0.35 + 0.5*puff);
    oC = vec4(col, mask * (0.10 + 0.16 * lit) * fade);
    return;
  }
  if (uMode > 0.5) { oC = vec4(a, 0.0, 0.0, 1.0); return; }   // (сплат жидкости — не используется)
  /* пепел: раскалённая крупинка гаснет в серый прах; горячие — ядро с ореолом */
  float h = clamp(vHeat, 0.0, 1.0);
  vec3 ash = vec3(0.075, 0.072, 0.07);
  vec3 hot = mix(vec3(0.9, 0.22, 0.03), vec3(1.0, 0.62, 0.18), smoothstep(0.45, 1.0, h));
  vec3 col = mix(ash, hot, smoothstep(0.12, 0.55, h));
  float core = smoothstep(0.55, 1.0, a) * h;                  // яркое ядро только у горячих
  oC = vec4(col * a * (0.5 + 2.6*h) + vec3(1.0, 0.75, 0.4) * core * 0.7, a * (0.10 + 0.35*h));
}
`;

/* ---------- пол ---------- */

export const VERT_FLOOR = /* glsl */`
out vec3 vWp;
void main(){
  vWp = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWp, 1.0);
}
`;

export const FRAG_FLOOR = CHUNK_HASH + /* glsl */`
in vec3 vWp;
out vec4 oC;
uniform vec3 uCam, uBMin, uBMax;
uniform float uPresence;   // 0..1 — стоит ли монолит (контактная тень)
uniform vec4 uFire;
uniform float uTime;
void main(){
  // бетонная плита: шум + радиальное затухание в ничто
  float n = hash13(floor(vWp*2.0)) * 0.05 + hash13(floor(vWp*0.5)+7.0) * 0.05;
  vec3 col = vec3(0.055, 0.054, 0.058) + n;
  /* тёплое пятно света от пожара */
  if (uFire.w > 0.01) {
    float df = length(vWp - uFire.xyz);
    col += vec3(1.0, 0.4, 0.11) * uFire.w * (0.8 + 0.35*hash13(vec3(floor(uTime*17.0)))) / (1.0 + df*df*0.045) * 0.5;
  }
  // мягкая контактная тень под AABB здания
  vec2 c = clamp(vWp.xz, uBMin.xz, uBMax.xz);
  float d = length(vWp.xz - c);
  col *= 1.0 - uPresence * smoothstep(6.0, 0.0, d) * 0.55;
  float fade = smoothstep(88.0, 26.0, length(vWp.xz - uCam.xz));
  col = mix(vec3(0.018, 0.018, 0.02), col, fade);
  oC = vec4(col, 1.0);
}
`;

/* ---------- пост ---------- */

export const FRAG_BRIGHT = /* glsl */`
in vec2 vUv;
out vec4 oC;
uniform sampler2D tScene;
void main(){
  vec3 c = texture(tScene, vUv).rgb;
  c = c / (1.0 + c * 0.5);            // soft-clip до порога: пики трещин не выжигают кашу
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  oC = vec4(c * smoothstep(0.42, 0.95, l), 1.0);
}
`;

export const FRAG_BLUR = /* glsl */`
in vec2 vUv;
out vec4 oC;
uniform sampler2D tSrc;
uniform vec2 uDir;   // (px,0) или (0,px)
void main(){
  vec3 s = texture(tSrc, vUv).rgb * 0.227027;
  vec2 o1 = uDir * 1.3846, o2 = uDir * 3.2308;
  s += (texture(tSrc, vUv+o1).rgb + texture(tSrc, vUv-o1).rgb) * 0.3162162;
  s += (texture(tSrc, vUv+o2).rgb + texture(tSrc, vUv-o2).rgb) * 0.0702703;
  oC = vec4(s, 1.0);
}
`;

export const FRAG_COMPOSITE = CHUNK_HASH + /* glsl */`
in vec2 vUv;
out vec4 oC;
uniform sampler2D tScene, tBloom, tSplat;
uniform vec2 uSplatPx;
uniform float uTime, uFlash, uShake, uVig, uLiquid;
void main(){
  vec2 uv = vUv;
  // хроматика при тряске
  float ca = uShake * 0.004;
  vec3 scene;
  scene.r = texture(tScene, uv + vec2(ca, 0.0)).r;
  scene.g = texture(tScene, uv).g;
  scene.b = texture(tScene, uv - vec2(ca, 0.0)).b;
  vec3 col = scene * 1.35 + texture(tBloom, uv).rgb * 0.95;

  // метабол-жидкость: порог по размытой плотности + градиентная «нормаль»
  if (uLiquid > 0.5) {
    float s = texture(tSplat, uv).r;
    if (s > 0.06) {
      float sx = texture(tSplat, uv + vec2(uSplatPx.x, 0.0)).r - texture(tSplat, uv - vec2(uSplatPx.x, 0.0)).r;
      float sy = texture(tSplat, uv + vec2(0.0, uSplatPx.y)).r - texture(tSplat, uv - vec2(0.0, uSplatPx.y)).r;
      float body = smoothstep(0.32, 0.55, s);
      float rim  = smoothstep(0.32, 0.42, s) - smoothstep(0.5, 0.8, s);
      vec3 nrm = normalize(vec3(-sx*6.0, -sy*6.0, 1.0));
      float spec = pow(max(nrm.z*0.5 + nrm.y*0.5, 0.0), 8.0);
      vec3 melt = vec3(0.05, 0.045, 0.05)                      // тёмное стекло
                + vec3(1.0, 0.32, 0.07) * rim * 1.0            // раскалённая кромка
                + vec3(1.0, 0.9, 0.75) * spec * 0.4;           // глянец
      col = mix(col, melt, body);
      col += vec3(1.0, 0.35, 0.08) * rim * 0.22;
    }
  }

  // виньетка, зерно, вспышка
  vec2 q = uv - 0.5;
  col *= 1.0 - dot(q, q) * uVig * 0.7;
  col += (hash13(vec3(uv*913.7, fract(uTime))) - 0.5) * 0.035;
  col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
  // тонмап
  col = col / (1.0 + col*0.35);
  oC = vec4(col, 1.0);
}
`;

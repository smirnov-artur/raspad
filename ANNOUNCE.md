# РАСПАД — тексты для сообществ (готово к копипасте)

Ссылка: https://smirnov-artur.github.io/raspad/ (EN: https://smirnov-artur.github.io/raspad/en/)

## 1. three.js forum (Showcase) / r/threejs / r/webgl — EN

DECAY — rigid-body debris simulated entirely in shaders (262k voxels, one HTML file)

https://smirnov-artur.github.io/raspad/

The rule I set for myself: no external files. No models, no textures, no audio files, no bundler, no build step. One HTML page, an import map, three.js r185. Everything below follows from that.

**Physics**

262,144 particles. All simulation state lives in ping-pong FBOs with MRT. GPUComputationRenderer doesn't do MRT, so there's a small compute layer of my own instead.

The rigid-body layer is in the shader too: ~800–1000 Voronoi clusters, one texel of state each — quaternion integration, floor contact against 8 precomputed extreme points per cluster, damping, sleeping. The particles are readers: each one looks up its cluster's transform and rides it. No CPU physics anywhere, no CPU→GPU traffic during a frame. There is exactly one readback in the whole program, and it's below.

**The collapse is caused, not scheduled**

Fire is a 512² Gray-Scott reaction-diffusion field that dies out unless the cursor keeps feeding it. Each chunk owns a zone in a 2×2 UV atlas of the facade, so the four sides heat independently. A chunk detaches when its own zone is hot enough, or when the support underneath it is already gone — the support graph is built when the structure is generated. Burn through a leg and the tower sits down on that side.

A hot voxel shrinks before it dies: the wall burns into a sieve first, then leaves as ash.

The switch into the collapse act is that one readback — it fires when more than half the clusters have actually detached, not when a timer expires.

**Structures**

Generated every cycle from three families: a lattice tower with hyperbola-curved legs and X-bracing, a cathedral with buttresses and a dome, a high-rise with floor slabs and a stiffness core. The interiors are real, so the collapse exposes floors instead of an empty shell. The first cycle assembles the word DECAY.

**Sound**

WebAudio synthesis, not one file: pentatonic pings as voxels snap into place during assembly, crackle, collapse rumble through a ConvolverNode with a procedurally generated impulse, a sub drone.

**Interaction**

Cursor burns concrete. Wheel or pinch is bullet time, 0.05–1×. Double click skips to the next act. Phone tilt moves the gravity vector. After 8 seconds without input a director autopilot takes over. Three quality tiers; it drops a tier on weak hardware rather than dropping frames.

Acts: DUST (assembly) → FIRE → COLLAPSE → ASH → AGAIN.

view-source is the entire program — nothing minified, nothing fetched at runtime. Happy to go into any of it: the MRT target layout, how the support graph is packed, why 8 contact points turned out to be enough, how the readback stays off the critical path, how clusters are assigned during voxelization.

— Artur Smirnov · GitHub smirnov-artur · TG @smirnovarturr

## 2. Телеграм-чаты вебщиков — RU

РАСПАД — https://smirnov-artur.github.io/raspad/

Открываешь вкладку: темнота и пыль. Через секунду 262 144 вокселя защёлкиваются по местам, каждый со своим пингом, и из пыли вырастает башня. В первый раз — словом РАСПАД.

Ведёшь курсором по бетону — под ним разгорается. Не «эффект огня»: очаг ползёт по фасаду сам, ест материал, уберёшь курсор — гаснет, кормить нечем. Раскалённый воксель сначала съёживается, стена выгорает в решето и только потом уходит пеплом.

Потом сыплется. Кусками и не по таймеру: отваливается тот блок, чью зону ты прогрел, или тот, под которым уже рухнула опора. Прожги ногу — башня сядет на эту сторону. Внутри настоящие перекрытия, ядро жёсткости, контрфорсы, и обрушение их вскрывает.

Колесо — bullet-time до 0.05×, видно, как обломок кувыркается и ложится. Двойной клик — следующий акт. Наклонишь телефон — гравитация поедет за наклоном. Не трогаешь 8 секунд — включается автопилот.

Под капотом: three.js r185, import map, один HTML. Ноль ассетов — ни моделей, ни текстур, ни звуковых файлов, звук целиком синтезится в WebAudio. Ноль билда. Вся физика на GPU: ping-pong FBO с MRT (свой мини-фреймворк, GPUComputationRenderer не умеет MRT), твёрдотельная динамика ~1000 Вороной-кластеров прямо в шейдере — кватернионы, контакт с полом по 8 предвычисленным точкам, демпфирование, засыпание. CPU за кадр только биндит текстуры и раздаёт дроуколы. Ридбек ровно один: акт обрушения включается, когда реально сорвалось больше половины кластеров.

Структура генерится каждый цикл — башня, собор, небоскрёб. 60 fps, три тира качества.

view-source — там всё, ничего не минифицировано. Спрашивайте по реализации, расскажу.

Артур Смирнов, GitHub smirnov-artur, TG @smirnovarturr

## 3. Show HN

Заголовок: Show HN: DECAY – a building that burns and collapses, one HTML file, no assets
Ссылка: https://smirnov-artur.github.io/raspad/

## 4. X / Twitter

EN: DECAY: a procedural building burns and collapses in your browser. 262k voxels, rigid-body physics for ~1000 Voronoi chunks entirely in shaders, zero CPU physics. No models, no textures, no audio, no build step — one HTML file. https://smirnov-artur.github.io/raspad/

RU: РАСПАД: процедурное здание горит и рушится прямо во вкладке. 262 144 вокселя, твёрдотельная физика ~1000 обломков целиком в шейдере, ноль CPU-физики. Ни моделей, ни текстур, ни звуков, ни сборки — один HTML. https://smirnov-artur.github.io/raspad/

## 5. Ответы на предсказуемые вопросы в комментариях

**Why WebGL2 and not WebGPU?**

The rule for the whole thing was one HTML file that opens anywhere, right now, including phones and Safari. WebGL2 with MRT covers everything the sim needs, so WebGPU would have bought me compute shaders I don't use and cut the audience. If the physics ever needs scatter or real atomics, that's the moment to port it.

**Rigid bodies without compute shaders and without atomics — how?**

Nothing scatters, so nothing needs atomics. Cluster mass, inertia and the 8 extreme points are precomputed at voxelization time and baked into a texture. At runtime each cluster is one texel: a fragment shader integrates its quaternion and velocity, resolves floor contact against its 8 points, damps and sleeps it. The 262k particles are pure readers — each looks up its cluster's transform and rides it. Gather only, one texel per body, no reductions in the loop.

**What does a frame actually cost?**

I don't have a per-pass ms table published, so take the shape rather than numbers: the expensive passes are tiny (the cluster state texture is a few hundred texels, Gray-Scott is 512²), the particle state passes are 512² too, and the real cost is rasterizing 262k particles. That's why the quality tiers scale particle count and not the physics. Target is 60fps; on weak GPUs it drops a tier rather than dropping frames.

**Where is the source?**

view-source on the page. It is a single HTML file, not minified, not bundled, no fetches at runtime — everything you see is in that document, including the shaders and the audio graph. GitHub: smirnov-artur.

**Does it run on mobile?**

Yes, on the lower quality tier, and tilt maps to the gravity vector, pinch to bullet time. Fill rate is the limit there, not the physics — the sim textures are the same size on every tier.

**Why voxels instead of a mesh with a fracture library?**

No-assets constraint. There is no mesh to fracture, because there is no mesh to load: the structure is generated as voxels each cycle, and the same representation serves both the assembly and the destruction. Voronoi clustering on top of the voxel grid gives the chunks, and the support graph is trivial to derive from the grid at generation time.

**You say zero CPU→GPU traffic, but there's a readback — isn't that a stall?**

There's exactly one, and it's not per-frame-critical: the fraction of detached clusters, used to decide when the collapse act starts. It's read from a tiny target on a slow cadence and the result is consumed a frame or two later, so nothing waits on it. Everything else — heat, contacts, sleeping, dissolution — never leaves the GPU.


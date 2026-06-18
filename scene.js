// Incense scene: Canvas rendering engine (value noise, curl flow, smoke particles, incense stick, ember, sparks)
// Only handles rendering; holds no timer/UI state; driven by a per-frame view snapshot passed in from the main app.
(function (global) {
  "use strict";

  // ---------- Value noise (smooth turbulence field) ----------
  const perm = new Uint8Array(512);
  (() => {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let seed = 1337;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  })();
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  function valueNoise(x, y) {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];
    const r = (h) => (h / 255) * 2 - 1;
    const x1 = lerp(r(aa), r(ba), u);
    const x2 = lerp(r(ab), r(bb), u);
    return lerp(x1, x2, v); // -1..1
  }

  // ---------- Canvas ----------
  let canvas = null, ctx = null;
  let W = 0, H = 0, DPR = 1, cx = 0, baseY = 0, maxStickLen = 0;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth || document.documentElement.clientWidth || 1024;
    H = window.innerHeight || document.documentElement.clientHeight || 768;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cx = W * 0.5;
    baseY = H * 0.80;                       // Top edge of the holder
    maxStickLen = Math.min(H * 0.46, 460);  // Visual length of the longest incense stick
  }

  // ---------- Smoothstep + curl-noise vortex field ----------
  const smoothstep = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  // Multi-octave noise potential field: domain warping + non-multiple time rates -> irregular vortices
  function fbmPotential(x, y, t) {
    // Low-frequency domain warp to knead the regular cells into irregular swirls
    const wx = valueNoise(x * 0.0034 + 19.2, y * 0.0034 - t * 0.037) * 48;
    const wy = valueNoise(x * 0.0034 - 7.8, y * 0.0034 - t * 0.061) * 48;
    const X = x + wx, Y = y + wy;
    let n = 0;
    n += valueNoise(X * 0.0026 + 2.0, Y * 0.0026 - t * 0.043) * 1.25; // Large-scale slow irregular drift
    n += valueNoise(X * 0.0072 + 11.5, Y * 0.0072 - t * 0.149) * 0.82;
    n += valueNoise(X * 0.0151 + 4.2, Y * 0.0151 - t * 0.251) * 0.40;
    n += valueNoise(X * 0.0313 + 23.7, Y * 0.0313 - t * 0.397) * 0.19;
    return n;
  }
  // Take the curl of the potential field -> divergence-free flow (the source of smoke curling)
  function curlField(x, y, t) {
    const e = 1.4;
    const dy = (fbmPotential(x, y + e, t) - fbmPotential(x, y - e, t));
    const dx = (fbmPotential(x + e, y, t) - fbmPotential(x - e, y, t));
    // Normalize to roughly ±1
    return { x: dy * 20, y: -dx * 20 };
  }

  // ---------- Soft smoke sprites (white / ink variants, pre-rendered offscreen) ----------
  function makePuff(stops) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d").createRadialGradient(32, 32, 0, 32, 32, 32);
    stops.forEach(([o, col]) => g.addColorStop(o, col));
    const cc = c.getContext("2d");
    cc.fillStyle = g;
    cc.fillRect(0, 0, 64, 64);
    return c;
  }
  const puffWhite = makePuff([
    [0, "rgba(255,255,255,0.95)"],
    [0.4, "rgba(244,248,255,0.45)"],
    [0.75, "rgba(232,240,255,0.12)"],
    [1, "rgba(232,240,255,0)"],
  ]);
  const puffInk = makePuff([
    [0, "rgba(64,66,74,0.95)"],
    [0.4, "rgba(72,74,82,0.42)"],
    [0.75, "rgba(86,88,96,0.12)"],
    [1, "rgba(86,88,96,0)"],
  ]);

  // ---------- Smoke particles (curl-noise thin wisps) ----------
  const particles = [];
  const MAX_P = 3200;
  const emitAccs = [];   // one fractional-emit accumulator per smoke source (index-keyed)

  function emitSmoke(idx, sx, sy, dt, rate) {
    let acc = (emitAccs[idx] || 0) + rate * dt;
    while (acc >= 1 && particles.length < MAX_P) {
      acc -= 1;
      const sxx = sx + (Math.random() - 0.5) * 1.0;
      const syy = sy + (Math.random() - 0.5) * 1.0;
      particles.push({
        x: sxx, y: syy,                          // Very narrow outlet -> thin smoke column
        px: sxx, py: syy,                        // Previous-frame position (motion blur)
        ax: sx, ay: sy,                          // Emission origin (per-particle axis): each source forms its own column
        vx: (Math.random() - 0.5) * 3,
        vy: -(46 + Math.random() * 16),         // Initial upward velocity (strong)
        life: 0,
        max: 6.5 + Math.random() * 4.5,
        size: 2.2 + Math.random() * 1.6,        // Start thin (slightly larger for continuity)
        seed: Math.random() * 6.28,
        wob: 0.7 + Math.random() * 0.6,         // Per-particle turbulence weight
        aJit: 0.7 + Math.random() * 0.5,        // Per-particle opacity variation
      });
    }
    // Don't let the accumulator balloon while at the particle cap, or it would dump all
    // freed slots into a single source once particles start dying.
    emitAccs[idx] = acc > 4 ? 4 : acc;
  }

  function updateSmoke(dt, t) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }

      const ageFrac = p.life / p.max;
      const heightAbove = Math.max(0, p.ay - p.y);

      // From straight to chaotic: laminar near the tip (thin and straight), turbulent after some distance
      const turb = smoothstep(H * 0.02, H * 0.22, heightAbove) * p.wob;

      // Curl-noise flow field -> curling and swirls
      const c = curlField(p.x, p.y, t);
      const hSwirl = 8 + 78 * turb;             // Horizontal sway (more pronounced higher up)
      const vSwirl = 5 + 17 * turb;             // Vertical jitter (small)
      // Rising is always the dominant force (not weakened by turbulence), so smoke keeps drifting off-screen
      const rise = 58 - 16 * ageFrac;           // Slightly decreases with age (cooling)

      let tvx = c.x * hSwirl;
      let tvy = -rise + c.y * vSwirl;

      // Near the source, pull particles back to their own emission axis -> each source forms a thin upright column
      tvx += (p.ax - p.x) * (1 - turb) * 3.0;

      // Inertial blending (semi-Lagrangian advection)
      const k = Math.min(1, dt * 5);
      p.vx += (tvx - p.vx) * k;
      p.vy += (tvy - p.vy) * k;

      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Slowly expand/diffuse with age (capped to keep the wisps thin)
      p.size = Math.min(20, p.size + (0.9 + 2.6 * turb) * dt);
    }
  }

  function drawSmoke(night) {
    const sprite = night ? puffWhite : puffInk;
    ctx.globalCompositeOperation = night ? "lighter" : "source-over";
    const baseA = night ? 0.03 : 0.015;
    for (const p of particles) {
      const ageFrac = p.life / p.max;
      const fadeIn = Math.min(1, p.life / 0.5);
      const fadeOut = Math.pow(1 - ageFrac, 1.4); // Slower fade-out -> smoke stays visible even higher up
      // The more it diffuses, the fainter it gets (bright where dense, thin where diffuse)
      let a = baseA * p.aJit * fadeIn * fadeOut / (1 + p.size * 0.06);
      if (a <= 0.002) continue;
      ctx.globalAlpha = a;

      // Stretch the particle along its motion direction (motion blur) -> connects into wisps, removing the grainy dotted look
      const dx = p.x - p.px, dy = p.y - p.py;
      const seg = Math.hypot(dx, dy);
      const ang = seg > 0.001 ? Math.atan2(dy, dx) : -Math.PI / 2;
      const w = p.size * 2;                 // Lateral width
      const len = w + seg * 2.4;            // Stretched along the motion direction (includes last-frame displacement)
      ctx.save();
      ctx.translate((p.x + p.px) * 0.5, (p.y + p.py) * 0.5);
      ctx.rotate(ang);
      ctx.drawImage(sprite, -len / 2, -w / 2, len, w);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------- Incense stick / ember / ash ----------
  const sparks = [];

  // Shared warm ember glow at a burning tip; returns the flicker value.
  function drawEmber(x, y, t, phase, scale) {
    const fl = 0.55 + 0.25 * (valueNoise(t * 2.0 + phase, 7.3) * 0.5 + 0.5) + 0.08 * Math.sin(t * 11 + phase);
    const glowR = (4.5 + 2.2 * fl) * scale;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const eg = ctx.createRadialGradient(x, y, 0, x, y, glowR);
    eg.addColorStop(0, `rgba(255,210,150,${0.7 * fl})`);
    eg.addColorStop(0.4, `rgba(240,120,46,${0.5 * fl})`);
    eg.addColorStop(1, "rgba(180,50,12,0)");
    ctx.fillStyle = eg;
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, Math.PI * 2);
    ctx.fill();
    // Glowing core (tiny)
    ctx.fillStyle = `rgba(255,196,140,${0.85 * fl})`;
    ctx.beginPath();
    ctx.arc(x, y, (0.9 + 0.5 * fl) * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return fl;
  }

  // Occasionally spit a tiny spark from a burning tip (not while paused)
  function maybeSpark(x, y, running) {
    if (running && Math.random() < 0.012) {
      sparks.push({
        x: x + (Math.random() - 0.5) * 1.4,
        y,
        vx: (Math.random() - 0.5) * 8,
        vy: -14 - Math.random() * 16,
        life: 0, max: 0.5 + Math.random() * 0.4,
      });
    }
  }

  // Fraction of a foot-bearing stick that is the dark-red bamboo 香腳 (never burned).
  const FOOT_FRAC = 0.26;

  // Paint one upright stick: a fixed dark-red 香腳 (bamboo foot) of height `footLen` rising from
  // the holder, then the burnable incense paste of height `pasteLen` on top of it. The ember/ash
  // sit at the paste tip, so the burn stops once it reaches the foot. `phase` offsets the
  // flicker/sway so several sticks animate independently.
  function paintStick(x, footLen, pasteLen, view, phase) {
    const night = view.theme === "night";
    const t = view.simT;
    const footTopY = baseY - footLen;          // where the paste begins
    const tipY = footTopY - pasteLen;          // burning tip
    const lw = view.thin ? 0.7 : 1.0;          // Line-width scale (thin = 線香)

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";

    // 香腳: dark-red dyed bamboo foot, not consumed by the burn
    if (footLen > 0) {
      ctx.strokeStyle = night ? "#7e2d24" : "#6e2620";
      ctx.lineWidth = 2.6 * lw;
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x, footTopY);
      ctx.stroke();
    }

    if (pasteLen >= 1) {
      // Bamboo core
      ctx.strokeStyle = night ? "#b6a585" : "#7c6a4d";
      ctx.lineWidth = 2.2 * lw;
      ctx.beginPath();
      ctx.moveTo(x, footTopY);
      ctx.lineTo(x, tipY);
      ctx.stroke();
      // Paste body
      ctx.strokeStyle = night ? "#8c5446" : "#5a3327";
      ctx.lineWidth = 3.0 * lw;
      ctx.beginPath();
      ctx.moveTo(x, footTopY);
      ctx.lineTo(x, tipY + 5);
      ctx.stroke();
    }

    if (view.lit && !view.finished && pasteLen >= 1) {
      // A short bit of white ash above the ember (thin, slightly swaying)
      const ashLen = (5 + Math.sin(t * 1.7 + phase) * 1.0) * (view.thin ? 0.8 : 1);
      ctx.strokeStyle = night ? "rgba(196,192,184,0.8)" : "rgba(120,114,104,0.8)";
      ctx.lineWidth = 2.6 * lw;
      ctx.beginPath();
      ctx.moveTo(x + Math.sin(t * 0.9 + phase) * 0.5, tipY);
      ctx.lineTo(x + Math.sin(t * 0.9 + phase) * 1.1, tipY - ashLen);
      ctx.stroke();
      drawEmber(x, tipY, t, phase, view.thin ? 0.85 : 1);
      maybeSpark(x, tipY, view.running);
    } else if (!view.lit && pasteLen >= 1) {
      // Unlit: a dark spot at the tip
      ctx.fillStyle = night ? "#d8d2c4" : "#3c2018";
      ctx.beginPath();
      ctx.arc(x, tipY, 1.8 * (view.thin ? 0.85 : 1), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Split a stick's full length into the fixed foot (香腳) and the burnable paste at `progress`.
  function stickParts(totalFull, progress, hasFoot) {
    const footLen = hasFoot ? totalFull * FOOT_FRAC : 0;
    const pasteLen = (totalFull - footLen) * progress;
    return { footLen, pasteLen, tipY: baseY - footLen - pasteLen };
  }

  function drawHolder(night) {
    // Holder: a shallow sand bowl
    const w = 150; // Fixed tray width, does not scale with screen width
    const h = 18;
    const y = baseY;
    ctx.save();
    // Bowl shadow: soft contact shadow. At night the background is near-black, so use a darker black to stay visible (the original warm brown is brighter than the night base -> effectively disappears)
    ctx.globalCompositeOperation = "source-over";
    const sy = y + h * 1.0;
    const rx = w * 0.62;
    const ry = h * 1.0;
    ctx.save();
    ctx.translate(cx, sy);
    ctx.scale(1, ry / rx);
    const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    if (night) {
      sg.addColorStop(0, "rgba(0,0,0,0.6)");
      sg.addColorStop(0.55, "rgba(0,0,0,0.34)");
      sg.addColorStop(1, "rgba(0,0,0,0)");
    } else {
      sg.addColorStop(0, "rgba(60,48,28,0.2)");
      sg.addColorStop(0.55, "rgba(60,48,28,0.1)");
      sg.addColorStop(1, "rgba(60,48,28,0)");
    }
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Bowl body
    const grad = ctx.createLinearGradient(cx - w/2, y, cx + w/2, y);
    grad.addColorStop(0, "#b9a988");
    grad.addColorStop(0.5, "#cdbd9b");
    grad.addColorStop(1, "#a99a7a");
    ctx.beginPath();
    ctx.moveTo(cx - w/2, y);
    ctx.quadraticCurveTo(cx, y + h * 1.7, cx + w/2, y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // Sand surface at the bowl mouth
    ctx.beginPath();
    ctx.ellipse(cx, y, w * 0.5, h * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#9c8c6b";
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, y - 1, w * 0.46, h * 0.34, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#b7a886";
    ctx.fill();
    ctx.restore();
  }

  // Each shape builder returns { sources, draw }:
  //   sources: ember points {x, y} where smoke is emitted
  //   draw():  paints the incense (called after smoke so it sits on top)
  // Geometry is computed up-front so the smoke sources match exactly what gets drawn.

  // 線香 (no foot) / 一炷香 (dark-red 香腳): a single upright stick, paste shortening with progress
  function stickGeo(view) {
    const totalFull = maxStickLen * view.lenScale;
    const hasFoot = !view.thin;                         // 線香 is a solid coreless stick -> no foot
    const { footLen, pasteLen, tipY } = stickParts(totalFull, view.progress, hasFoot);
    const drawn = pasteLen >= 1 || footLen > 0;
    return {
      sources: pasteLen >= 1 ? [{ x: cx, y: tipY }] : [],
      draw() { if (drawn) paintStick(cx, footLen, pasteLen, view, 0); },
    };
  }

  // 三炷香 uneven burn: each stick's length offset is the running integral of a smooth
  // per-stick rate noise along the burn path. Because it is a smooth integral (not bidirectional
  // random jumps that revert to the mean) every stick only ever shortens -> uneven yet jitter-free.
  // The integral is advanced in fixed substeps per unit of burn progress, so fast-forwarding with
  // `-` integrates the same number of noise samples as burning that same amount normally (never a
  // single-shot tweak). Extending with `+` just regrows along the base progress, keeping the spread.
  const TRIPLE_OFF = [0, 0, 0];
  const TRIPLE_SEED = [1.7, 13.3, 27.9];
  const TRIPLE_SEED2 = [5.1, 19.4, 31.2];
  const TRIPLE_SUB = 1 / 600;    // burn-progress per integration substep
  const TRIPLE_AMP = 0.45;       // rate deviation amplitude (instantaneous rate = 1 +/- AMP)
  const TRIPLE_FREQ = 2.2;       // number of rate undulations across a full burn
  const TRIPLE_MAX = 0.06;       // clamp on each stick's accumulated offset (progress units)
  let tripleLastConsumed = null;
  let tripleAcc = 0;
  let tripleBurnPos = 0;

  function stepTripleBurn(view) {
    const consumed = 1 - view.progress;
    if (tripleLastConsumed === null) tripleLastConsumed = consumed;
    const d = consumed - tripleLastConsumed;
    tripleLastConsumed = consumed;
    if (d <= 0) return;            // integrate only while burning forward; +/extend regrows via base progress
    tripleAcc += d;
    let n = 0;
    while (tripleAcc >= TRIPLE_SUB && n < 2000) {
      tripleAcc -= TRIPLE_SUB;
      n++;
      tripleBurnPos += TRIPLE_SUB;
      for (let i = 0; i < 3; i++) {
        // rate > 1 -> this stick burns faster this substep (offset goes more negative -> shorter)
        const rate = 1 + TRIPLE_AMP * valueNoise(tripleBurnPos * TRIPLE_FREQ + TRIPLE_SEED[i], TRIPLE_SEED2[i]);
        let v = TRIPLE_OFF[i] - (rate - 1) * TRIPLE_SUB;
        if (v > TRIPLE_MAX) v = TRIPLE_MAX;
        else if (v < -TRIPLE_MAX) v = -TRIPLE_MAX;
        TRIPLE_OFF[i] = v;
      }
    }
  }

  // 三炷香: three upright sticks (each with a dark-red 香腳), equal at first; the rate noise
  // makes them burn unevenly.
  function tripleGeo(view) {
    stepTripleBurn(view);
    const totalFull = maxStickLen * view.lenScale;
    const gap = Math.min(24, maxStickLen * 0.07);
    const xs = [cx - gap, cx, cx + gap];
    const phases = [0.0, 2.1, 4.2];
    // Let the offsets fade out very near the end so the three converge as they finish
    const gate = Math.min(1, view.progress / 0.05);
    const sticks = xs.map((x, i) => {
      const p = view.finished ? 0 : Math.max(0, Math.min(1, view.progress + TRIPLE_OFF[i] * gate));
      const parts = stickParts(totalFull, p, true);
      return { x, ph: phases[i], footLen: parts.footLen, pasteLen: parts.pasteLen, tipY: parts.tipY };
    });
    return {
      sources: sticks.filter((s) => s.pasteLen >= 1).map((s) => ({ x: s.x, y: s.tipY })),
      draw() {
        // Paint the outer two first so the middle ember layers on top
        [0, 2, 1].forEach((i) => {
          const s = sticks[i];
          paintStick(s.x, s.footLen, s.pasteLen, view, s.ph);
        });
      },
    };
  }

  // 香錐: a pointed, slightly bulging molded cone (per reference: ~3.5cm tall, taller than
  // it is wide). The base stays fixed; it only burns down from the apex, leaving an
  // ever-wider flat top.
  function coneGeo(view) {
    const night = view.theme === "night";
    const fullH = maxStickLen * view.lenScale;       // lenScale already encodes the cone's real height ratio
    const baseHalf = fullH * 0.33;                   // base diameter ~0.66 of height -> stout pointed cone
    const uTop = view.progress;                      // burning surface, normalized height (1 = full, 0 = spent)
    const topY = baseY - fullH * uTop;
    // Half-width along the height; exponent < 1 gives the gently convex (bulging) molded-cone profile
    const halfAt = (u) => baseHalf * Math.pow(Math.max(0, 1 - u), 0.78);
    const topW = 2 * halfAt(uTop);
    return {
      sources: [{ x: cx, y: topY }],
      draw() {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        const grad = ctx.createLinearGradient(cx - baseHalf, 0, cx + baseHalf, 0);
        if (night) {
          grad.addColorStop(0, "#623a2f");
          grad.addColorStop(0.5, "#8c5446");
          grad.addColorStop(1, "#532f24");
        } else {
          grad.addColorStop(0, "#46281e");
          grad.addColorStop(0.5, "#6a3d2c");
          grad.addColorStop(1, "#3c2117");
        }
        // Trace the curved silhouette: up the left edge, across the flat burning top, down the right edge
        const N = 18;
        ctx.beginPath();
        ctx.moveTo(cx - baseHalf, baseY);
        for (let i = 1; i <= N; i++) {
          const u = uTop * (i / N);
          ctx.lineTo(cx - halfAt(u), baseY - fullH * u);
        }
        for (let i = N; i >= 0; i--) {
          const u = uTop * (i / N);
          ctx.lineTo(cx + halfAt(u), baseY - fullH * u);
        }
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        if (view.lit && !view.finished) {
          // Glowing ash across the flat burning top
          if (topW > 1.5) {
            ctx.strokeStyle = night ? "rgba(170,80,30,0.55)" : "rgba(150,60,20,0.5)";
            ctx.lineWidth = 2.2;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(cx - topW / 2, topY);
            ctx.lineTo(cx + topW / 2, topY);
            ctx.stroke();
          }
          drawEmber(cx, topY, view.simT, 0, 1.0);
          maybeSpark(cx, topY, view.running);
        } else if (!view.lit) {
          ctx.fillStyle = night ? "#d8d2c4" : "#3c2018";
          ctx.beginPath();
          ctx.arc(cx, topY, 2.0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      },
    };
  }

  // 盤香: a flat Archimedean spiral; the ember travels from the outer tip inward
  function coilGeo(view) {
    const night = view.theme === "night";
    // lenScale = overall coil diameter relative to a full 立香; halve to get the radius (clamp to fit the width)
    const rMax = Math.min(maxStickLen * view.lenScale * 0.5, W * 0.42);
    const rMin = rMax * 0.16;
    const flat = 0.5;                       // Vertical squash -> reads as lying flat
    const cy = baseY - rMax * flat - 8;     // Sit just above the holder
    const thetaMax = 3.6 * Math.PI * 2;     // ~3.6 turns
    const pt = (theta) => {
      const r = rMin + (rMax - rMin) * (theta / thetaMax);
      return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) * flat };
    };
    const emberTheta = thetaMax * view.progress; // outer (full) -> inner (spent)
    const ember = pt(emberTheta);
    const traceFrom = (startTheta) => {
      ctx.beginPath();
      let first = true;
      for (let th = startTheta; th >= -1e-6; th -= 0.12) {
        const q = pt(th);
        if (first) { ctx.moveTo(q.x, q.y); first = false; } else ctx.lineTo(q.x, q.y);
      }
    };
    return {
      sources: view.progress > 0 ? [{ x: ember.x, y: ember.y }] : [],
      draw() {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // Burned (outer) arc: from the outer tip down to the ember -> ash colour
        if (view.lit && emberTheta < thetaMax) {
          ctx.strokeStyle = night ? "rgba(150,146,138,0.45)" : "rgba(120,114,104,0.4)";
          ctx.lineWidth = 3.2;
          ctx.beginPath();
          let first = true;
          for (let th = thetaMax; th >= emberTheta - 1e-6; th -= 0.12) {
            const q = pt(th);
            if (first) { ctx.moveTo(q.x, q.y); first = false; } else ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
        }

        // Remaining (inner) arc: from the ember inward to the centre (unlit = whole coil)
        const startTheta = view.lit ? emberTheta : thetaMax;
        ctx.strokeStyle = night ? "#8c5446" : "#5a3327";
        ctx.lineWidth = 3.6;
        traceFrom(startTheta);
        ctx.stroke();
        // Thin bamboo-ish highlight along the remaining coil
        ctx.strokeStyle = night ? "rgba(182,165,133,0.5)" : "rgba(124,106,77,0.5)";
        ctx.lineWidth = 1.2;
        traceFrom(startTheta);
        ctx.stroke();

        // Center hub
        const hub = pt(0);
        ctx.fillStyle = night ? "#6b5e44" : "#8c7c5a";
        ctx.beginPath();
        ctx.arc(hub.x, hub.y, 3, 0, Math.PI * 2);
        ctx.fill();

        if (view.lit && !view.finished && view.progress > 0) {
          drawEmber(ember.x, ember.y, view.simT, 0, 1.0);
          maybeSpark(ember.x, ember.y, view.running);
        } else if (!view.lit) {
          const tip = pt(thetaMax);
          ctx.fillStyle = night ? "#d8d2c4" : "#3c2018";
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, 2.0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      },
    };
  }

  function buildGeometry(view) {
    switch (view.shape) {
      case "triple": return tripleGeo(view);
      case "cone":   return coneGeo(view);
      case "coil":   return coilGeo(view);
      default:       return stickGeo(view);
    }
  }

  function updateSparks(dt) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life += dt;
      if (s.life >= s.max) { sparks.splice(i, 1); continue; }
      s.vy += -8 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const a = (1 - s.life / s.max);
      ctx.fillStyle = `rgba(255,${160 + 60 * a | 0},80,${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.1 * a + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------- Public interface ----------
  function init(cv) {
    canvas = cv;
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
  }

  // Clear smoke and sparks (called when switching incense / relighting)
  function reset() {
    particles.length = 0;
    sparks.length = 0;
    emitAccs.length = 0;
    TRIPLE_OFF[0] = TRIPLE_OFF[1] = TRIPLE_OFF[2] = 0;
    tripleLastConsumed = null;
    tripleAcc = 0;
    tripleBurnPos = 0;
  }

  // Draw per frame. view = {
  //   dt, sdt, simT,            // Real dt (smoke emission) / sim dt (0 when frozen) / sim clock
  //   theme,                    // "paper" / "night"
  //   shape, thin,              // Incense shape ("stick"/"triple"/"cone"/"coil") + thin flag (線香)
  //   lenScale, progress,       // Max-size scale (per preset) + remaining fraction (0..1)
  //   lit, finished, running,   // Incense state
  //   emitting,                 // Whether to emit smoke
  // }
  function render(view) {
    ctx.clearRect(0, 0, W, H);
    drawHolder(view.theme === "night");

    const geo = buildGeometry(view);
    if (view.emitting && geo.sources.length) {
      const base = 300 + 50 * Math.sin(view.simT * 0.6); // Subtle breathing in smoke volume
      // Split the budget evenly across sources (each with its own accumulator) so the total
      // stays under the particle cap and every column emits fairly.
      const per = base / geo.sources.length;
      geo.sources.forEach((s, i) => emitSmoke(i, s.x, s.y - 1, view.dt, per));
    }

    updateSmoke(view.sdt, view.simT);   // sdt=0 when frozen, smoke particles stay put
    drawSmoke(view.theme === "night");
    geo.draw();                         // Incense on top of smoke; ember flicker uses simT
    updateSparks(view.sdt);
  }

  global.IncenseScene = { init, resize, reset, render };
})(window);

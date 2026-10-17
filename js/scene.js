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

  // ---------- Shared helpers for incense rendering ----------
  // Deterministic PRNG (mulberry32) so cracks / ash fragments stay put from frame to frame.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fine grain texture (pressed powder / ash) used as a pattern fill inside clipped silhouettes.
  let grainTex = null;
  function grainPattern() {
    if (!grainTex) {
      const c = document.createElement("canvas");
      c.width = c.height = 48;
      const g = c.getContext("2d");
      const R = rng(4242);
      for (let i = 0; i < 340; i++) {
        const light = R() < 0.45;
        g.fillStyle = light ? `rgba(255,240,220,${0.10 + R() * 0.18})` : `rgba(20,10,4,${0.12 + R() * 0.22})`;
        const s = 0.5 + R() * 0.9;
        g.fillRect(R() * 48, R() * 48, s, s);
      }
      grainTex = ctx.createPattern(c, "repeat");
    }
    return grainTex;
  }

  // Ember flicker value shared by burn fronts (same formula as drawEmber).
  const flicker = (t, phase) =>
    0.55 + 0.25 * (valueNoise(t * 2.0 + phase, 7.3) * 0.5 + 0.5) + 0.08 * Math.sin(t * 11 + phase);

  // Palettes. Paste = unburned incense body, ash = burned residue, foot = dyed red bamboo stick.
  function palette(night) {
    return night ? {
      pasteDark: "#3e231b", paste: "#8c5446", pasteLit: "#a86a58", pasteHi: "rgba(214,168,140,0.45)",
      footDark: "#45130e", foot: "#7e2d24", footLit: "#a33f34", footHi: "rgba(225,130,115,0.4)",
      coreDark: "#6d5f46", core: "#b6a585", coreLit: "#cfc1a4",
      ashDark: "#6c6862", ash: "#a19c94", ashLit: "#c2bdb4", ashHi: "rgba(236,232,224,0.55)",
      ashLine: "rgba(40,36,32,0.45)", shadow: "rgba(0,0,0,0.45)", metal: ["#5d564a", "#a49a85", "#4a443a"],
    } : {
      pasteDark: "#2a160f", paste: "#5a3327", pasteLit: "#7a4a37", pasteHi: "rgba(176,124,96,0.5)",
      footDark: "#3a100c", foot: "#6e2620", footLit: "#8f372f", footHi: "rgba(196,104,90,0.45)",
      coreDark: "#4d402c", core: "#7c6a4d", coreLit: "#998565",
      ashDark: "#878177", ash: "#aca69b", ashLit: "#cdc8bd", ashHi: "rgba(246,243,236,0.6)",
      ashLine: "rgba(70,62,54,0.45)", shadow: "rgba(60,44,24,0.32)", metal: ["#6c6252", "#b9ad94", "#544c3f"],
    };
  }

  // Horizontal "cylindrical" shading: light comes from the upper left (the window).
  function roundShade(x0, x1, dark, mid, lit) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, dark);
    g.addColorStop(0.3, lit);
    g.addColorStop(0.55, mid);
    g.addColorStop(1, dark);
    return g;
  }

  // Fraction of a foot-bearing stick that is the dark-red bamboo 香腳 (never burned).
  const FOOT_FRAC = 0.26;

  // Deterministic break-point schedule along a stick's burnable paste length (measured from the top).
  function stickBreaks(fullPasteLen, seed, thin) {
    const R = rng(seed);
    const scale = thin ? 0.72 : 1.0;
    const out = [0];
    let d = 0;
    while (d < fullPasteLen) {
      d += (19 + R() * 24) * scale;
      out.push(Math.min(d, fullPasteLen));
    }
    return out;
  }

  // Paint fallen ash segments and fine powder around a stick's base on the sand surface.
  function drawStickFallenAsh(x, fullPasteLen, consumedLen, P, seed, thin) {
    if (consumedLen <= 0.5) return;
    const breaks = stickBreaks(fullPasteLen, seed, thin);
    const lw = thin ? 0.72 : 1.0;
    const sw = 3.2 * lw;
    const sandRx = 62, sandRy = 5.4, sandY = baseY - 0.8;

    ctx.save();
    for (let i = 1; i < breaks.length; i++) {
      if (breaks[i] > consumedLen) break;
      const R = rng(seed * 31 + i * 17);
      const segLen = breaks[i] - breaks[i - 1];
      // When a tall ash segment drops from above, it breaks into 2-3 shorter pieces on impact
      const pieces = segLen > 26 * lw && R() < 0.65 ? 3 : 2;
      for (let j = 0; j < pieces; j++) {
        const spread = (4 + R() * 22) * (R() < 0.5 ? -1 : 1) + (R() - 0.5) * 6;
        const fx = Math.max(cx - sandRx + 4, Math.min(cx + sandRx - 4, x + spread));
        const maxRy = sandRy * Math.sqrt(Math.max(0, 1 - ((fx - cx) / sandRx) ** 2));
        const fy = sandY + (R() * 2 - 0.7) * maxRy * 0.78;
        const L = Math.min((segLen / pieces) * 0.45, 7.5 * lw) * (0.45 + 0.55 * R());
        const ang = (R() - 0.5) * 0.65;
        const bend = (R() - 0.5) * 1.6;
        const w = sw * (0.48 + 0.24 * R());
        const path = () => {
          ctx.beginPath();
          ctx.moveTo(fx - Math.cos(ang) * L / 2, fy - Math.sin(ang) * L / 2);
          ctx.quadraticCurveTo(fx, fy + bend, fx + Math.cos(ang) * L / 2, fy + Math.sin(ang) * L / 2);
        };
        ctx.lineCap = "butt";
        ctx.strokeStyle = P.ashLine;
        ctx.lineWidth = w + 0.7;
        ctx.save(); ctx.translate(0, 0.45); path(); ctx.stroke(); ctx.restore();
        ctx.strokeStyle = R() < 0.5 ? P.ash : P.ashLit;
        ctx.lineWidth = w;
        path();
        ctx.stroke();
      }
      // Fine ash dust around the fallen pieces
      ctx.fillStyle = P.ash;
      for (let j = 0; j < 4; j++) {
        const dx = Math.max(cx - sandRx + 3, Math.min(cx + sandRx - 3, x + (R() - 0.5) * 44));
        const dy = sandY + (R() - 0.45) * sandRy * 1.3;
        ctx.fillRect(dx, dy, 0.6 + R() * 0.8, 0.5 + R() * 0.4);
      }
    }
    ctx.restore();
  }

  // Paint one upright stick:
  // - Contact depression + shadow where the stick enters the sand
  // - Fixed dark-red 香腳 (dyed bamboo foot) of height `footLen` with cylindrical shading
  // - Unburned incense paste of height `pasteLen` with cylindrical shading, powder grain,
  //   a tiny exposed bamboo core tip at the top, and a charred band under the ember
  // - Overhanging curved ash column above the ember that grows until it reaches the next break
  //   point and drops into the bowl (when finished, a tiny remnant ash cap stays on the collar)
  function paintStick(x, footLen, pasteLen, fullPasteLen, view, phase, seed) {
    const night = view.theme === "night";
    const P = palette(night);
    const t = view.simT;
    const footTopY = baseY - footLen;          // where the paste begins
    const tipY = footTopY - pasteLen;          // current burning front
    const lw = view.thin ? 0.72 : 1.0;         // width scale (thin = 線香)
    const footW = 2.4 * lw;
    const pasteW = 3.5 * lw;
    const consumedLen = Math.max(0, fullPasteLen - pasteLen);

    ctx.save();
    ctx.globalCompositeOperation = "source-over";

    // 1. Small sand dimple / contact shadow at the insertion point
    ctx.fillStyle = P.shadow;
    ctx.beginPath();
    ctx.ellipse(x + 0.8, baseY + 0.3, footW * 1.6, 1.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = night ? "rgba(18,14,10,0.65)" : "rgba(78,62,40,0.45)";
    ctx.beginPath();
    ctx.ellipse(x, baseY, footW * 0.85, 0.85, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. 香腳: dark-red dyed bamboo foot (unburned)
    if (footLen > 0) {
      const r = footW * 0.5;
      ctx.fillStyle = roundShade(x - r, x + r, P.footDark, P.foot, P.footLit);
      ctx.fillRect(x - r, footTopY, footW, footLen);
      // Specular rim highlight on the lit (left) side
      ctx.strokeStyle = P.footHi;
      ctx.lineWidth = 0.55;
      ctx.beginPath();
      ctx.moveTo(x - r + 0.35, baseY);
      ctx.lineTo(x - r + 0.35, footTopY);
      ctx.stroke();
      // Subtle ambient darkening right where the foot meets the sand
      const ao = ctx.createLinearGradient(0, baseY - 10, 0, baseY);
      ao.addColorStop(0, "rgba(0,0,0,0)");
      ao.addColorStop(1, "rgba(0,0,0,0.32)");
      ctx.fillStyle = ao;
      ctx.fillRect(x - r, baseY - 10, footW, 10);
    }

    // 3. Unburned incense paste body (wider than the bamboo foot -> distinct shoulder)
    if (pasteLen >= 0.8) {
      const r = pasteW * 0.5;
      const bodyTopY = view.lit ? tipY : tipY + (footLen > 0 ? 2.2 : 0.6);

      // Paste cylinder with rounded bottom shoulder and top cap
      ctx.beginPath();
      ctx.moveTo(x - r, bodyTopY);
      ctx.lineTo(x - r, footTopY);
      ctx.arc(x, footTopY, r, Math.PI, 0, true);
      ctx.lineTo(x + r, bodyTopY);
      ctx.arc(x, bodyTopY, r, 0, Math.PI, false);
      ctx.closePath();

      ctx.fillStyle = roundShade(x - r, x + r, P.pasteDark, P.paste, P.pasteLit);
      ctx.fill();

      // Pressed-powder grain + charred band inside the paste silhouette
      ctx.save();
      ctx.clip();
      ctx.fillStyle = grainPattern();
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x - r - 1, bodyTopY - 2, pasteW + 2, pasteLen + 6);
      ctx.globalAlpha = 1;

      // Subtle shadow at the bottom shoulder of the paste
      const sho = ctx.createLinearGradient(0, footTopY - 4, 0, footTopY + r);
      sho.addColorStop(0, "rgba(0,0,0,0)");
      sho.addColorStop(1, "rgba(0,0,0,0.28)");
      ctx.fillStyle = sho;
      ctx.fillRect(x - r - 1, footTopY - 4, pasteW + 2, 5 + r);

      // Charred black-brown collar just below the burning ember
      if (view.lit) {
        const charH = Math.min(pasteLen, 5.5 * lw);
        const cg = ctx.createLinearGradient(0, tipY, 0, tipY + charH);
        cg.addColorStop(0, "rgba(12,5,2,0.88)");
        cg.addColorStop(0.55, "rgba(24,10,4,0.45)");
        cg.addColorStop(1, "rgba(24,10,4,0)");
        ctx.fillStyle = cg;
        ctx.fillRect(x - r - 1, tipY - 1, pasteW + 2, charH + 1);
      }
      ctx.restore();

      // Left-edge highlight on the paste cylinder
      ctx.strokeStyle = P.pasteHi;
      ctx.lineWidth = 0.65;
      ctx.beginPath();
      ctx.moveTo(x - r + 0.45, footTopY);
      ctx.lineTo(x - r + 0.45, bodyTopY + (view.lit ? 3.5 : 0.5));
      ctx.stroke();

      // Unlit top tip: exposed bamboo core nib (on footed sticks) or rounded powder tip
      if (!view.lit) {
        if (footLen > 0) {
          const cr = footW * 0.44;
          ctx.fillStyle = roundShade(x - cr, x + cr, P.coreDark, P.core, P.coreLit);
          ctx.beginPath();
          ctx.moveTo(x - cr, bodyTopY + 0.8);
          ctx.lineTo(x - cr, tipY);
          ctx.arc(x, tipY, cr, Math.PI, 0, false);
          ctx.lineTo(x + cr, bodyTopY + 0.8);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = P.pasteLit;
          ctx.beginPath();
          ctx.arc(x, bodyTopY, r * 0.85, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 4. Burning tip: glowing ember + overhanging curved ash column
    if (view.lit && !view.finished && pasteLen >= 0.8) {
      // Determine how much ash currently clings above the ember before the next break-off
      const breaks = stickBreaks(fullPasteLen, seed, view.thin);
      let lastBreak = 0;
      for (const b of breaks) if (b <= consumedLen) lastBreak = b;
      const rawHold = consumedLen - lastBreak;
      // Visually scale down the vertical length slightly so the clinging ash reads as a realistic
      // 0.5-2cm curling cap rather than an overly tall rod, while still growing & snapping off cleanly
      const ashLen = Math.min(22 * lw, rawHold * 0.68);

      const R = rng(seed * 13 + Math.round(lastBreak * 10));
      const curlDir = R() < 0.5 ? -1 : 1;
      const maxBend = curlDir * (0.4 + Math.pow(ashLen / (16 * lw), 1.65) * 3.8 * lw);
      const sway = Math.sin(t * 1.1 + phase) * 0.35 * (ashLen / (14 * lw));

      if (ashLen > 0.8) {
        const ashW = pasteW * 0.88;
        const nSeg = Math.max(3, Math.ceil(ashLen / 3));
        const pts = [];
        for (let i = 0; i <= nSeg; i++) {
          const u = i / nSeg;
          const bend = (maxBend + sway) * (u * u);
          const wig = valueNoise(seed + u * 2.4, lastBreak * 0.1) * 0.45 * u;
          pts.push({ x: x + bend + wig, y: tipY - ashLen * u });
        }
        const traceAsh = (dx) => {
          ctx.beginPath();
          pts.forEach((p, i) => (i ? ctx.lineTo(p.x + dx, p.y) : ctx.moveTo(p.x + dx, p.y)));
        };

        // Dark shadow edge on the right side of the ash column
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = P.ashDark;
        ctx.lineWidth = ashW;
        traceAsh(0.35);
        ctx.stroke();

        // Main pale ash body
        ctx.strokeStyle = P.ash;
        ctx.lineWidth = ashW * 0.9;
        traceAsh(0);
        ctx.stroke();

        // Left-side lit highlight on the ash
        ctx.strokeStyle = P.ashLit;
        ctx.lineWidth = ashW * 0.38;
        traceAsh(-ashW * 0.22);
        ctx.stroke();

        // Fine horizontal crack rings along the clinging ash column
        ctx.strokeStyle = P.ashLine;
        ctx.lineWidth = 0.55;
        ctx.lineCap = "butt";
        for (let d = 3.8 * lw; d < ashLen - 1.5; d += 4.2 * lw) {
          const u = d / ashLen;
          const cxAsh = x + (maxBend + sway) * u * u;
          const cyAsh = tipY - d;
          ctx.beginPath();
          ctx.moveTo(cxAsh - ashW * 0.46, cyAsh + 0.2);
          ctx.lineTo(cxAsh + ashW * 0.42, cyAsh - 0.2);
          ctx.stroke();
        }
      }

      // Incandescent ember core right at the paste/ash boundary + soft glow
      const fl = drawEmber(x, tipY + 0.5, t, phase, view.thin ? 0.85 : 1.05);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(255,${130 + 60 * fl | 0},50,${0.65 + 0.3 * fl})`;
      ctx.beginPath();
      ctx.ellipse(x, tipY + 0.6, pasteW * 0.52, 1.3 * lw, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      maybeSpark(x, tipY, view.running);
    } else if (view.lit && view.finished && footLen > 0) {
      // Burnt out down to the 香腳: a tiny charred collar and a pinch of grey ash at the top of the foot
      const r = footW * 0.55;
      ctx.fillStyle = "rgba(22,12,8,0.75)";
      ctx.fillRect(x - footW * 0.5, footTopY, footW, 2.2);
      ctx.fillStyle = P.ash;
      ctx.beginPath();
      ctx.ellipse(x, footTopY, r, 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Split a stick's full length into the fixed foot (香腳) and the burnable paste at `progress`.
  function stickParts(totalFull, progress, hasFoot) {
    const footLen = hasFoot ? totalFull * FOOT_FRAC : 0;
    const fullPasteLen = totalFull - footLen;
    const pasteLen = fullPasteLen * progress;
    return { footLen, pasteLen, fullPasteLen, tipY: baseY - footLen - pasteLen };
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
    const { footLen, pasteLen, fullPasteLen, tipY } = stickParts(totalFull, view.progress, hasFoot);
    const drawn = pasteLen >= 0.8 || footLen > 0;
    const seed = view.thin ? 109 : 211;
    return {
      sources: pasteLen >= 0.8 ? [{ x: cx, y: tipY }] : [],
      draw() {
        if (view.lit) {
          const P = palette(view.theme === "night");
          drawStickFallenAsh(cx, fullPasteLen, fullPasteLen - pasteLen, P, seed, view.thin);
        }
        if (drawn) paintStick(cx, footLen, pasteLen, fullPasteLen, view, 0, seed);
      },
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
    const seeds = [307, 613, 919];
    const sticks = xs.map((x, i) => {
      const p = view.finished ? 0 : Math.max(0, Math.min(1, view.progress + TRIPLE_OFF[i] * gate));
      const parts = stickParts(totalFull, p, true);
      return { x, ph: phases[i], seed: seeds[i], footLen: parts.footLen, pasteLen: parts.pasteLen, fullPasteLen: parts.fullPasteLen, tipY: parts.tipY };
    });
    return {
      sources: sticks.filter((s) => s.pasteLen >= 0.8).map((s) => ({ x: s.x, y: s.tipY })),
      draw() {
        if (view.lit) {
          const P = palette(view.theme === "night");
          sticks.forEach((s) => drawStickFallenAsh(s.x, s.fullPasteLen, s.fullPasteLen - s.pasteLen, P, s.seed, false));
        }
        // Paint the outer two first so the middle ember layers on top
        [0, 2, 1].forEach((i) => {
          const s = sticks[i];
          paintStick(s.x, s.footLen, s.pasteLen, s.fullPasteLen, view, s.ph, s.seed);
        });
      },
    };
  }

  // 香錐: a pointed, slightly bulging molded cone (per reference: ~3.5cm tall, taller than
  // it is wide). The base stays fixed; it burns down from the apex. Like a real cone, the
  // ash does not fall away: it keeps the cone shape as a pale, slightly shrunken, cracked
  // shell sitting on a thin glowing ring (the burn front). A spent cone is a full ash cone.
  function coneGeo(view) {
    const night = view.theme === "night";
    const P = palette(night);
    const fullH = maxStickLen * view.lenScale;       // lenScale already encodes the cone's real height ratio
    const baseHalf = fullH * 0.33;                   // base diameter ~0.66 of height -> stout pointed cone
    const EL = 0.16;                                 // vertical squash of horizontal cross-sections (view from slightly above)
    // Half-width along the height; exponent < 1 gives the gently convex (bulging) molded-cone profile
    const halfAt = (u) => baseHalf * Math.pow(Math.max(0, 1 - u), 0.78);
    const yAt = (u) => baseY - fullH * u;
    // Constant-mass burn: the front moves fast near the slim tip and slows as the cone widens
    // (remaining volume of a cone frustum ~ 1 - (1 - u)^3).
    const uF = 1 - Math.cbrt(Math.max(0, 1 - view.progress));
    const yF = yAt(uF), hF = halfAt(uF);
    const burned = view.lit && uF < 0.999;
    // Ash shell: same profile, a touch narrower above the front and slumped a little at the tip
    const slump = 0.06 * Math.min(1, (1 - uF) / 0.35);
    const ashPt = (t, side) => {
      const u = uF + (1 - uF) * t;
      const shrink = 1 - 0.07 * smoothstep(0, 0.25, t);
      return { x: cx + side * halfAt(u) * shrink, y: yAt(uF + (1 - uF) * (1 - slump) * t) };
    };
    const apex = ashPt(1, 0);
    const smokeAt = burned ? { x: cx, y: Math.min(yF, apex.y + 1) } : { x: cx, y: yF };

    // Silhouette of the unburned paste: base ellipse up to the burn-front ellipse (front half visible)
    function pastePath() {
      const N = 16;
      ctx.beginPath();
      ctx.moveTo(cx - baseHalf, baseY);
      for (let i = 1; i <= N; i++) { const u = uF * (i / N); ctx.lineTo(cx - halfAt(u), yAt(u)); }
      if (hF > 0.3) ctx.ellipse(cx, yF, hF, hF * EL, 0, Math.PI, 0, true);
      for (let i = N; i >= 0; i--) { const u = uF * (i / N); ctx.lineTo(cx + halfAt(u), yAt(u)); }
      ctx.ellipse(cx, baseY, baseHalf, baseHalf * EL, 0, 0, Math.PI, false);
      ctx.closePath();
    }
    function ashPath() {
      const N = 16;
      ctx.beginPath();
      ctx.moveTo(cx - hF, yF);
      for (let i = 1; i <= N; i++) { const p = ashPt(i / N, -1); ctx.lineTo(p.x, p.y); }
      for (let i = N; i >= 0; i--) { const p = ashPt(i / N, 1); ctx.lineTo(p.x, p.y); }
      if (hF > 0.3) ctx.ellipse(cx, yF, hF, hF * EL, 0, 0, Math.PI, false);
      ctx.closePath();
    }

    return {
      sources: view.progress > 0 ? [smokeAt] : [],
      draw() {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        // Soft contact shadow on the sand
        ctx.save();
        ctx.translate(cx + 2, baseY + 1);
        ctx.scale(1, 0.22);
        const cs = ctx.createRadialGradient(0, 0, 0, 0, 0, baseHalf * 1.5);
        cs.addColorStop(0, P.shadow);
        cs.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = cs;
        ctx.beginPath();
        ctx.arc(0, 0, baseHalf * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // A few ash crumbs that have flaked off onto the sand (more as the burn goes on)
        if (burned) {
          const R = rng(77);
          const n = Math.floor((1 - uF) * 9);
          ctx.fillStyle = P.ash;
          for (let i = 0; i < n; i++) {
            const a = R() * Math.PI, d = baseHalf * (1.05 + R() * 0.5);
            ctx.beginPath();
            ctx.ellipse(cx + Math.cos(a) * d * (R() < 0.5 ? -1 : 1), baseY + Math.sin(a) * d * EL * 1.2,
              0.6 + R() * 0.8, 0.4 + R() * 0.4, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Unburned paste body
        if (uF > 0.002) {
          pastePath();
          ctx.fillStyle = roundShade(cx - baseHalf, cx + baseHalf, P.pasteDark, P.paste, P.pasteLit);
          ctx.fill();
          ctx.save();
          ctx.clip();
          ctx.fillStyle = grainPattern();
          ctx.globalAlpha = 0.55;
          ctx.fillRect(cx - baseHalf - 2, yF - 6, baseHalf * 2 + 4, baseY - yF + 12);
          ctx.globalAlpha = 1;
          // Ambient occlusion toward the base
          const ao = ctx.createLinearGradient(0, baseY - fullH * 0.25, 0, baseY + baseHalf * EL);
          ao.addColorStop(0, "rgba(0,0,0,0)");
          ao.addColorStop(1, "rgba(0,0,0,0.28)");
          ctx.fillStyle = ao;
          ctx.fillRect(cx - baseHalf - 2, baseY - fullH * 0.25, baseHalf * 2 + 4, fullH * 0.25 + 6);
          // Charred band just under the burn front
          if (burned) {
            ctx.strokeStyle = "rgba(18,8,4,0.55)";
            ctx.lineWidth = 3.2;
            ctx.beginPath();
            ctx.ellipse(cx, yF + 1.4, hF + 1, (hF + 1) * EL, 0, 0, Math.PI, false);
            ctx.stroke();
          }
          ctx.restore();
          // Thin rim highlight on the lit (left) edge
          ctx.strokeStyle = P.pasteHi;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          for (let i = 0; i <= 12; i++) {
            const u = uF * (i / 12);
            const x = cx - halfAt(u) + 0.9, y = yAt(u);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          }
          ctx.stroke();
        }

        // Ash shell standing on the front
        if (burned) {
          ashPath();
          ctx.fillStyle = roundShade(cx - hF, cx + hF, P.ashDark, P.ash, P.ashLit);
          ctx.fill();
          ctx.save();
          ctx.clip();
          ctx.fillStyle = grainPattern();
          ctx.globalAlpha = 0.35;
          ctx.fillRect(cx - hF - 2, apex.y - 2, hF * 2 + 4, yF - apex.y + 8);
          ctx.globalAlpha = 1;
          // Cracks: a few jagged, partial rings at fixed heights (so they don't crawl as the
          // front moves) plus short wandering fissures. Kept faint: ash cracks are hairlines.
          ctx.strokeStyle = P.ashLine;
          ctx.lineWidth = 0.5;
          ctx.globalAlpha = 0.7;
          const R = rng(913);
          [0.24, 0.45, 0.66].forEach((uc) => {
            const a0 = 0.3 + R() * 0.6, a1 = a0 + 0.8 + R() * 1.0;
            const seed = R() * 10;
            if (uc < uF + 0.05) return;
            const t = (uc - uF) / (1 - uF);
            const p = ashPt(t, 1), hw = p.x - cx;
            ctx.beginPath();
            const n = 10, end = Math.min(Math.PI - 0.2, a1);
            for (let i = 0; i <= n; i++) {
              const a = a0 + (end - a0) * (i / n);
              const x = cx + Math.cos(a) * hw, y = p.y + Math.sin(a) * hw * EL + valueNoise(seed + i * 0.9, 3.1) * 1.4;
              i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            }
            ctx.stroke();
          });
          for (let i = 0; i < 3; i++) {
            const u0 = 0.12 + R() * 0.6, len = 0.08 + R() * 0.1, sx = (R() - 0.5) * 1.2, seed = R() * 10;
            if (u0 < uF + 0.04) continue;
            ctx.beginPath();
            for (let j = 0; j <= 5; j++) {
              const u = Math.min(0.97, u0 + len * (j / 5));
              const p = ashPt((u - uF) / (1 - uF), sx);
              const x = p.x + valueNoise(seed + j * 1.3, 8.7) * 1.2;
              const y = p.y + halfAt(u) * EL * Math.sqrt(Math.max(0, 1 - sx * sx));
              j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            }
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          ctx.restore();
          ctx.strokeStyle = P.ashHi;
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          for (let i = 0; i <= 12; i++) {
            const p = ashPt(i / 12, -1);
            i ? ctx.lineTo(p.x + 0.8, p.y) : ctx.moveTo(p.x + 0.8, p.y);
          }
          ctx.stroke();
        }

        // Glowing burn front: a thin incandescent ring between ash and paste
        if (burned && !view.finished) {
          const fl = flicker(view.simT, 0);
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          const gr = Math.max(hF, 2) + 5;
          ctx.translate(cx, yF);
          ctx.scale(1, 0.45);
          const eg = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
          eg.addColorStop(0, `rgba(255,170,90,${0.38 * fl})`);
          eg.addColorStop(0.6, `rgba(230,96,30,${0.2 * fl})`);
          eg.addColorStop(1, "rgba(180,50,12,0)");
          ctx.fillStyle = eg;
          ctx.beginPath();
          ctx.arc(0, 0, gr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.lineCap = "round";
          ctx.strokeStyle = `rgba(255,${120 + 60 * fl | 0},50,${0.55 + 0.35 * fl})`;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          if (hF > 0.6) ctx.ellipse(cx, yF + 0.2, hF, hF * EL, 0, 0.12, Math.PI - 0.12, false);
          else ctx.arc(cx, yF, 1, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          maybeSpark(cx + (Math.random() - 0.5) * hF * 1.6, yF, view.running);
        }
        ctx.restore();
      },
    };
  }

  // 盤香: a flat Archimedean spiral hung on a brass pin stand (盤香架) above the sand bowl.
  // The ember travels from the outer tip inward at a constant speed along the strand. The ash
  // behind it stays attached for a short, drooping length, then breaks off and drops onto the
  // sand, where the fallen pieces pile up. The centre tab stays on the pin when it is spent.
  function coilGeo(view) {
    const night = view.theme === "night";
    const P = palette(night);
    // lenScale = overall coil diameter relative to a full 立香; halve to get the radius (clamp to fit the width)
    const rMax = Math.min(maxStickLen * view.lenScale * 0.5, W * 0.42);
    const k = rMax / 84;                    // detail scale relative to the reference size
    const rMin = rMax * 0.15;
    const flat = 0.38;                      // Vertical squash -> reads as lying flat
    const thetaMax = 3.6 * Math.PI * 2;     // ~3.6 turns
    const droop = rMax * 0.06;              // outer turns sag a little under their own weight
    const cy = baseY - rMax * flat - droop - 10;
    const sw = Math.max(2.6, 3.4 * k);      // strand thickness
    const pt = (th, dy) => {
      const r = rMin + (rMax - rMin) * (th / thetaMax);
      const q = r / rMax;
      return { x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) * flat + droop * q * q + (dy || 0), r };
    };
    // Arc length s(θ) from the centre, and its inverse -> constant linear burn speed
    const qa = (rMax - rMin) / (2 * thetaMax);
    const sOf = (th) => rMin * th + qa * th * th;
    const thOf = (s) => (-rMin + Math.sqrt(rMin * rMin + 4 * qa * Math.max(0, s))) / (2 * qa);
    const S = sOf(thetaMax);
    const sE = S * view.progress;           // unburned length left
    const thE = thOf(sE);
    const dE = S - sE;                      // burned length, measured from the outer tip
    const ember = pt(thE);

    // Fixed break points along the strand (burned length); ash between breaks falls as one piece
    const breaks = [0];
    {
      const R = rng(1016);
      let d = 0;
      while (d < S) { d += (18 + R() * 26) * k; breaks.push(Math.min(d, S)); }
    }
    let dK = 0;
    for (const b of breaks) if (b <= dE) dK = b;

    const trace = (th0, th1, dyFn) => {
      const n = Math.max(1, Math.ceil(Math.abs(th0 - th1) / 0.06));
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const th = th0 + (th1 - th0) * (i / n);
        const p = pt(th, dyFn ? dyFn(th) : 0);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
    };
    // Rounded strand: dark underside, body, specular top edge
    function tube(path, w, dark, body, hi, dash) {
      ctx.save();
      ctx.translate(0, 0.6);
      ctx.strokeStyle = dark;
      ctx.lineWidth = w + 0.9;
      path();
      ctx.stroke();
      ctx.restore();
      if (dash) { ctx.setLineDash(dash); ctx.lineCap = "butt"; }
      ctx.strokeStyle = body;
      ctx.lineWidth = w;
      path();
      ctx.stroke();
      ctx.save();
      ctx.translate(0, -w * 0.24);
      ctx.strokeStyle = hi;
      ctx.lineWidth = w * 0.3;
      path();
      ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
      ctx.lineCap = "round";
    }

    // Fallen ash fragments resting on the sand surface
    function drawFallen() {
      const sandRx = 64, sandRy = 5.6, sandY = baseY - 1;
      for (let i = 1; i < breaks.length; i++) {
        if (breaks[i] > dE) break;
        const R = rng(500 + i);
        const segLen = breaks[i] - breaks[i - 1];
        const mid = pt(thOf(S - (breaks[i - 1] + breaks[i]) / 2));
        const pieces = segLen > 26 * k && R() < 0.6 ? 3 : 2;
        for (let j = 0; j < pieces; j++) {
          let x = cx + (mid.x - cx) * 0.8 + (R() - 0.5) * 12 * k;
          x = Math.max(cx - sandRx + 4, Math.min(cx + sandRx - 4, x));
          const ry = sandRy * Math.sqrt(Math.max(0, 1 - ((x - cx) / sandRx) ** 2));
          const y = sandY + (R() * 2 - 1) * ry * 0.75;
          // Fallen ash is brittle: it shatters into short, matte, uneven flakes
          const L = Math.min(segLen / pieces * 0.4, 5.5 * k) * (0.35 + 0.65 * R());
          const ang = (R() - 0.5) * 0.7, bend = (R() - 0.5) * 1.6;
          const w = sw * (0.42 + 0.22 * R());
          const path = () => {
            ctx.beginPath();
            ctx.moveTo(x - Math.cos(ang) * L / 2, y - Math.sin(ang) * L / 2);
            ctx.quadraticCurveTo(x, y + bend, x + Math.cos(ang) * L / 2, y + Math.sin(ang) * L / 2);
          };
          ctx.lineCap = "butt";
          ctx.strokeStyle = P.ashLine;
          ctx.lineWidth = w + 0.7;
          ctx.save(); ctx.translate(0, 0.4); path(); ctx.stroke(); ctx.restore();
          ctx.strokeStyle = R() < 0.5 ? P.ash : P.ashLit;
          ctx.lineWidth = w;
          path();
          ctx.stroke();
          ctx.lineCap = "round";
        }
        // a pinch of dust
        ctx.fillStyle = P.ash;
        for (let j = 0; j < 4; j++) {
          const x = Math.max(cx - sandRx + 3, Math.min(cx + sandRx - 3, cx + (mid.x - cx) * 0.8 + (R() - 0.5) * 18 * k));
          ctx.fillRect(x, sandY + (R() - 0.5) * sandRy * 1.4, 0.6 + R() * 0.8, 0.6);
        }
      }
    }

    return {
      sources: view.lit && view.progress > 0 ? [{ x: ember.x, y: ember.y - 1 }] : [],
      draw() {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        if (view.lit) drawFallen();

        // Brass pin stand: a small foot in the sand and a needle up through the coil's centre hole
        const tabL = cx - rMin * 0.7, tabR = cx + rMin;
        ctx.fillStyle = P.shadow;
        ctx.beginPath();
        ctx.ellipse(cx, baseY, 7, 2.2, 0, 0, Math.PI * 2);
        ctx.fill();
        const mg = ctx.createLinearGradient(cx - 1.2, 0, cx + 1.2, 0);
        mg.addColorStop(0, P.metal[0]);
        mg.addColorStop(0.4, P.metal[1]);
        mg.addColorStop(1, P.metal[2]);
        ctx.fillStyle = mg;
        ctx.fillRect(cx - 1, cy, 2, baseY - cy - 1);
        ctx.beginPath();
        ctx.ellipse(cx, baseY - 1, 4.5, 1.4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Remaining (unburned) coil: from the ember inward to the centre (unlit = whole coil)
        const startTheta = view.lit ? thE : thetaMax;
        if (startTheta > 0.02) {
          tube(() => trace(startTheta, 0), sw, P.pasteDark, P.paste, P.pasteHi);
          // subtle grain along the strand
          ctx.save();
          ctx.globalAlpha = 0.45;
          ctx.strokeStyle = grainPattern();
          ctx.lineWidth = sw;
          trace(startTheta, 0);
          ctx.stroke();
          ctx.restore();
        }
        // Centre tab (never burned) with the pin poking through its hole
        tube(() => { ctx.beginPath(); ctx.moveTo(tabL, cy); ctx.lineTo(tabR, cy); }, sw * 1.5, P.pasteDark, P.paste, P.pasteHi);
        ctx.fillStyle = "rgba(10,5,2,0.8)";
        ctx.beginPath();
        ctx.ellipse(cx, cy, 1.5, 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = mg;
        ctx.fillRect(cx - 0.8, cy - 3.5, 1.6, 3.5);

        if (view.lit && dE > 0.5) {
          // Charred stretch just ahead of the ember
          const thC = thOf(Math.max(0, sE - 5 * k));
          ctx.strokeStyle = "rgba(16,8,4,0.6)";
          ctx.lineWidth = sw * 0.9;
          trace(thE, thC);
          ctx.stroke();

          // Attached ash: from the last break point to the ember, drooping as it gets longer
          if (dE - dK > 0.5) {
            const thA = thOf(S - dK);
            const sag = (th) => { const d = sOf(th) - sE; return 0.0045 * d * d / k; };
            tube(() => trace(thA, thE, sag), sw * 0.92, P.ashLine, P.ash, P.ashHi, [6 * k, 0.6]);
          }
        }

        if (view.lit && !view.finished && view.progress > 0) {
          // Incandescent section at the ember
          const fl = flicker(view.simT, 0);
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.strokeStyle = `rgba(255,${110 + 70 * fl | 0},40,${0.55 + 0.35 * fl})`;
          ctx.lineWidth = sw * 0.75;
          trace(thOf(Math.min(S, sE + 2.2 * k)), thOf(Math.max(0, sE - 1.2 * k)));
          ctx.stroke();
          ctx.restore();
          drawEmber(ember.x, ember.y, view.simT, 0, 0.9);
          maybeSpark(ember.x, ember.y, view.running);
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

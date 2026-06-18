// 線香場景:Canvas 繪圖引擎(值噪聲、curl 旋流、香煙粒子、香枝、餘燼、火星)
// 僅負責繪圖,不持有計時/UI 狀態;由主程式每幀傳入視圖快照來驅動。
(function (global) {
  "use strict";

  // ---------- 值噪聲(平滑湍流場) ----------
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

  // ---------- 畫布 ----------
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
    baseY = H * 0.80;                       // 香插上緣
    maxStickLen = Math.min(H * 0.46, 460);  // 最長一炷香的視覺長度
  }

  // ---------- 平滑插值 + curl 噪聲旋流場 ----------
  const smoothstep = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  // 多層噪聲位能場:網域扭曲 + 互不成倍數的時間速率 → 不規律旋流
  function fbmPotential(x, y, t) {
    // 低頻網域扭曲,把規律胞格揉成不規則漩渦
    const wx = valueNoise(x * 0.0034 + 19.2, y * 0.0034 - t * 0.037) * 48;
    const wy = valueNoise(x * 0.0034 - 7.8, y * 0.0034 - t * 0.061) * 48;
    const X = x + wx, Y = y + wy;
    let n = 0;
    n += valueNoise(X * 0.0026 + 2.0, Y * 0.0026 - t * 0.043) * 1.25; // 大尺度慢速不規律漂移
    n += valueNoise(X * 0.0072 + 11.5, Y * 0.0072 - t * 0.149) * 0.82;
    n += valueNoise(X * 0.0151 + 4.2, Y * 0.0151 - t * 0.251) * 0.40;
    n += valueNoise(X * 0.0313 + 23.7, Y * 0.0313 - t * 0.397) * 0.19;
    return n;
  }
  // 取位能場的旋度 → 無散度旋流(煙的捲曲來源)
  function curlField(x, y, t) {
    const e = 1.4;
    const dy = (fbmPotential(x, y + e, t) - fbmPotential(x, y - e, t));
    const dx = (fbmPotential(x + e, y, t) - fbmPotential(x - e, y, t));
    // 正規化到約 ±1
    return { x: dy * 20, y: -dx * 20 };
  }

  // ---------- 柔煙貼圖(白 / 墨 兩款,離屏預繪) ----------
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

  // ---------- 香煙粒子(curl-noise 細煙絲) ----------
  const particles = [];
  const MAX_P = 3200;
  let emitAcc = 0;

  function emitSmoke(sx, sy, dt, rate) {
    emitAcc += rate * dt;
    while (emitAcc >= 1 && particles.length < MAX_P) {
      emitAcc -= 1;
      const sxx = sx + (Math.random() - 0.5) * 1.0;
      const syy = sy + (Math.random() - 0.5) * 1.0;
      particles.push({
        x: sxx, y: syy,                          // 極窄出口 → 細煙柱
        px: sxx, py: syy,                        // 前一幀位置(動態模糊)
        vx: (Math.random() - 0.5) * 3,
        vy: -(46 + Math.random() * 16),         // 初速向上(強)
        life: 0,
        max: 6.5 + Math.random() * 4.5,
        size: 2.2 + Math.random() * 1.6,        // 起始細(略加大以連續)
        seed: Math.random() * 6.28,
        wob: 0.7 + Math.random() * 0.6,         // 個體擾動權重
        aJit: 0.7 + Math.random() * 0.5,        // 透明度個體差
      });
    }
  }

  function updateSmoke(dt, t, sourceY) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }

      const ageFrac = p.life / p.max;
      const heightAbove = Math.max(0, sourceY - p.y);

      // 由直轉亂:近香頭層流(細直),約一段距離後轉湍流
      const turb = smoothstep(H * 0.02, H * 0.22, heightAbove) * p.wob;

      // 旋流場(curl noise) → 捲曲與漩渦
      const c = curlField(p.x, p.y, t);
      const hSwirl = 8 + 78 * turb;             // 水平擺幅(高處翻騰更明顯)
      const vSwirl = 5 + 17 * turb;             // 垂直擾動(小)
      // 上升始終為主力(不隨湍流減弱),煙才會持續往上飄出畫面
      const rise = 58 - 16 * ageFrac;           // 隨年齡略減(冷卻)

      let tvx = c.x * hSwirl;
      let tvy = -rise + c.y * vSwirl;

      // 近香頭把粒子拉回中軸 → 形成纖細直立煙柱
      tvx += (cx - p.x) * (1 - turb) * 3.0;

      // 慣性混合(半拉格朗日平流)
      const k = Math.min(1, dt * 5);
      p.vx += (tvx - p.vx) * k;
      p.vy += (tvy - p.vy) * k;

      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // 隨年齡緩慢膨脹擴散(限制上限,保留細絲)
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
      const fadeOut = Math.pow(1 - ageFrac, 1.4); // 較緩淡出 → 煙飄得更高仍可見
      // 愈擴散愈淡(細密處亮、瀰漫處薄)
      let a = baseA * p.aJit * fadeIn * fadeOut / (1 + p.size * 0.06);
      if (a <= 0.002) continue;
      ctx.globalAlpha = a;

      // 順著移動方向把煙粒拉長(動態模糊)→ 連成煙絲,消除一顆顆的顆粒感
      const dx = p.x - p.px, dy = p.y - p.py;
      const seg = Math.hypot(dx, dy);
      const ang = seg > 0.001 ? Math.atan2(dy, dx) : -Math.PI / 2;
      const w = p.size * 2;                 // 橫向寬度
      const len = w + seg * 2.4;            // 沿運動方向拉長(含上一幀位移)
      ctx.save();
      ctx.translate((p.x + p.px) * 0.5, (p.y + p.py) * 0.5);
      ctx.rotate(ang);
      ctx.drawImage(sprite, -len / 2, -w / 2, len, w);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------- 香枝 / 餘燼 / 灰 ----------
  let flick = 0;
  const sparks = [];

  function currentStick(lenScale, frac) {
    const full = maxStickLen * lenScale;
    const len = full * frac;
    return { full, len, tipY: baseY - len };
  }

  function drawHolder(night) {
    // 香插:一只低淺的沙缽
    const w = 150; // 托盤固定寬度,不隨螢幕寬度縮放
    const h = 18;
    const y = baseY;
    ctx.save();
    // 缽影:柔邊接地影。夜間背景偏黑,須改用黑色加深才看得見(原暖褐比夜底更亮 → 等於消失)
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
    // 缽身
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
    // 缽口沙面
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

  function drawIncense(t, view) {
    const { len, tipY } = currentStick(view.lenScale, view.frac);
    if (len < 1) return;

    const night = view.theme === "night";
    const topX = cx;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";

    // 香枝本體(下半竹芯、上半藥體;深色主題提亮以保留可見度)
    ctx.lineCap = "round";
    ctx.strokeStyle = night ? "#b6a585" : "#7c6a4d"; // 竹芯
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(topX, baseY);
    ctx.lineTo(topX, tipY);
    ctx.stroke();
    ctx.strokeStyle = night ? "#8c5446" : "#5a3327"; // 藥體
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.moveTo(topX, baseY - 2);
    ctx.lineTo(topX, tipY + 5);
    ctx.stroke();

    if (view.lit && !view.finished) {
      // 餘燼上方一小段白灰(細、微擺)
      const ashLen = 5 + Math.sin(t * 1.7) * 1.0;
      ctx.strokeStyle = night ? "rgba(196,192,184,0.8)" : "rgba(120,114,104,0.8)";
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(topX + Math.sin(t * 0.9) * 0.5, tipY);
      ctx.lineTo(topX + Math.sin(t * 0.9) * 1.1, tipY - ashLen);
      ctx.stroke();

      // 餘燼:只是一點暖紅小光(火光大幅縮小)
      flick = 0.55 + 0.25 * (valueNoise(t * 2.0, 7.3) * 0.5 + 0.5) + 0.08 * Math.sin(t * 11);
      const emberY = tipY;
      const glowR = 4.5 + 2.2 * flick;
      ctx.globalCompositeOperation = "lighter";
      const eg = ctx.createRadialGradient(topX, emberY, 0, topX, emberY, glowR);
      eg.addColorStop(0, `rgba(255,210,150,${0.7 * flick})`);
      eg.addColorStop(0.4, `rgba(240,120,46,${0.5 * flick})`);
      eg.addColorStop(1, "rgba(180,50,12,0)");
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.arc(topX, emberY, glowR, 0, Math.PI * 2);
      ctx.fill();
      // 熾核(極小)
      ctx.fillStyle = `rgba(255,196,140,${0.85 * flick})`;
      ctx.beginPath();
      ctx.arc(topX, emberY, 0.9 + 0.5 * flick, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";

      // 偶發極小火星(稀少,暫停時不產生)
      if (view.running && Math.random() < 0.012) {
        sparks.push({
          x: topX + (Math.random() - 0.5) * 1.4,
          y: emberY,
          vx: (Math.random() - 0.5) * 8,
          vy: -14 - Math.random() * 16,
          life: 0, max: 0.5 + Math.random() * 0.4,
        });
      }
    } else if (!view.lit) {
      // 未點:香頭一抹深色
      ctx.fillStyle = night ? "#d8d2c4" : "#3c2018";
      ctx.beginPath();
      ctx.arc(topX, tipY, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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

  // ---------- 對外介面 ----------
  function init(cv) {
    canvas = cv;
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
  }

  // 清空煙與火星(換香 / 重燃時呼叫)
  function reset() {
    particles.length = 0;
    sparks.length = 0;
  }

  // 每幀繪製。view = {
  //   dt, sdt, simT,            // 真實 dt(生煙量)/ 模擬 dt(凍結時為 0)/ 模擬時鐘
  //   theme, lenScale, frac,    // 主題、香長比例、剩餘比例(0..1)
  //   lit, finished, running,   // 香的狀態
  //   emitting,                 // 是否生煙
  // }
  function render(view) {
    ctx.clearRect(0, 0, W, H);
    drawHolder(view.theme === "night");

    const { tipY } = currentStick(view.lenScale, view.frac);
    if (view.emitting) {
      const rate = 300 + 50 * Math.sin(view.simT * 0.6); // 煙量微呼吸(高密度連續)
      emitSmoke(cx, tipY - 1, view.dt, rate);
    }

    updateSmoke(view.sdt, view.simT, tipY);  // 凍結時 sdt=0,煙粒停在原地
    drawSmoke(view.theme === "night");
    drawIncense(view.simT, view);            // 餘燼閃爍用 simT,暫停時定格
    updateSparks(view.sdt);
  }

  global.IncenseScene = { init, resize, reset, render };
})(window);

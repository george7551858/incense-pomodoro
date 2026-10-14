// 一炷香 · 蕃茄鐘 — app logic: timer state, persistence, UI wiring, console debug API,
// and Service Worker registration. Rendering is delegated to IncenseScene (js/scene.js).
(() => {
  "use strict";

  // ---------- State ----------
  // lenScale = the incense's overall size relative to a full 立香 (one/三炷香 = 1.0),
  // matching the reference chart proportions: 立香 20cm / 線香 14cm / 盤香 10cm / 香錐 3.5cm.
  const PRESETS = [
    { id: "thread", label: "線香",   min: 15, shape: "stick",  lenScale: 0.70, thin: true },
    { id: "one",    label: "一炷香", min: 25, shape: "stick",  lenScale: 1.0 },
    { id: "three",  label: "三炷香", min: 25, shape: "triple", lenScale: 1.0 },
    { id: "cone",   label: "香錐",   min: 45, shape: "cone",   lenScale: 0.175 },
    { id: "coil",   label: "盤香",   min: 60, shape: "coil",   lenScale: 0.50 },
  ];

  const LS = "incense-pomodoro-v1";
  const state = {
    presetIdx: 1,
    duration: PRESETS[1].min * 60,
    remaining: PRESETS[1].min * 60,
    running: false,
    lit: false,        // Smokes once lit (keeps burning even when paused), goes out only when the incense is spent
    finished: false,
    completed: 0,
    timeMode: 0,       // 0 none / 1 show time / 2 pomodoro (red, auto loop)
    resting: false,    // Pomodoro: rest after the incense is spent
    restRemaining: 0,
    theme: "paper",    // paper / night
    savedAt: Date.now(),
  };
  let REST_SEC = 5 * 60; // Rest 5 minutes (adjustable from console)
  let timeScale = 1;     // Debug: timer speed multiplier (only affects countdown, not smoke animation)

  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        presetIdx: state.presetIdx,
        duration: state.duration,
        remaining: state.remaining,
        running: state.running,
        lit: state.lit,
        finished: state.finished,
        completed: state.completed,
        timeMode: state.timeMode,
        resting: state.resting,
        restRemaining: state.restRemaining,
        restLen: REST_SEC,
        theme: state.theme,
        savedAt: Date.now(),
      }));
    } catch (e) {}
  }
  function load() {
    try {
      const raw = localStorage.getItem(LS);
      if (!raw) return;
      const s = JSON.parse(raw);
      state.presetIdx = s.presetIdx ?? 1;
      state.duration = s.duration ?? PRESETS[state.presetIdx].min * 60;
      state.remaining = s.remaining ?? state.duration;
      state.lit = !!s.lit;
      state.finished = !!s.finished;
      state.completed = s.completed ?? 0;
      // Backward compatible with the old showTime field
      state.timeMode = (s.timeMode != null) ? s.timeMode : (s.showTime ? 1 : 0);
      state.resting = !!s.resting;
      state.restRemaining = s.restRemaining ?? 0;
      if (s.restLen) REST_SEC = s.restLen;
      state.theme = s.theme === "night" ? "night" : "paper";
      const elapsed = (Date.now() - (s.savedAt || Date.now())) / 1000;
      if (state.resting) {
        // Resting: subtract the elapsed time
        state.restRemaining = Math.max(0, state.restRemaining - elapsed);
        state.running = false;
      } else if (s.running && !s.finished) {
        // If still burning when leaving, subtract the elapsed time
        state.remaining = Math.max(0, state.remaining - elapsed);
        state.running = state.remaining > 0;
        state.lit = true;
        if (state.remaining <= 0) finish();
      } else {
        state.running = false;
      }
    } catch (e) {}
  }

  // ---------- Main loop ----------
  let last = performance.now();
  let simT = 0; // Simulation clock: advances only while burning; frozen when paused (smoke and flame both hold)
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05; // Prevent jumps when switching back to the tab

    // Paused = lit but not counting down, and incense not spent -> time frozen
    const frozen = state.lit && !state.running && !state.finished;
    const sdt = frozen ? 0 : dt;          // Do not advance the simulation while frozen
    if (!frozen) simT += dt;

    const tdt = dt * timeScale; // For the countdown (can be sped up)
    if (state.resting) {
      // Pomodoro rest countdown; auto-lights a new incense when it ends
      state.restRemaining -= tdt;
      if (state.restRemaining <= 0) { state.restRemaining = 0; relight(); }
    } else if (state.running && !state.finished) {
      state.remaining -= tdt;
      if (state.remaining <= 0) { state.remaining = 0; finish(); }
    }

    // Burn progress tracks the remaining time against the incense's original duration
    // (constant rate), not the live `duration`. This keeps the burn linear, makes ±1 min
    // visibly scale the shape, and avoids the jump that happened when `duration` got
    // clamped down toward `remaining` near the end. `lenScale` stays the preset's fixed
    // maximum; the scene applies `progress` per shape (stick shortens, cone lowers,
    // coil's ember travels inward).
    const preset = PRESETS[state.presetIdx];
    const baseSec = preset.min * 60;
    const progress = Math.max(0, Math.min(1, baseSec > 0 ? state.remaining / baseSec : 0));
    IncenseScene.render({
      dt, sdt, simT,
      theme: state.theme,
      shape: preset.shape,
      thin: !!preset.thin,
      lenScale: preset.lenScale,
      progress,
      lit: state.lit,
      finished: state.finished,
      running: state.running,
      // Only emit smoke while burning (countdown running); stop when paused or spent
      emitting: state.running && state.lit && !state.finished && state.remaining > 0,
    });

    renderUI();
    requestAnimationFrame(frame);
  }

  // ---------- UI ----------
  const elReadout = document.getElementById("readout");
  const elTime = document.getElementById("time");
  const elPhase = document.getElementById("phase");
  const elControls = document.getElementById("controls");
  const elIgnite = document.getElementById("ignite");
  const elIgniteIcon = document.getElementById("igniteIcon");
  const elReset = document.getElementById("reset");
  const elAdjWork = document.getElementById("adjWork");
  const elAdjRest = document.getElementById("adjRest");
  const elPresets = document.getElementById("presets");
  const elDone = document.getElementById("done");
  const elHint = document.getElementById("hint");
  const elDots = document.getElementById("dots");
  const elTimeToggle = document.getElementById("timeToggle");
  const elTally = document.getElementById("tally");
  const elThemeToggle = document.getElementById("themeToggle");
  const elThemeIcon = document.getElementById("themeIcon");

  const MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>';
  const SUN = '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.3"/><path d="M12 3.2v2M12 18.8v2M3.2 12h2M18.8 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';

  function applyTheme(animate) {
    document.body.setAttribute("data-theme", state.theme);
    elThemeIcon.innerHTML = state.theme === "night" ? SUN : MOON;
    if (animate) {
      const stage = document.getElementById("stage");
      stage.style.animation = "none";
      void stage.offsetWidth; // Force a keyframe restart
      stage.style.animation = "";
      document.body.classList.add("theme-animate-ready");
    }
  }

  const ICON_CLOCK = '<circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.3"/><path d="M12 7.6V12l3 1.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>';
  const ICON_TOMATO = '<path d="M12 7.4c4.1 0 6.7 2.7 6.7 6.3S15.8 20.4 12 20.4s-6.7-3.1-6.7-6.7S7.9 7.4 12 7.4Z" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M12 7.4V4.7M12 7.4c.2-1.6 1.5-2.7 3.3-2.6M12 7.4c-.2-1.4-1.4-2.4-3-2.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
  const ICON_X = '<path d="M7.2 7.2l9.6 9.6M16.8 7.2l-9.6 9.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
  const MODE_NAME = ["無", "顯示時間", "蕃茄鐘"];

  // Render the top-right button per mode (icon + style); also used to preview the next stage on hover
  function renderToggle(mode, preview) {
    const svg = elTimeToggle.querySelector("svg");
    // Preview of "off (none)" uses the X; pomodoro uses the tomato; otherwise the clock
    svg.innerHTML = mode === 2 ? ICON_TOMATO : (preview && mode === 0 ? ICON_X : ICON_CLOCK);
    elTimeToggle.classList.toggle("on", mode === 1);
    elTimeToggle.classList.toggle("pomo", mode === 2);
    elTimeToggle.classList.toggle("preview", !!preview);
  }

  function applyTimeVisibility() {
    const timed = state.timeMode >= 1;
    // The completion notice (#done) and readout (#readout) share top:13%; hide the readout when spent to avoid overlap
    const doneShown = state.finished && !state.resting;
    elReadout.classList.toggle("visible", timed && !doneShown);
    elTally.classList.toggle("visible", timed);
    // Time adjust (−/+) only when the time is shown; rest adjust only in pomodoro
    elAdjWork.hidden = !timed;
    elAdjRest.hidden = state.timeMode !== 2;
    renderToggle(state.timeMode, false);
    elTimeToggle.setAttribute("aria-pressed", String(timed));
    const next = (state.timeMode + 1) % 3;
    elTimeToggle.setAttribute("aria-label", "計時模式:" + MODE_NAME[state.timeMode] + "(點擊切換為:" + MODE_NAME[next] + ")");
  }

  // Show the incense picker only when not lit; collapse after lighting, reappear on relight
  function applyPresetsVisibility() {
    elPresets.classList.toggle("gone", state.lit);
  }

  function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  let dimTimer = null;
  function scheduleDim() {
    clearTimeout(dimTimer);
    elControls.classList.remove("dim");
    if (state.running) {
      dimTimer = setTimeout(() => elControls.classList.add("dim"), 2600);
    }
  }

  function renderUI() {
    elReadout.classList.toggle("resting", state.resting);
    if (state.resting) {
      elTime.textContent = "休 息";
      elPhase.textContent = fmt(state.restRemaining);
    } else {
      elTime.textContent = fmt(state.remaining);
      elPhase.textContent = state.timeMode === 2 ? fmt(REST_SEC) : "";
    }
  }

  function renderDots() {
    elDots.innerHTML = "";
    const n = Math.min(state.completed, 8);
    for (let i = 0; i < n; i++) {
      const d = document.createElement("span");
      d.className = "dot";
      elDots.appendChild(d);
    }
    if (state.completed > 8) {
      const more = document.createElement("span");
      more.textContent = "+" + (state.completed - 8);
      more.style.fontSize = "11px";
      elDots.appendChild(more);
    }
  }

  function buildPresets() {
    elPresets.innerHTML = "";
    PRESETS.forEach((p, i) => {
      const b = document.createElement("button");
      b.className = "preset";
      b.setAttribute("aria-pressed", String(i === state.presetIdx));
      b.innerHTML = `${p.label}<small>${p.min} 分</small>`;
      b.addEventListener("click", () => selectPreset(i));
      elPresets.appendChild(b);
    });
  }

  function selectPreset(i) {
    if (state.lit && !state.finished && i !== state.presetIdx) {
      // Switching incense while burning = light a fresh one
    }
    state.presetIdx = i;
    state.duration = PRESETS[i].min * 60;
    state.remaining = state.duration;
    state.running = false;
    state.lit = false;
    state.finished = false;
    state.resting = false;
    IncenseScene.reset();
    elDone.classList.remove("show");
    [...elPresets.children].forEach((c, idx) =>
      c.setAttribute("aria-pressed", String(idx === i)));
    updateIgniteIcon();
    applyPresetsVisibility();
    applyTimeVisibility();   // After reset, re-show the readout if the timer is on
    elReset.disabled = true;
    elHint.style.opacity = "1";
    renderUI();
    scheduleDim();
    save();
  }

  function updateIgniteIcon() {
    if (state.running) {
      // Pause icon
      elIgniteIcon.innerHTML = '<rect x="8" y="6" width="2.6" height="12" rx="1" fill="currentColor"/><rect x="13.4" y="6" width="2.6" height="12" rx="1" fill="currentColor"/>';
      elIgnite.setAttribute("aria-label", "暫停");
    } else if (state.lit && !state.finished) {
      // Resume (play)
      elIgniteIcon.innerHTML = '<path d="M8 5.5 18 12 8 18.5Z" fill="currentColor"/>';
      elIgnite.setAttribute("aria-label", "繼續");
    } else {
      // Light incense (flame)
      elIgniteIcon.innerHTML = '<path d="M12 3c1.8 2.4 4.2 4 4.2 7.2A4.2 4.2 0 0 1 12 14.4a4.2 4.2 0 0 1-4.2-4.2C7.8 7 10.2 5.4 12 3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M12 14.4V21" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
      elIgnite.setAttribute("aria-label", "點香");
    }
  }

  function ignite() {
    state.resting = false;
    if (state.finished) { selectPreset(state.presetIdx); }
    if (!state.lit) state.lit = true;
    state.running = true;
    elReset.disabled = false;
    elHint.style.opacity = "0";
    elDone.classList.remove("show");
    updateIgniteIcon();
    applyPresetsVisibility();
    scheduleDim();
    save();
  }
  function pause() {
    state.running = false;
    updateIgniteIcon();
    elControls.classList.remove("dim");
    clearTimeout(dimTimer);
    save();
  }
  function toggle() {
    if (state.running) pause();
    else ignite();
  }
  function reset() {
    selectPreset(state.presetIdx);
  }
  function finish() {
    state.running = false;
    state.finished = true;
    state.completed += 1;
    renderDots();
    updateIgniteIcon();
    elReset.disabled = false;
    elControls.classList.remove("dim");
    clearTimeout(dimTimer);
    if (state.timeMode === 2) {
      startRest();           // Pomodoro: auto-enter rest
    } else {
      elDone.classList.add("show");
    }
    applyTimeVisibility();   // Hide the readout when spent to avoid overlapping the completion notice
    save();
  }

  // Pomodoro: start a 5-minute rest
  function startRest() {
    state.resting = true;
    state.restRemaining = REST_SEC;
    elDone.classList.remove("show");
    save();
  }

  // Pomodoro: rest ends -> auto-light a new incense
  function relight() {
    state.resting = false;
    state.remaining = state.duration;
    state.finished = false;
    state.lit = true;
    state.running = true;
    IncenseScene.reset();
    elDone.classList.remove("show");
    elReset.disabled = false;
    updateIgniteIcon();
    applyPresetsVisibility();
    applyTimeVisibility();   // Relight after rest: restore the readout display
    save();
  }

  elTimeToggle.addEventListener("click", () => {
    state.timeMode = (state.timeMode + 1) % 3;
    if (state.timeMode === 2) {
      // Enter pomodoro: if the incense is already spent, start the rest countdown immediately
      if (state.finished && !state.resting) startRest();
    } else if (state.resting) {
      // Leave pomodoro -> cancel rest, return to the spent state
      state.resting = false;
      if (state.finished) elDone.classList.add("show");
    }
    applyTimeVisibility();
    save();
  });
  // Hover to preview the next stage's icon (helps users discover the pomodoro mode)
  elTimeToggle.addEventListener("mouseenter", () => {
    renderToggle((state.timeMode + 1) % 3, true);
  });
  elTimeToggle.addEventListener("mouseleave", () => {
    renderToggle(state.timeMode, false);
  });

  elThemeToggle.addEventListener("click", () => {
    state.theme = state.theme === "night" ? "paper" : "night";
    applyTheme(true);
    save();
  });

  elIgnite.addEventListener("click", toggle);
  elReset.addEventListener("click", reset);

  const STEP = 60;         // Each tap adjusts by 1 minute
  const MIN_SEC = 60;      // Never reduce a countdown below 1 minute
  // "香" group: adjust the current incense; + extends, − shortens, keeping duration >= remaining
  function adjustWork(sign) {
    if (sign > 0) {
      state.remaining += STEP;
      state.duration += STEP;
    } else {
      state.remaining = Math.max(MIN_SEC, state.remaining - STEP);
      state.duration = Math.max(state.remaining, state.duration - STEP);
    }
    save();
  }
  // "息" group: while resting adjust the remaining rest; otherwise adjust the next rest length
  function adjustRest(sign) {
    if (state.resting) {
      state.restRemaining = sign > 0
        ? state.restRemaining + STEP
        : Math.max(MIN_SEC, state.restRemaining - STEP);
    } else {
      REST_SEC = sign > 0 ? REST_SEC + STEP : Math.max(MIN_SEC, REST_SEC - STEP);
    }
    save();
  }
  function onAdjustClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    switch (b.dataset.act) {
      case "work+": adjustWork(1); break;
      case "work-": adjustWork(-1); break;
      case "rest+": adjustRest(1); break;
      case "rest-": adjustRest(-1); break;
    }
  }
  elAdjWork.addEventListener("click", onAdjustClick);
  elAdjRest.addEventListener("click", onAdjustClick);

  // Tap the screen = light incense / pause
  document.getElementById("scene").addEventListener("click", toggle);
  document.getElementById("stage").addEventListener("click", toggle);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") { e.preventDefault(); toggle(); }
  });
  window.addEventListener("pointermove", scheduleDim, { passive: true });

  // Leaving the window does not pause; keep burning, just persist state
  document.addEventListener("visibilitychange", save);
  window.addEventListener("beforeunload", save);
  setInterval(save, 4000);

  // ---------- Debug interface (console) ----------
  // Usage examples:
  //   incense.speed(60)        // Speed up the timer 60x (a 25-min incense burns in ~25s)
  //   incense.speed(1)         // Back to normal speed
  //   incense.setRemaining(10) // Set the current incense's remaining time to 10s
  //   incense.finish()         // Burn out immediately (pomodoro mode auto-enters rest)
  //   incense.restLength(20)   // Change rest length to 20s (takes effect next rest)
  //   incense.setRest(5)       // If resting, set the rest remaining to 5s
  //   incense.endRest()        // End the rest immediately -> auto-light the next one
  //   incense.pomodoro()       // Switch to pomodoro mode
  //   incense.status()         // Print the current state
  window.incense = {
    get state() { return state; },
    speed(x) { timeScale = Math.max(0, +x || 1); console.log("[incense] timeScale =", timeScale); return timeScale; },
    setRemaining(sec) { state.remaining = Math.max(0, +sec || 0); save(); return state.remaining; },
    setDuration(sec) { state.duration = Math.max(1, +sec || 1); save(); return state.duration; },
    finish() { if (!state.finished) { state.remaining = 0; finish(); } return this.status(); },
    restLength(sec) { REST_SEC = Math.max(1, +sec || 1); console.log("[incense] REST_SEC =", REST_SEC); return REST_SEC; },
    setRest(sec) { if (state.resting) { state.restRemaining = Math.max(0, +sec || 0); save(); } else { console.warn("[incense] 目前不在休息中"); } return state.restRemaining; },
    startRest() { startRest(); return this.status(); },
    endRest() { if (state.resting) { state.restRemaining = 0; relight(); } else { console.warn("[incense] 目前不在休息中"); } return this.status(); },
    pomodoro() { state.timeMode = 2; if (state.finished && !state.resting) startRest(); applyTimeVisibility(); save(); return this.status(); },
    mode(m) { state.timeMode = ((+m % 3) + 3) % 3; applyTimeVisibility(); save(); return state.timeMode; },
    ignite() { ignite(); return this.status(); },
    status() {
      const s = {
        timeMode: ["無", "顯示時間", "蕃茄鐘"][state.timeMode],
        lit: state.lit, running: state.running, finished: state.finished,
        resting: state.resting,
        remaining: Math.ceil(state.remaining), restRemaining: Math.ceil(state.restRemaining),
        duration: state.duration, completed: state.completed, timeScale,
        REST_SEC,
      };
      console.table(s);
      return s;
    },
  };

  // ---------- Startup ----------
  IncenseScene.init(document.getElementById("scene"));
  load();
  buildPresets();
  renderDots();
  updateIgniteIcon();
  applyTheme();
  applyTimeVisibility();
  applyPresetsVisibility();
  renderUI();
  if (state.lit && !state.finished) { elReset.disabled = false; elHint.style.opacity = "0"; }
  if (state.finished || state.resting) { elReset.disabled = false; elHint.style.opacity = "0"; }
  if (state.finished && !state.resting) { elDone.classList.add("show"); }
  scheduleDim();
  requestAnimationFrame(frame);
})();

// ---------- PWA: register Service Worker (offline-capable) ----------
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

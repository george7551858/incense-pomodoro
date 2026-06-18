# AGENTS.md

## Conventions

- **Use English for all code comments and documentation** (including this file, commit messages, and any new docs).

## Project overview

"一炷香 · 蕃茄鐘" (Incense Pomodoro) is a plain static PWA — no build tooling, no `package.json`. Key files:

- `index.html` — all UI and logic (includes Service Worker registration)
- `scene.js` — scene animation
- `sw.js` — Service Worker (offline-first cache)
- `manifest.webmanifest`, `icons/`, `leaves.png`
- `stamp-sw.sh` — stamps a UTC timestamp into the SW `VERSION`

## ⚠️ Read before running Browser / viewing the UI: PWA cache shows stale builds

This project ships a Service Worker (`sw.js`) whose default behavior causes "I changed the code but still see the old screen":

- `VERSION` is a fixed string; the browser only reinstalls the SW and refreshes the cache when the bytes of `sw.js` change.
- Same-origin assets (`scene.js`, etc.) are **cache-first** — if a cached copy exists, the network is never consulted.
- The SW is offline-first, so **even with no http server running, a previously registered SW will serve the whole app from cache**, making you see an old build.

### Before verifying the UI

1. **Always start an http server first**, then open the page (the SW is not registered on `file://`, but stale cache may still linger). For example:

   ```bash
   python3 -m http.server 8000
   ```

2. When viewing via browser automation / DevTools, **bypass the SW cache** so a stale build does not mislead you:
   - DevTools → Application → Service Workers: check **Update on reload** and **Bypass for network**
   - DevTools → Network: check **Disable cache**
   - If needed, **Unregister** + Clear storage, then reload

3. If you still see an old screen, first confirm whether the SW is serving a stale cache before concluding anything. **Do not assume the code change did not take effect.**

### When a change affects the cache

If you change `index.html`, `scene.js`, or any file in the `CORE` list, run this once **before deploying/committing** so users get the new build:

```bash
./stamp-sw.sh
```

It writes the current UTC timestamp into the `sw.js` `VERSION` (e.g. `incense-pomodoro-20260618T082415Z`). Once the browser detects the changed `sw.js`, it reinstalls the SW and refreshes the cache. **Do not leave `VERSION` at a stale value.**

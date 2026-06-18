# Incense Pomodoro (一炷香 · 蕃茄鐘)

A minimalist focus timer built around the imagery of a burning incense stick. Light the incense, watch the smoke rise and the stick burn down, and complete one session of focus in a single mindful breath.

The entire app is a single file, `index.html` — pure front-end, no build step, and no external dependencies (fonts are loaded from Google Fonts). Just open it and go.

The day/night sunlight effect is inspired by https://sunlit.pages.dev/.

> 中文說明請見 [README_zh.md](README_zh.md)。

## Features

- **Incense visuals**: The burning stick, drifting smoke, and ash are drawn on a Canvas. When the incense burns out, the session is complete.
- **Four incense lengths**: Short (15 min), One Stick (25 min), Medium (45 min), and Long (60 min).
- **Pomodoro mode**: Optionally show the remaining time; after the incense burns out, a 5-minute break begins.
- **Daily record**: Completed sessions are marked as dots and stored in the browser's `localStorage`.
- **Day / Night theme**: Warm paper tones by day, a deep dark mood by night.
- **Light / Pause / Relight**: Tap the screen or use the buttons to control the timer.
- **PWA · installable & offline**: Ships a Web App Manifest with a full icon set and a service worker that caches assets, so you can add it to your home screen and run it offline.

## Usage

Just open `index.html` in your browser:

```bash
# Open directly
open index.html        # macOS
xdg-open index.html    # Linux

# Or serve it locally
python3 -m http.server 8000
# Visit http://localhost:8000
```

> Installing the app or using it offline (PWA) requires serving over `http(s)://` — a service worker is not registered on `file://`. Open it via `localhost` or HTTPS and you'll see an "Install" option in your browser.

## Controls

| Action | Description |
| --- | --- |
| Tap screen / Light button | Light the incense to start; tap again to pause |
| Relight | Reset the current session |
| Length labels | Switch between Short / One Stick / Medium / Long |
| Clock button | Toggle Pomodoro mode (show time) |
| Day / Night button | Switch theme |

## License

MIT

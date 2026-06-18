#!/usr/bin/env python3
"""Generate PWA icons for 一炷香 · 蕃茄鐘.

Draws a warm "宣紙" (paper) background with a slender incense stick, a glowing
ember tip and a wisp of rising smoke — matching the app's aesthetic. Renders at
high resolution then downsamples for crisp anti-aliased output.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

# Palette (mirrors index.html paper theme)
PAPER_0 = (239, 231, 214)   # #efe7d6 centre
PAPER_2 = (210, 196, 168)   # slightly deeper edge for contrast
INK = (70, 64, 47)          # #46402f
EMBER_CORE = (255, 244, 214)
EMBER_HOT = (236, 138, 58)
EMBER_DEEP = (192, 57, 43)

SS = 4  # supersample factor


def radial_paper(size):
    """Warm radial gradient background, brighter at centre."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    cx = cy = size / 2
    maxd = math.hypot(cx, cy)
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy) / maxd
            t = min(1.0, d ** 1.15)
            r = int(PAPER_0[0] + (PAPER_2[0] - PAPER_0[0]) * t)
            g = int(PAPER_0[1] + (PAPER_2[1] - PAPER_0[1]) * t)
            b = int(PAPER_0[2] + (PAPER_2[2] - PAPER_0[2]) * t)
            px[x, y] = (r, g, b)
    return img


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def draw_design(size, content_scale, full_bleed):
    """Render the icon at `size` px.

    content_scale: fraction of the canvas the artwork occupies (for maskable
    safe-zone padding). full_bleed: paper fills the whole square.
    """
    S = size * SS
    base = radial_paper(S) if full_bleed else radial_paper(S)
    base = base.convert("RGBA")

    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    cx = S * 0.5
    # Artwork vertical layout inside the content box.
    pad = (1 - content_scale) / 2
    top = S * (pad + 0.06)        # ember area
    bottom = S * (1 - pad - 0.04)  # base of stick

    ember_y = top + S * 0.07
    stick_top = ember_y + S * 0.02
    stick_w = S * 0.022 * (content_scale)

    # --- incense stick (slender, slightly tapered) ---
    seg = 60
    for i in range(seg):
        t = i / (seg - 1)
        y0 = stick_top + (bottom - stick_top) * t
        y1 = stick_top + (bottom - stick_top) * (t + 1 / seg)
        w = stick_w * (0.85 + 0.3 * t)
        col = lerp((92, 84, 64), INK, t)
        d.line([(cx, y0), (cx, y1)], fill=col + (255,), width=max(1, int(w)))

    # --- ember glow ---
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = S * 0.085
    gd.ellipse([cx - gr, ember_y - gr, cx + gr, ember_y + gr],
               fill=EMBER_HOT + (120,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.02))
    overlay.alpha_composite(glow)

    # ember body
    er = S * 0.03
    d.ellipse([cx - er, ember_y - er, cx + er, ember_y + er],
              fill=EMBER_DEEP + (255,))
    d.ellipse([cx - er * 0.62, ember_y - er * 0.62,
               cx + er * 0.62, ember_y + er * 0.62],
              fill=EMBER_HOT + (255,))
    d.ellipse([cx - er * 0.28, ember_y - er * 0.34,
               cx + er * 0.28, ember_y + er * 0.18],
              fill=EMBER_CORE + (255,))

    # --- smoke wisp rising from the ember ---
    smoke = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(smoke)
    n = 120
    prev = None
    for i in range(n):
        t = i / (n - 1)
        y = ember_y - S * 0.02 - (ember_y - top) * 0.95 * t
        amp = S * 0.05 * t
        x = cx + math.sin(t * math.pi * 2.6 + 0.4) * amp
        w = max(1, int(S * 0.012 * (1 - 0.4 * t)))
        a = int(150 * (1 - t) ** 1.3)
        if prev is not None:
            sd.line([prev, (x, y)], fill=INK + (a,), width=w)
        prev = (x, y)
    smoke = smoke.filter(ImageFilter.GaussianBlur(S * 0.006))
    overlay.alpha_composite(smoke)

    base.alpha_composite(overlay)
    out = base.resize((size, size), Image.LANCZOS).convert("RGB")
    return out


def save(img, name):
    p = os.path.join(OUT, name)
    img.save(p)
    print("wrote", os.path.relpath(p))


def main():
    # Standard ("any") icons — modest padding, full-bleed paper.
    for s in (192, 512):
        save(draw_design(s, content_scale=0.86, full_bleed=True), f"icon-{s}.png")
    # Maskable icons — generous safe-zone padding.
    for s in (192, 512):
        save(draw_design(s, content_scale=0.66, full_bleed=True),
             f"icon-maskable-{s}.png")
    # Apple touch icon (no transparency, 180px).
    save(draw_design(180, content_scale=0.78, full_bleed=True),
         "apple-touch-icon.png")
    # Favicons.
    save(draw_design(32, content_scale=0.9, full_bleed=True), "favicon-32.png")
    save(draw_design(16, content_scale=0.96, full_bleed=True), "favicon-16.png")
    # Multi-size .ico
    ico = draw_design(64, content_scale=0.9, full_bleed=True)
    ico.save(os.path.join(OUT, "favicon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48)])
    print("wrote", os.path.relpath(os.path.join(OUT, "favicon.ico")))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Render animated SVG logo to GIF using Playwright + Pillow."""

import base64
import sys
from io import BytesIO
from pathlib import Path

# --- Config ---
PROJECT = Path(__file__).resolve().parent.parent
SVG_PATH = PROJECT / "img" / "logo.svg"
GIF_PATH = PROJECT / "img" / "logo.gif"
DURATION = 6.0        # total seconds to capture
FPS = 15              # frames per second
SIZE = 256            # output GIF pixel size
BG = "#FFFFFF"        # background color (opaque for GIF)
# -------------

def main():
    from playwright.sync_api import sync_playwright
    from PIL import Image

    if not SVG_PATH.exists():
        print(f"❌ SVG not found: {SVG_PATH}", file=sys.stderr)
        sys.exit(1)

    svg_content = SVG_PATH.read_text()
    svg_b64 = base64.b64encode(svg_content.encode()).decode()

    frames = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": SIZE, "height": SIZE})

        # Build inline HTML with embedded SVG
        html = f"""<html><body style="margin:0;display:flex;align-items:center;
justify-content:center;width:{SIZE}px;height:{SIZE}px;background:{BG};">
<img src="data:image/svg+xml;base64,{svg_b64}" width="{SIZE}" height="{SIZE}" />
</body></html>"""

        page.set_content(html, wait_until="load")
        # Let the page settle and animations start
        page.wait_for_timeout(300)

        total_frames = int(DURATION * FPS)
        interval_ms = int(1000 / FPS)

        for i in range(total_frames):
            screenshot = page.screenshot(
                clip={"x": 0, "y": 0, "width": SIZE, "height": SIZE},
                type="png",
            )
            img = Image.open(BytesIO(screenshot)).convert("RGB")
            frames.append(img)
            if i < total_frames - 1:
                page.wait_for_timeout(interval_ms)

        browser.close()

    # Save GIF — use optimize for smaller file size
    print(f"Encoding {len(frames)} frames...")
    frames[0].save(
        str(GIF_PATH),
        save_all=True,
        append_images=frames[1:],
        duration=interval_ms,
        loop=0,
        disposal=2,
        optimize=True,
    )
    size_kb = GIF_PATH.stat().st_size // 1024
    print(f"✅ Saved {GIF_PATH.name} ({len(frames)} frames, {DURATION}s @ {FPS}fps, {size_kb}KB)")

if __name__ == "__main__":
    main()

"""Generate the home-screen ("Add to Home Screen") icons for the PSC Teams site.

Design: white square with the PSC crest on top and a navy bottom strip (with a thin
gold accent line) carrying "TEAMS" in white Poppins SemiBold — the PSC site's
heading font. Run once: `uv run --with pillow python scripts/make_icon.py`.
Outputs assets/icon-180.png, icon-192.png, icon-512.png.
"""

import pathlib
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FONT_PATH = ROOT / "scripts" / "Poppins-SemiBold.ttf"
FONT_URL = "https://cdn.jsdelivr.net/gh/google/fonts/ofl/poppins/Poppins-SemiBold.ttf"

NAVY = (34, 46, 98, 255)   # --psc-navy #222e62
GOLD = (255, 203, 5, 255)  # --psc-gold #ffcb05
WHITE = (255, 255, 255, 255)

if not FONT_PATH.exists():
    print("downloading Poppins SemiBold…")
    urllib.request.urlretrieve(FONT_URL, FONT_PATH)

crest = Image.open(ASSETS / "psc-logo.png").convert("RGBA")


def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), WHITE)
    d = ImageDraw.Draw(img)

    strip_top = int(size * 0.72)
    d.rectangle([0, strip_top, size, size], fill=NAVY)
    gold_h = max(2, round(size * 0.012))
    d.rectangle([0, strip_top, size, strip_top + gold_h], fill=GOLD)

    # crest centred in the white area
    target_w = int(size * 0.52)
    cw, ch = target_w, round(crest.height * target_w / crest.width)
    max_ch = int(strip_top * 0.78)
    if ch > max_ch:
        ch, cw = max_ch, round(crest.width * max_ch / crest.height)
    resized = crest.resize((cw, ch), Image.LANCZOS)
    img.alpha_composite(resized, ((size - cw) // 2, (strip_top - ch) // 2))

    # "TEAMS" in the navy strip
    font = ImageFont.truetype(str(FONT_PATH), int(size * 0.165))
    text = "TEAMS"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = strip_top + (size - strip_top - th) // 2 - bbox[1]
    d.text((tx, ty), text, font=font, fill=WHITE)

    return img.convert("RGB")


for s in (512, 192, 180):
    out = ASSETS / f"icon-{s}.png"
    make(s).save(out)
    print("wrote", out)

"""Generate the home-screen ("Add to Home Screen") icons for a club's Teams site.

Design: white square with the club crest on top and a brand-navy bottom strip (with a
thin gold accent line) carrying "TEAMS" in white Poppins SemiBold. Colours, crest and
label come from the club's config, so it works for any club.

Usage:  uv run --with pillow python scripts/make_icon.py <slug>   (e.g. psc, cltc)

Reads  clubs/<slug>/club.json  (colors.navy, colors.gold, optional iconText) and
       clubs/<slug>/assets/logo.png
Writes clubs/<slug>/assets/icon-180.png, icon-192.png, icon-512.png
"""

import json
import pathlib
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT_PATH = ROOT / "scripts" / "Poppins-SemiBold.ttf"
FONT_URL = "https://cdn.jsdelivr.net/gh/google/fonts/ofl/poppins/Poppins-SemiBold.ttf"
WHITE = (255, 255, 255, 255)


def hex_rgba(value: str, default: str) -> tuple[int, int, int, int]:
    h = (value or default).lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


def make(size: int, crest: Image.Image, navy, gold, text: str) -> Image.Image:
    img = Image.new("RGBA", (size, size), WHITE)
    d = ImageDraw.Draw(img)

    strip_top = int(size * 0.72)
    d.rectangle([0, strip_top, size, size], fill=navy)
    gold_h = max(2, round(size * 0.012))
    d.rectangle([0, strip_top, size, strip_top + gold_h], fill=gold)

    # crest centred in the white area
    target_w = int(size * 0.52)
    cw, ch = target_w, round(crest.height * target_w / crest.width)
    max_ch = int(strip_top * 0.78)
    if ch > max_ch:
        ch, cw = max_ch, round(crest.width * max_ch / crest.height)
    resized = crest.resize((cw, ch), Image.LANCZOS)
    img.alpha_composite(resized, ((size - cw) // 2, (strip_top - ch) // 2))

    # label in the navy strip
    font = ImageFont.truetype(str(FONT_PATH), int(size * 0.165))
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = strip_top + (size - strip_top - th) // 2 - bbox[1]
    d.text((tx, ty), text, font=font, fill=WHITE)

    return img.convert("RGB")


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: make_icon.py <slug>  (e.g. psc, cltc)")
    slug = sys.argv[1]
    club_dir = ROOT / "clubs" / slug
    cfg = json.loads((club_dir / "club.json").read_text(encoding="utf-8"))
    colors = cfg.get("colors", {})
    navy = hex_rgba(colors.get("navy"), "#222e62")
    gold = hex_rgba(colors.get("gold"), "#ffcb05")
    text = cfg.get("iconText", "TEAMS")

    if not FONT_PATH.exists():
        print("downloading Poppins SemiBold…")
        urllib.request.urlretrieve(FONT_URL, FONT_PATH)

    crest = Image.open(club_dir / "assets" / "logo.png").convert("RGBA")
    for s in (512, 192, 180):
        out = club_dir / "assets" / f"icon-{s}.png"
        make(s, crest, navy, gold, text).save(out)
        print("wrote", out)


if __name__ == "__main__":
    main()

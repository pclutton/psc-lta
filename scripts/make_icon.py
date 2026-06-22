"""Generate the home-screen ("Add to Home Screen") icons for a club's Teams site.

Just the club crest, centred on a clean white square (no text) — the phone shows its
own label ("<short name> Teams") under the icon, so baking text in would duplicate it.

Usage:  uv run --with pillow python scripts/make_icon.py <slug>   (e.g. psc, cltc)

Reads  clubs/<slug>/assets/logo.png
Writes clubs/<slug>/assets/icon-180.png, icon-192.png, icon-512.png
"""

import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
WHITE = (255, 255, 255, 255)


def make(size: int, crest: Image.Image) -> Image.Image:
    img = Image.new("RGBA", (size, size), WHITE)
    # Fit the crest into ~78% of the square (leaves a margin so iOS's rounded-corner
    # mask never clips it), preserving aspect ratio, and centre it.
    target = int(size * 0.78)
    cw, ch = target, round(crest.height * target / crest.width)
    if ch > target:
        ch, cw = target, round(crest.width * target / crest.height)
    resized = crest.resize((cw, ch), Image.LANCZOS)
    img.alpha_composite(resized, ((size - cw) // 2, (size - ch) // 2))
    return img.convert("RGB")


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: make_icon.py <slug>  (e.g. psc, cltc)")
    slug = sys.argv[1]
    assets = ROOT / "clubs" / slug / "assets"
    crest = Image.open(assets / "logo.png").convert("RGBA")
    for s in (512, 192, 180):
        out = assets / f"icon-{s}.png"
        make(s, crest).save(out)
        print("wrote", out)


if __name__ == "__main__":
    main()

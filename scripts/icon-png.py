# /// script
# requires-python = ">=3.10"
# dependencies = ["cairosvg"]
# ///
"""
Builds media/icon.png, the extension's icon in the marketplace, from
media/icon.svg: the marketplace takes its icon only as a PNG, of at least
128 by 128.

    uv run scripts/icon-png.py
"""

from pathlib import Path

import cairosvg

MEDIA = Path(__file__).resolve().parent.parent / "media"
SIZE = 128

cairosvg.svg2png(url=str(MEDIA / "icon.svg"), write_to=str(MEDIA / "icon.png"), output_width=SIZE, output_height=SIZE)
print(f"Wrote {MEDIA / 'icon.png'}, {SIZE} by {SIZE}")

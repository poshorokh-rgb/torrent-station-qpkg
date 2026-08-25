#!/usr/bin/env python3
"""Legacy placeholder icon generator for the QPKG (no PIL dependency).

The released application artwork lives in icons/torrentstation-mark.png and
the derived QTS sizes icons/icon_64.png and icons/icon_80.png. Keep this
script only as a dependency-free fallback for development environments.
"""
import struct
import zlib
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT_DIR, exist_ok=True)


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_png(path, size, bg, fg, gray=False):
    w = h = size
    if gray:
        bg = tuple(int(sum(bg) / 3) for _ in range(3))
        fg = tuple(int(sum(fg) / 3) for _ in range(3))

    rows = []
    cx, cy = w / 2, h / 2
    r = w * 0.32
    for y in range(h):
        row = bytearray([0])  # filter type 0
        for x in range(w):
            # simple downward-pointing triangle (arrow) inside a circle silhouette
            dx, dy = x - cx, y - cy
            in_circle = (dx * dx + dy * dy) <= (r * r) * 1.15
            in_arrow = False
            if in_circle:
                ax = abs(dx) / (r * 0.9)
                ay = (dy + r * 0.5) / (r * 1.3)
                if 0 <= ay <= 1 and ax <= (1 - ay):
                    in_arrow = True
                if dy < -r * 0.1 and abs(dx) < r * 0.28 and dy > -r * 0.95:
                    in_arrow = True
            color = fg if in_arrow else (bg if in_circle else (0, 0, 0, 0))
            if len(color) == 3:
                row += bytes(color) + b"\xff"
            else:
                row += bytes(color)
        rows.append(bytes(row))
    raw = b"".join(rows)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


TEAL = (0x1f, 0x8a, 0x70)
WHITE = (0xff, 0xff, 0xff)

for size in (64, 80):
    make_png(os.path.join(OUT_DIR, f"icon_{size}.png"), size, TEAL, WHITE, gray=False)
    make_png(os.path.join(OUT_DIR, f"icon_gray_{size}.png"), size, TEAL, WHITE, gray=True)

print("icons written to", OUT_DIR)

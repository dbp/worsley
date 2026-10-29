# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools"]
# ///
"""
Builds media/worsley.ttf, a font whose one glyph, U+E000, is the sextant of
media/worsley.svg: VS Code shows an extension's own icon in the status bar
only from a font. A glyph is filled rather than stroked, so each line of the
drawing becomes what its stroke covers, a band along each straight line or
arc and a disc at each end for the round caps and joins. The pieces overlap,
and fill as one.

    uv run scripts/icon-font.py
"""

import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.misc.timeTools import timestampFromString
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._g_l_y_f import flagOverlapSimple

MEDIA = Path(__file__).resolve().parent.parent / "media"
SVG = "{http://www.w3.org/2000/svg}"
# The em of VS Code's own icon font, codicon.ttf, which the glyph sits beside.
EM = 300


def segments(element):
    """The lines and circular arcs an SVG <path> or <rect> draws."""
    if element.tag == SVG + "rect":
        x, y, w, h = (float(element.get(k)) for k in ("x", "y", "width", "height"))
        r = float(element.get("rx", 0))
        d = f"M{x + r} {y}H{x + w - r}A{r} {r} 0 0 1 {x + w} {y + r}V{y + h - r}A{r} {r} 0 0 1 {x + w - r} {y + h}H{x + r}A{r} {r} 0 0 1 {x} {y + h - r}V{y + r}A{r} {r} 0 0 1 {x + r} {y}Z"
    else:
        d = element.get("d")
    tokens = re.findall(r"[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)", d)
    out = []
    i = 0
    command = None
    start = here = (0.0, 0.0)

    def number():
        nonlocal i
        i += 1
        return float(tokens[i - 1])

    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
            if command not in "MLHVAZ":
                raise ValueError(f"{command}: only absolute M, L, H, V, A and Z are handled")
        if command == "M":
            start = here = (number(), number())
            command = "L"
        elif command == "L":
            out.append(("line", here, (p := (number(), number()))))
            here = p
        elif command == "H":
            out.append(("line", here, (p := (number(), here[1]))))
            here = p
        elif command == "V":
            out.append(("line", here, (p := (here[0], number()))))
            here = p
        elif command == "A":
            rx, ry, rotation, large, sweep = number(), number(), number(), number(), number()
            p = (number(), number())
            if rx != ry or rotation != 0:
                raise ValueError("only circular arcs are handled")
            if rx > 0:
                out.append(arc(here, p, rx, large != 0, sweep != 0))
            here = p
        elif command == "Z":
            if here != start:
                out.append(("line", here, start))
            here = start
    return out


def arc(p0, p1, r, large, sweep):
    """An SVG arc as its centre, radius, start angle and signed sweep."""
    hx, hy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    q = max(0.0, (r * r - hx * hx - hy * hy) / (hx * hx + hy * hy))
    k = math.sqrt(q) * (1 if large != sweep else -1)
    cx, cy = k * hy + (p0[0] + p1[0]) / 2, -k * hx + (p0[1] + p1[1]) / 2
    a0 = math.atan2(p0[1] - cy, p0[0] - cx)
    delta = math.atan2(p1[1] - cy, p1[0] - cx) - a0
    if sweep and delta < 0:
        delta += 2 * math.pi
    elif not sweep and delta > 0:
        delta -= 2 * math.pi
    return ("arc", (cx, cy), r, a0, delta)


def arc_points(c, r, a0, delta):
    """On- and off-curve points along an arc, a quadratic piece per 45° at most."""
    pieces = max(1, math.ceil(abs(delta) / (math.pi / 4)))
    step = delta / pieces
    points = [((c[0] + r * math.cos(a0), c[1] + r * math.sin(a0)), True)]
    for n in range(pieces):
        mid = a0 + step * (n + 0.5)
        reach = r / math.cos(step / 2)
        end = a0 + step * (n + 1)
        points.append(((c[0] + reach * math.cos(mid), c[1] + reach * math.sin(mid)), False))
        points.append(((c[0] + r * math.cos(end), c[1] + r * math.sin(end)), True))
    return points


def covered(segment, half):
    """What the stroke of a segment covers, as closed contours, besides its ends."""
    if segment[0] == "line":
        (x0, y0), (x1, y1) = segment[1], segment[2]
        length = math.hypot(x1 - x0, y1 - y0)
        if length == 0:
            return []
        nx, ny = -(y1 - y0) / length * half, (x1 - x0) / length * half
        return [[((x0 + nx, y0 + ny), True), ((x1 + nx, y1 + ny), True), ((x1 - nx, y1 - ny), True), ((x0 - nx, y0 - ny), True)]]
    _, c, r, a0, delta = segment
    outer = arc_points(c, r + half, a0, delta)
    if r > half:
        inner = arc_points(c, r - half, a0 + delta, -delta)
    else:
        inner = [(c, True)]
    return [outer + inner]


def ends(segment):
    if segment[0] == "line":
        return [segment[1], segment[2]]
    _, c, r, a0, delta = segment
    return [(c[0] + r * math.cos(a), c[1] + r * math.sin(a)) for a in (a0, a0 + delta)]


def main():
    root = ET.parse(MEDIA / "worsley.svg").getroot()
    if (root.get("stroke-linecap"), root.get("stroke-linejoin")) != ("round", "round"):
        raise ValueError("the drawing's lines should have round caps and joins")
    half = float(root.get("stroke-width")) / 2
    _, _, size, _ = (float(v) for v in root.get("viewBox").split())
    contours = []
    discs = set()
    for element in root.iter():
        if element.tag in (SVG + "path", SVG + "rect"):
            for segment in segments(element):
                contours += covered(segment, half)
                discs.update((round(x, 4), round(y, 4)) for x, y in ends(segment))
    contours += [arc_points(c, half, 0, 2 * math.pi)[:-1] for c in sorted(discs)]

    # Into font units, with y up, every contour turning the same way so that
    # overlaps fill as one.
    scale = EM / size
    pen = TTGlyphPen(None)
    for contour in contours:
        points = [((x * scale, (size - y) * scale), on) for (x, y), on in contour]
        area = sum(x0 * y1 - x1 * y0 for ((x0, y0), _), ((x1, y1), _) in zip(points, points[1:] + points[:1]))
        if area > 0:
            points.reverse()
        first = next(i for i, (_, on) in enumerate(points) if on)
        points = points[first:] + points[:first]
        pen.moveTo(points[0][0])
        i = 1
        while i < len(points):
            if points[i][1]:
                pen.lineTo(points[i][0])
                i += 1
            else:
                end = points[i + 1][0] if i + 1 < len(points) else points[0][0]
                pen.qCurveTo(points[i][0], end)
                i += 2
        pen.closePath()
    sextant = pen.glyph()
    sextant.flags[0] |= flagOverlapSimple

    fb = FontBuilder(EM, isTTF=True)
    fb.setupGlyphOrder([".notdef", "sextant"])
    fb.setupCharacterMap({0xE000: "sextant"})
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "sextant": sextant})
    glyf = fb.font["glyf"]
    fb.setupHorizontalMetrics({name: (EM, getattr(glyf[name], "xMin", 0)) for name in (".notdef", "sextant")})
    fb.setupHorizontalHeader(ascent=EM, descent=0)
    fb.setupNameTable({"familyName": "Worsley Icons", "styleName": "Regular", "fullName": "Worsley Icons", "psName": "WorsleyIcons", "version": "1.0"})
    fb.setupOS2(sTypoAscender=EM, sTypoDescender=0, sTypoLineGap=0, usWinAscent=EM, usWinDescent=0, fsType=0)
    fb.setupPost()
    # A fixed date, so that the same drawing builds the same file.
    stamp = timestampFromString("Thu Oct 29 00:00:00 2026")
    fb.updateHead(created=stamp, modified=stamp)
    fb.font.recalcTimestamp = False
    fb.save(MEDIA / "worsley.ttf")
    print(f"{MEDIA / 'worsley.ttf'}: {len(contours)} contours")


main()

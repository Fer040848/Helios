"""Single-stroke vector font for laser text.

Glyphs live on a grid 4 units wide and 6 units tall (baseline y=0, +y up); accents rise to ~8.
Each glyph is a list of polylines encoded as ``"x,y x,y ...|x,y ..."``.
"""

GLYPH_WIDTH = 4.0
CAP_HEIGHT = 6.0
ADVANCE = 5.0          # glyph width + letter spacing
SPACE_ADVANCE = 4.0

_DOT = "1.8,0 2.2,0 2.2,0.4 1.8,0.4 1.8,0"
_ACUTE = "1.5,6.8 2.6,7.9"

_GLYPHS = {
    "A": "0,0 2,6 4,0|1,3 3,3",
    "B": "0,0 0,6 3,6 4,5 4,4 3,3 0,3|3,3 4,2 4,1 3,0 0,0",
    "C": "4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1",
    "D": "0,0 0,6 2,6 4,4 4,2 2,0 0,0",
    "E": "4,6 0,6 0,0 4,0|0,3 3,3",
    "F": "4,6 0,6 0,0|0,3 3,3",
    "G": "4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3",
    "H": "0,0 0,6|4,0 4,6|0,3 4,3",
    "I": "1,6 3,6|2,6 2,0|1,0 3,0",
    "J": "4,6 4,1 3,0 1,0 0,1",
    "K": "0,0 0,6|4,6 0,2|1,3 4,0",
    "L": "0,6 0,0 4,0",
    "M": "0,0 0,6 2,3 4,6 4,0",
    "N": "0,0 0,6 4,0 4,6",
    "O": "1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0",
    "P": "0,0 0,6 3,6 4,5 4,4 3,3 0,3",
    "Q": "1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0|2,2 4,0",
    "R": "0,0 0,6 3,6 4,5 4,4 3,3 0,3|2,3 4,0",
    "S": "4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1",
    "T": "0,6 4,6|2,6 2,0",
    "U": "0,6 0,1 1,0 3,0 4,1 4,6",
    "V": "0,6 2,0 4,6",
    "W": "0,6 1,0 2,4 3,0 4,6",
    "X": "0,0 4,6|0,6 4,0",
    "Y": "0,6 2,3 4,6|2,3 2,0",
    "Z": "0,6 4,6 0,0 4,0",
    "0": "1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0|0,1 4,5",
    "1": "1,5 2,6 2,0|1,0 3,0",
    "2": "0,5 1,6 3,6 4,5 4,4 0,0 4,0",
    "3": "0,5 1,6 3,6 4,5 4,4 3,3 1,3|3,3 4,2 4,1 3,0 1,0 0,1",
    "4": "3,0 3,6 0,2 4,2",
    "5": "4,6 0,6 0,3 3,3 4,2 4,1 3,0 0,0",
    "6": "4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2 3,3 0,3",
    "7": "0,6 4,6 1,0",
    "8": "1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3",
    "9": "0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,4 1,3 4,3",
    ".": _DOT,
    ",": "2.2,0.6 2.2,0 1.6,-1",
    "!": "2,6 2,1.6|" + _DOT,
    "¡": "2,0 2,4.4|1.8,5.6 2.2,5.6 2.2,6 1.8,6 1.8,5.6",
    "?": "0,5 1,6 3,6 4,5 4,4 2,3 2,1.6|" + _DOT,
    "¿": "4,1 3,0 1,0 0,1 0,2 2,3 2,4.4|1.8,5.6 2.2,5.6 2.2,6 1.8,6 1.8,5.6",
    "-": "1,3 3,3",
    ":": "1.8,1 2.2,1 2.2,1.4 1.8,1.4 1.8,1|1.8,4 2.2,4 2.2,4.4 1.8,4.4 1.8,4",
    "+": "0,3 4,3|2,1 2,5",
    "/": "0,0 4,6",
}
# Spanish letters: base glyph plus a diacritic stroke.
_GLYPHS.update({
    "Á": _GLYPHS["A"] + "|" + _ACUTE,
    "É": _GLYPHS["E"] + "|" + _ACUTE,
    "Í": _GLYPHS["I"] + "|" + _ACUTE,
    "Ó": _GLYPHS["O"] + "|" + _ACUTE,
    "Ú": _GLYPHS["U"] + "|" + _ACUTE,
    "Ü": _GLYPHS["U"] + "|0.8,7 1.2,7 1.2,7.4 0.8,7.4 0.8,7|2.8,7 3.2,7 3.2,7.4 2.8,7.4 2.8,7",
    "Ñ": _GLYPHS["N"] + "|0,7 1,7.7 3,7 4,7.7",
})


def _parse(spec):
    return [[tuple(float(v) for v in pair.split(",")) for pair in line.split()] for line in spec.split("|")]


GLYPHS = {char: _parse(spec) for char, spec in _GLYPHS.items()}


def supported(char):
    return char == " " or char in GLYPHS


def layout(text):
    """Lay out ``text`` (upper-cased) on one line.

    Returns ``(polylines, width)`` in font units: x from 0 to ``width``, baseline at y=0.
    Unknown characters advance like a space.
    """
    polylines, cursor = [], 0.0
    for char in text.upper():
        glyph = GLYPHS.get(char)
        if glyph is None:
            cursor += SPACE_ADVANCE
            continue
        for line in glyph:
            polylines.append([(x + cursor, y) for x, y in line])
        cursor += ADVANCE
    width = max(0.0, cursor - (ADVANCE - GLYPH_WIDTH)) if polylines else cursor
    return polylines, width

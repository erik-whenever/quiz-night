"""
Ritar appikonerna (krona i signalgult på ultramarin) till public/.
Kör från app/:  python3 scripts/ikoner.py   (kräver Pillow)
Färger från designtokens i src/index.css: --studio, --signal, --studio-ink.
"""
from PIL import Image, ImageDraw

STUDIO, SIGNAL, INK = "#1b28a8", "#ffd23f", "#070b3a"
SS = 4  # översampling för mjuka kanter


def crown(size, scale):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, S, S], fill=STUDIO)  # fullt kvadratiskt, OS:et rundar själv
    # Kronan ritas i ett 32x32-rutnät (samma form som favicon), centrerat och skalat
    u = S * scale / 32
    ox = (S - 32 * u) / 2
    oy = (S - 32 * u) / 2 + u * 0.5
    P = lambda x, y: (ox + x * u, oy + y * u)
    sh = u * 0.9  # skugga i studio-ink, som knapparnas box-shadow
    body = [(4, 23), (2, 9), (10, 15), (16, 5), (22, 15), (30, 9), (28, 23)]
    band = [P(4, 24.2), P(28, 27.8)]
    d.polygon([(x, y + sh) for x, y in map(lambda p: P(*p), body)], fill=INK)
    d.rounded_rectangle([(band[0][0], band[0][1] + sh), (band[1][0], band[1][1] + sh)], radius=u * 0.8, fill=INK)
    d.polygon([P(*p) for p in body], fill=SIGNAL)
    d.rounded_rectangle(band, radius=u * 0.8, fill=SIGNAL)
    for x, y in [(2, 9), (16, 5), (30, 9)]:
        cx, cy = P(x, y)
        r = u * 2
        d.ellipse([cx - r, cy - r + sh, cx + r, cy + r + sh], fill=INK)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SIGNAL)
    # Ädelsten i bandet
    cx, cy = P(16, 26)
    r = u * 1.1
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=STUDIO)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    crown(192, 0.72).save("public/icon-192.png")
    crown(512, 0.72).save("public/icon-512.png")
    crown(512, 0.56).save("public/icon-maskable-512.png")  # inom 80 % säker zon
    crown(180, 0.68).convert("RGB").save("public/apple-touch-icon.png")
    print("Ikoner skrivna till public/")

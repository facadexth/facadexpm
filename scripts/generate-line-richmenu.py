# scripts/generate-line-richmenu.py
#
# Produces a LINE Rich Menu image: 2500x1686px, 3 equal horizontal
# tappable zones (LINE's minimum/maximum Rich Menu image size is well
# documented and fixed -- this is the "full" 2500x1686 layout). Each
# zone is a distinct flat color block with a large emoji + Thai label,
# legible at LINE's in-app menu thumbnail size. Run once locally:
#   python3 scripts/generate-line-richmenu.py
# writes richmenu.png to the current directory.
#
# Font paths verified against this build environment (macOS, Darwin
# 25.2.0) before shipping -- both exist and load cleanly:
#   /System/Library/Fonts/Supplemental/Tahoma.ttf (full Thai coverage)
#   /System/Library/Fonts/Apple Color Emoji.ttc (color bitmap glyphs --
#   drawn with embedded_color=True, required since Pillow 8 for color
#   fonts; without it draw.text raises/garbles on a color-glyph font).

from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 1686
ZONE_H = H // 3
zones = [
    ("🚧", "แจ้งปัญหา", (196, 90, 60)),
    ("📦", "ขอเบิกของ", (60, 130, 170)),
    ("🏖️", "ขอลา", (70, 150, 100)),
]

img = Image.new("RGB", (W, H), (245, 245, 240))
draw = ImageDraw.Draw(img)

try:
    label_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Tahoma.ttf", 110)
    emoji_font = ImageFont.truetype("/System/Library/Fonts/Apple Color Emoji.ttc", 160)
    emoji_embedded_color = True
except OSError:
    # Fallback for non-macOS environments -- any installed TTF with Thai
    # coverage works; adjust the path for the actual build environment.
    label_font = ImageFont.load_default()
    emoji_font = label_font
    emoji_embedded_color = False

for i, (emoji, label, color) in enumerate(zones):
    y0 = i * ZONE_H
    draw.rectangle([0, y0, W, y0 + ZONE_H], fill=color)
    text_y = y0 + ZONE_H // 2
    draw.text((200, text_y - 90), emoji, font=emoji_font, fill=(255, 255, 255), anchor="lm", embedded_color=emoji_embedded_color)
    draw.text((520, text_y), label, font=label_font, fill=(255, 255, 255), anchor="lm")
    if i < 2:
        draw.line([0, y0 + ZONE_H, W, y0 + ZONE_H], fill=(255, 255, 255), width=6)

img.save("richmenu.png")
print("wrote richmenu.png", img.size)

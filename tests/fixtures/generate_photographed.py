# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic dark receipt photo on a white sheet, for OCR threshold recovery."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

image = Image.new('RGB', (1200, 1700), 'white')
draw = ImageDraw.Draw(image)
draw.rectangle((120, 100, 650, 1150), fill=(135, 135, 135))
font = ImageFont.load_default(size=29)
lines = ['SYNTHETIC TEST RECEIPT', 'Example Receipt Company', 'Invoice number: TEST-42', 'Date: 2026-10-29', 'Total: $123.45', 'Thank you for your visit', 'No real customer information']
for index, line in enumerate(lines):
    draw.text((145, 170 + index * 95), line, font=font, fill=(15, 15, 15))
image.save(Path(__file__).with_name('photographed-receipt.pdf'), resolution=150)

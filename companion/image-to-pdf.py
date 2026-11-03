# SPDX-License-Identifier: AGPL-3.0-only
import sys
import warnings
from pathlib import Path
from PIL import Image, ImageOps
import img2pdf
warnings.simplefilter('error', Image.DecompressionBombWarning)
source, target = sys.argv[1:]
frames = []
# Normalize orientation and transparency without resizing. Temporary images live
# only inside the converter's private job directory, never the source Inbox.
with Image.open(source) as image:
    count = getattr(image, 'n_frames', 1)
    if count > 1000:
        raise ValueError('Too many image frames')
    pixels = 0
    for frame in range(count):
        image.seek(frame)
        pixels += image.width * image.height
        if pixels > 150_000_000:
            raise ValueError('Image exceeds pixel limit')
        oriented = ImageOps.exif_transpose(image).convert('RGBA')
        page = Image.new('RGB', oriented.size, 'white')
        page.paste(oriented, mask=oriented.getchannel('A'))
        path = str(Path(target).with_name(f'frame-{frame}.png'))
        page.save(path, 'PNG', dpi=image.info.get('dpi', (150, 150)))
        frames.append(path)
with open(target, 'wb') as output:
    output.write(img2pdf.convert(*frames))

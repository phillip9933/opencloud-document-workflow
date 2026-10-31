#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
from pathlib import Path
import shutil
root=Path(__file__).resolve().parents[1]
source=root/'node_modules/pdfjs-dist'
target=root/'public/pdf-assets'
target.mkdir(parents=True,exist_ok=True)
for name in ('cmaps','standard_fonts','wasm'):
    shutil.copytree(source/name,target/name,dirs_exist_ok=True)
shutil.copy2(source/'LICENSE',target/'LICENSE-pdfjs.txt')
print('Prepared local PDF.js fonts, CMaps, codecs and licenses')

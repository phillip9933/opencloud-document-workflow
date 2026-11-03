# SPDX-License-Identifier: AGPL-3.0-only
"""Rebuild the synthetic sparse-text-over-scan fixture with Poppler only."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as temporary:
    prefix = Path(temporary) / 'scan'
    subprocess.run(['pdfimages', '-f', '1', '-l', '1', '-j', str(root / 'scanned-english.pdf'), str(prefix)], check=True)
    image = prefix.with_name('scan-000.jpg').read_bytes()
    info = subprocess.check_output(['pdfimages', '-list', str(root / 'scanned-english.pdf')], text=True).splitlines()[2].split()
    width, height = int(info[3]), int(info[4])
    content = b'q 595.2 0 0 841.92 0 0 cm /Im1 Do Q\nBT /F1 10 Tf 30 25 Td (Embedded reference: SYNTH-17) Tj ET\n'
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.2 841.92] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 6 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               f'<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(image)} >>\nstream\n'.encode() + image + b'\nendstream',
               f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'endstream']
    pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(pdf)); pdf.extend(f'{number} 0 obj\n'.encode() + value + b'\nendobj\n')
    xref = len(pdf)
    pdf.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        pdf.extend(f'{offset:010d} 00000 n \n'.encode())
    pdf.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    (root / 'hybrid-english.pdf').write_bytes(pdf)

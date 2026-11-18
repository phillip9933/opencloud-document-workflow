# SPDX-License-Identifier: AGPL-3.0-only
"""Positive source and build inventories for release packaging."""
import hashlib
import json
import subprocess
from pathlib import Path

MANIFEST = 'source-files.json'
GENERATED = {'docs/dependencies.cdx.json', 'THIRD_PARTY_NOTICES.md', 'LICENSES/DEPENDENCIES.txt'}

def regular(root, name):
    if root.is_symlink():
        raise ValueError(f'Linked package root: {root.name}')
    rel = Path(name)
    if rel.is_absolute() or '..' in rel.parts or not rel.parts:
        raise ValueError('Invalid package path')
    path = root
    for part in rel.parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f'Package input is a symlink: {rel}')
    if not path.is_file():
        raise ValueError(f'Missing package input: {rel}')
    return path

def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def source_files(root):
    """Use committed paths, or the checksum inventory in a distributed source kit."""
    if not (root/'.git').exists():
        inventory = json.loads(regular(root, MANIFEST).read_text())
        for name, expected in inventory.items():
            if checksum(regular(root, name)) != expected:
                raise ValueError(f'Source checksum mismatch: {name}')
        return sorted(inventory)
    entries = subprocess.check_output(['git','ls-tree','-rz','HEAD'], cwd=root)
    names = []
    for entry in entries.split(b'\0'):
        if not entry:
            continue
        meta, name = entry.split(b'\t',1)
        mode, kind, blob = meta.split()
        name = name.decode()
        if kind != b'blob' or mode not in (b'100644', b'100755'):
            raise ValueError(f'Unsupported Git entry: {name}')
        path = regular(root, name)
        if name not in GENERATED:
            data = path.read_bytes()
            if hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest() != blob.decode():
                raise ValueError(f'Commit source changes before packaging: {name}')
        names.append(name)
    return names

def seal(root, name=MANIFEST):
    files = {str(p.relative_to(root)): checksum(regular(root, p.relative_to(root)))
             for p in sorted(root.rglob('*')) if p.is_file() and p != root/name}
    (root/name).write_text(json.dumps(files, indent=2)+'\n')

def build_files(root, directory):
    output = root/directory
    inventory = json.loads(regular(root, f'artifacts/{directory}-files.json').read_text())
    names = set(inventory)
    if directory == 'dist':
        names.add('manifest.json')
    pdf = (root/'node_modules/pdfjs-dist').resolve()
    for folder in ('cmaps','standard_fonts','wasm'):
        for path in (pdf/folder).iterdir():
            rel = path.relative_to(pdf)
            original = regular(pdf, rel)
            name = str(Path('pdf-assets')/rel)
            if checksum(regular(output, name)) != checksum(original):
                raise ValueError(f'PDF asset differs from installed dependency: {name}')
            names.add(name)
    license_name = 'pdf-assets/LICENSE-pdfjs.txt'
    if checksum(regular(output, license_name)) != checksum(regular(pdf,'LICENSE')):
        raise ValueError('Unexpected PDF license')
    names.add(license_name)
    return [regular(output, name) for name in sorted(names)]

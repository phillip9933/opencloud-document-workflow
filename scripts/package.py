#!/usr/bin/env python3
"""SPDX-License-Identifier: AGPL-3.0-only"""
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
manifest_path = root / 'dist/manifest.json'
manifest = json.loads(manifest_path.read_text())
entry = manifest['entrypoint']
if not entry.startswith('js/') or '..' in Path(entry).parts or not (root / 'dist' / entry).is_file():
    raise SystemExit('Missing or unsafe build entrypoint')
if list((root / 'dist/js').glob('vue-router-*.mjs')):
    raise SystemExit('Native build bundled a private router; use host router/components')
app_id = 'document-workflow'
app = json.loads((root / 'package.json').read_text())
if manifest['version'] != app['version']:
    raise SystemExit('Build is stale: version mismatch')
out = root / 'artifacts'
out.mkdir(exist_ok=True)
archive = out / f'{app_id}-{app["version"]}-local.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for path in sorted((root / 'dist').rglob('*')):
        if path.is_file():
            z.write(path, f'{app_id}/{path.relative_to(root / "dist")}')
    for name in ('LICENSE', 'LICENSES/Apache-2.0-skeleton.txt', 'LICENSES/DEPENDENCIES.txt', 'THIRD_PARTY_NOTICES.md', 'docs/dependencies.cdx.json', 'docs/LOCAL_BUILD.md'):
        z.write(root / name, f'{app_id}/{name}')
with zipfile.ZipFile(archive) as z:
    if any(not n.startswith(app_id + '/') for n in z.namelist()):
        raise SystemExit('Invalid app package layout')
print(f'Created {archive} (local review only; compatibility acceptance pending)')

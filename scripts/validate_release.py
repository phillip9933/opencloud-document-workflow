#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Verify the local publication candidate without uploading files or documents."""
import hashlib,json,tarfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text())['version']
out=root/'artifacts/releases'/version
with zipfile.ZipFile(out/f'document-workflow-{version}.zip') as archive:
    names=archive.namelist();assert 'manifest.json' in names
    assert all(not Path(name).is_absolute() and '..' not in Path(name).parts for name in names)
    manifest=json.loads(archive.read('manifest.json'));assert manifest['version']==version
    assert manifest['entrypoint'] in names
    public={name:hashlib.sha256(archive.read(name)).hexdigest() for name in names if not name.endswith('/')}
with zipfile.ZipFile(root/f'artifacts/document-workflow-{version}-local.zip') as archive:
    internal={name.removeprefix('document-workflow/'):hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist() if not name.endswith('/')}
assert public==internal,'Public and installer frontend bytes differ'
with tarfile.open(out/f'document-workflow-{version}-install.tar.gz') as archive:
    members=archive.getmembers()
    assert all(m.name.startswith('document-workflow') and '..' not in Path(m.name).parts and not Path(m.name).is_absolute() and not m.issym() and not m.islnk() for m in members)
    data={m.name.removeprefix('document-workflow/'):archive.extractfile(m).read() for m in members if m.isfile()}
    assert data['VERSION'].decode().strip()==version
    for line in data['SHA256SUMS'].decode().splitlines():
        digest,name=line.split('  ',1);assert hashlib.sha256(data[name]).hexdigest()==digest,name
    forbidden={'.env','.sqlite3','.pem','.key'}
    assert not any(Path(name).name=='.env' or Path(name).suffix in forbidden or 'companion/state/' in name or '/credentials/' in name or '/backups/' in name for name in data)
for line in (out/'SHA256SUMS').read_text().splitlines():
    digest,name=line.split('  ',1);assert hashlib.sha256((out/name).read_bytes()).hexdigest()==digest,name
print(f'{version}: store manifest/entrypoint, identical frontend bytes, internal kit hashes and public checksums verified. Nothing published.')

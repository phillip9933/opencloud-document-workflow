#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Package a standalone build with resolved runtime modules, source and licenses."""
import hashlib,json,shutil,stat,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
stage=root/'artifacts/draft-stage'
# Rebuild only this script-owned staging directory, never state or user inputs.
if stage.exists():
    if not (stage/'.workflow-package-stage').exists():raise SystemExit('Refusing to replace unmarked staging directory')
    shutil.rmtree(stage)
stage.mkdir(parents=True)
(stage/'.workflow-package-stage').write_text('Generated packaging stage, no user data\n')
for folder in ('companion','src/domain','tests/fixtures','draft-dist','LICENSES'):
    source=root/folder
    if folder=='companion':
        for file in source.iterdir():
            if file.is_file() and (file.suffix in ('.mjs','.md','.py') or file.name=='ocr-catalog.json'):
                target=stage/folder/file.name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
    elif folder=='src/domain':
        for file in source.rglob('*'):
            if file.is_file():
                target=stage/folder/file.relative_to(source);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
    else:shutil.copytree(source,stage/folder,dirs_exist_ok=True,ignore=shutil.ignore_patterns('scroll-harness.html'))
for name in ('LICENSE','THIRD_PARTY_NOTICES.md'):
    shutil.copy2(root/name,stage/name)
for name in ('LIVE_TESTING.md','dependencies.cdx.json'):
    target=stage/'docs'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/'docs'/name,target)
# Keep corresponding application source/build instructions with the private draft.
for folder in ('src','companion','scripts','tests','preview','docs','LICENSES','deploy'):
    for file in (root/folder).rglob('*'):
        if not file.is_file() or (folder=='companion' and 'state' in file.relative_to(root/folder).parts) or '__pycache__' in file.parts:
            continue
        if file.suffix in ('.sqlite3','.pyc') or file.name.endswith(('-wal','-shm')):
            continue
        target=stage/'source'/file.relative_to(root)
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
for name in ('package.json','pnpm-lock.yaml','tsconfig.json','tsconfig.companion.json','eslint.config.mjs','.prettierrc.json','.prettierignore','vite.config.ts','preview.vite.config.ts','draft.vite.config.ts','README.md','LICENSE','THIRD_PARTY_NOTICES.md'):
    shutil.copy2(root/name,stage/'source'/name)
version=json.loads((root/'package.json').read_text())['version']
seen={}
def include_package(package):
    package=package.resolve();meta=json.loads((package/'package.json').read_text());name,version=meta['name'],meta['version']
    if name in seen:
        if seen[name]!=version:raise SystemExit('Runtime version conflict: '+name)
        return
    seen[name]=version
    shutil.copytree(package,stage/'node_modules'/name,symlinks=False,ignore=shutil.ignore_patterns('node_modules'),dirs_exist_ok=True)
    for dep in meta.get('dependencies',{}):
        candidates=[parent/dep for parent in package.parents if parent.name=='node_modules']+[root/'node_modules'/dep]
        resolved=next((p for p in candidates if (p/'package.json').is_file()),None)
        if resolved is None:raise SystemExit('Missing resolved runtime package: '+dep)
        include_package(resolved)
include_package(root/'node_modules/fast-xml-parser')
(stage/'package.json').write_text(json.dumps({'name':'opencloud-document-workflow-companion','version':version,'type':'module','private':True,'license':'AGPL-3.0-only','engines':{'node':'>=22.18.0'},'scripts':{'start':'node companion/server.mjs'},'dependencies':{'fast-xml-parser':seen['fast-xml-parser']}},indent=2)+'\n')
(stage/'runtime-versions.json').write_text(json.dumps(seen,indent=2)+'\n')
archive=root/f'artifacts/document-workflow-{version}-draft-local.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for path in sorted(stage.rglob('*')):
        if path.is_file():z.write(path,'document-workflow-first-draft/'+str(path.relative_to(stage)))
print('Packaged local standalone draft with',len(seen),'resolved runtime packages:',archive)
print('SHA256',hashlib.sha256(archive.read_bytes()).hexdigest())

#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Package a standalone build with resolved runtime modules, source and licenses."""
import hashlib,json,shutil,stat,zipfile
from pathlib import Path
from package_inputs import source_files, build_files, seal, regular
root=Path(__file__).resolve().parents[1]
stage=root/'artifacts/draft-stage'
# Rebuild only this script-owned staging directory, never state or user inputs.
if stage.exists():
    if not (stage/'.workflow-package-stage').exists():raise SystemExit('Refusing to replace unmarked staging directory')
    shutil.rmtree(stage)
stage.mkdir(parents=True)
(stage/'.workflow-package-stage').write_text('Generated packaging stage, no user data\n')
source_roots = {'src','companion','scripts','tests','preview','docs','LICENSES','deploy','patches'}
source_configs = {'.dockerignore','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','tsconfig.companion.json','eslint.config.mjs','.prettierrc.json','.prettierignore','vite.config.ts','preview.vite.config.ts','draft.vite.config.ts','build-inventory.ts','README.md','LICENSE','THIRD_PARTY_NOTICES.md'}
def copy(file, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file,target)
for name in source_files(root):
    rel = Path(name)
    if rel.parts[0] not in source_roots and name not in source_configs:
        continue
    file = regular(root,name)
    copy(file,stage/'source'/rel)
    if (rel.parts[:1]==('companion',) and (rel.suffix in ('.mjs','.md','.py') or rel.name=='ocr-catalog.json')
        or rel.parts[:2] in (('src','domain'),('tests','fixtures')) or rel.parts[0]=='LICENSES'
        or name in ('LICENSE','THIRD_PARTY_NOTICES.md','docs/LIVE_TESTING.md','docs/dependencies.cdx.json')):
        copy(file,stage/rel)
for file in build_files(root,'draft-dist'):
    copy(file,stage/file.relative_to(root))
seal(stage/'source')
version=json.loads((root/'package.json').read_text())['version']
seen={}
def include_package(package):
    package=package.resolve();meta=json.loads((package/'package.json').read_text());name,version=meta['name'],meta['version']
    if name in seen:
        if seen[name]!=version:raise SystemExit('Runtime version conflict: '+name)
        return
    seen[name]=version
    if not package.is_relative_to((root/'node_modules').resolve()):
        raise ValueError('Runtime package outside dependency directory')
    for file in package.rglob('*'):
        rel=file.relative_to(package)
        if 'node_modules' in rel.parts: continue
        if file.is_symlink(): raise ValueError(f'Linked runtime dependency file: {rel}')
        if file.is_file():
            copy(regular(package,rel),stage/'node_modules'/name/rel)
    for dep in meta.get('dependencies',{}):
        candidates=[parent/dep for parent in package.parents if parent.name=='node_modules']+[root/'node_modules'/dep]
        resolved=next((p for p in candidates if (p/'package.json').is_file()),None)
        if resolved is None:raise SystemExit('Missing resolved runtime package: '+dep)
        include_package(resolved)
include_package(root/'node_modules/fast-xml-parser')
(stage/'package.json').write_text(json.dumps({'name':'opencloud-document-workflow-companion','version':version,'type':'module','private':True,'license':'AGPL-3.0-only','engines':{'node':'>=22.18.0'},'scripts':{'start':'node companion/server.mjs'},'dependencies':{'fast-xml-parser':seen['fast-xml-parser']}},indent=2)+'\n')
(stage/'runtime-versions.json').write_text(json.dumps(seen,indent=2)+'\n')
seal(stage,'.workflow-stage-files.json')
archive=root/f'artifacts/document-workflow-{version}-draft-local.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for path in sorted(stage.rglob('*')):
        if path.is_file():z.write(path,'document-workflow-first-draft/'+str(path.relative_to(stage)))
print('Packaged local standalone draft with',len(seen),'resolved runtime packages:',archive)
print('SHA256',hashlib.sha256(archive.read_bytes()).hexdigest())

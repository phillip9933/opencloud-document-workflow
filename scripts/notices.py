#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Collect dependency license/notice texts and source references from locked packages."""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
items={}
for manifest in sorted((root/'node_modules/.pnpm').glob('*/node_modules/**/package.json')):
 if len(manifest.relative_to(root/'node_modules/.pnpm').parts) not in (4,5):continue
 meta=json.loads(manifest.read_text());name=meta.get('name');version=meta.get('version')
 if not name or not version:continue
 key=f'{name}@{version}';directory=manifest.parent
 texts=[]
 for file in sorted(directory.iterdir()):
  if file.is_file() and file.name.lower().startswith(('license','licence','copying','notice')):
   texts.append(f'--- {file.name} ---\n'+file.read_text(errors='replace'))
 repository=meta.get('repository',{});repository=repository.get('url','') if isinstance(repository,dict) else repository
 items[key]=f'\n{"="*72}\n{key}\nDeclared license: {meta.get("license","See upstream package")}\nSource: {repository or "https://www.npmjs.com/package/"+name+"/v/"+version}\n'+('\n'.join(texts) or 'No top-level license text in distributed package; consult the source and declared license above.')+'\n'
assert items
(root/'LICENSES/DEPENDENCIES.txt').write_text('Third-party dependency license texts and source references.\nGenerated from the locked installed packages; original terms apply.\n'+''.join(items[k] for k in sorted(items)))
print('Collected notices for',len(items),'packages')

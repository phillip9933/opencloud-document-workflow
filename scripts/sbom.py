#!/usr/bin/env python3
"""SPDX-License-Identifier: AGPL-3.0-only
Generate a CycloneDX inventory of installed development and shared-runtime dependencies.
This inventories local package metadata, not a legal compatibility certification.
"""
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

root = Path(__file__).resolve().parents[1]
components = {}
store = root / 'node_modules/.pnpm'
for pattern in ('*/node_modules/*/package.json', '*/node_modules/@*/*/package.json'):
    for manifest in sorted(store.glob(pattern)):
        data = json.loads(manifest.read_text())
        name, version = data.get('name'), data.get('version')
        if not name or not version:
            continue
        purl = f'pkg:npm/{quote(name, safe="/@")}@{quote(version, safe="")}'
        component = {
            'type': 'library', 'bom-ref': purl, 'name': name, 'version': version,
            'purl': purl, 'hashes': [{'alg': 'SHA-256', 'content': hashlib.sha256(manifest.read_bytes()).hexdigest()}],
            'properties': [{'name': 'document-workflow:inventory-role', 'value': 'development-or-host-shared-runtime'}]
        }
        license_value = data.get('license')
        if isinstance(license_value, dict):
            license_value = license_value.get('type')
        if isinstance(license_value, str):
            component['licenses'] = [{'license': {'name': license_value}}]
        components[purl] = component
if not components:
    raise SystemExit('Install locked dependencies before generating the SBOM')
app = json.loads((root / 'package.json').read_text())
output = {
    'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'version': 1,
    'metadata': {'component': {'type': 'application', 'name': app['name'], 'version': app['version']},
                 'properties': [{'name': 'document-workflow:inventory-limit', 'value': 'Installed package inventory; includes development tools and host-shared modules. No vulnerability assessment or transitive license certification.'}]},
    'components': [components[key] for key in sorted(components)]
}
(root / 'docs/dependencies.cdx.json').write_text(json.dumps(output, indent=2) + '\n')
print(f'Inventoried {len(components)} unique installed package versions')

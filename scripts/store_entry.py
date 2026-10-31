#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Render a catalogue contribution only after the operator chooses real release URLs."""
import argparse,json
from pathlib import Path
from urllib.parse import urlsplit
def public_url(value):
    p=urlsplit(value)
    if p.scheme!='https' or not p.hostname or p.username or p.password or p.query or p.fragment or p.hostname.endswith(('.invalid','.test','.localhost')) or p.hostname in ['localhost','example.com','example.org','example.net']:
        raise ValueError('Use an actual public HTTPS release/source URL without credentials or query')
    return value.rstrip('/')
def render(template,release_base,source):
    release_base=public_url(release_base);source=public_url(source)
    entry=json.loads(json.dumps(template).replace('RELEASE_BASE_URL',release_base).replace('SOURCE_URL',source))
    return entry
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--release-base-url',required=True);parser.add_argument('--source-url',required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    entry=render(json.loads((root/'deploy/store-entry.template.json').read_text()),args.release_base_url,args.source_url)
    assert entry['versions'][0]['version']==json.loads((root/'package.json').read_text())['version']
    with args.output.open('x') as f:f.write(json.dumps(entry,indent=2)+'\n')
    print('Prepared catalogue entry; URLs must be checked after release upload. Nothing was published.')

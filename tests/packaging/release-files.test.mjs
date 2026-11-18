// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

test('publication refuses unknown files, links and incomplete release layouts', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      `
from pathlib import Path
from tempfile import TemporaryDirectory
from scripts.release_files import check_directory,deliverables
with TemporaryDirectory() as tmp:
    root=Path(tmp)
    def rejected(**kwargs):
        try: check_directory(root,'1.0.0',**kwargs)
        except ValueError: return
        raise AssertionError('Unsafe or incomplete release accepted')
    rejected(complete=True)
    for name in deliverables('1.0.0')|{'BUILD-RECEIPT.json','SHA256SUMS'}: (root/name).touch()
    check_directory(root,'1.0.0',complete=True)
    extra=root/'local-notes.txt'
    extra.touch()
    rejected()
    extra.unlink()
    (root/'cover.svg').unlink()
    (root/'cover.svg').symlink_to('SHA256SUMS')
    rejected()
print('verified')
`
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.trim(), 'verified')
})

test('source distributions ignore unlisted files and reject linked or changed inputs', () => {
  execFileSync('python3', [
    '-c',
    `
from tempfile import TemporaryDirectory
from pathlib import Path
from scripts.package_inputs import source_files,seal
with TemporaryDirectory() as tmp:
    p=Path(tmp)
    (p/'shared').write_text('fixture')
    seal(p)
    (p/'local-note').write_text('local only')
    assert source_files(p)==['shared']
    (p/'shared').unlink()
    (p/'shared').symlink_to('local-note')
    try: source_files(p)
    except ValueError: pass
    else: raise AssertionError('Linked source accepted')
    (p/'shared').unlink()
    (p/'shared').write_text('changed')
    try: source_files(p)
    except ValueError: pass
    else: raise AssertionError('Changed source accepted')
`
  ])
})

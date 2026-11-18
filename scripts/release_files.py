# SPDX-License-Identifier: AGPL-3.0-only
"""The allowed contents of a single public release directory."""
from pathlib import Path

ACCEPTANCE = {'INSTALL-ACCEPTANCE.txt', 'IMAGE-IDS.txt', 'UPGRADE-ACCEPTANCE.txt'}


def deliverables(version):
    prefix = f'document-workflow-{version}'
    return {prefix + extension for extension in ('.zip', '-install.tar.gz', '-screenshots.zip', '-companion-source.zip')} | {
        'INSTALLATION.md', 'QUICK_INSTALL.md', 'STORE_PACKAGING.md',
        'cover.svg', 'RELEASE_NOTES.md', 'store-entry.template.json'
    }


def check_directory(directory: Path, version, *, complete=False, acceptance=False):
    expected = deliverables(version) | {'SHA256SUMS', 'BUILD-RECEIPT.json'}
    allowed = expected | (ACCEPTANCE if acceptance else set())
    files = set()
    for entry in directory.iterdir():
        if entry.is_symlink() or not entry.is_file() or entry.name not in allowed:
            raise ValueError(f'Unexpected release entry: {entry.name}. Build into a clean directory.')
        files.add(entry.name)
    if complete and not expected <= files:
        raise ValueError('Incomplete public release directory')
    return files

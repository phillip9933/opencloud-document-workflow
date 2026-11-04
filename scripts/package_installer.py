#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Build a self-contained installation kit without touching a host."""
import hashlib,json,shutil,stat,tarfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text())['version']
artifacts=root/'artifacts'
native=artifacts/f'document-workflow-{version}-local.zip'
stage=artifacts/'installer-stage'
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def extract_web(archive,target):
    files={}
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            p=Path(info.filename)
            assert p.parts[0]=='document-workflow' and '..' not in p.parts and not p.is_absolute() and not stat.S_ISLNK(info.external_attr>>16)
            if info.is_dir():continue
            name=str(Path(*p.parts[1:]));data=z.read(info);files[name]=hashlib.sha256(data).hexdigest()
            if target:
                out=target/name;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data);out.chmod(0o644)
    return files
if stage.exists():
    assert (stage/'.workflow-installer-stage').is_file(),'Refusing an unmarked installer directory'
    shutil.rmtree(stage)
stage.mkdir();(stage/'.workflow-installer-stage').write_text('Generated release packaging; no user data\n')
web=artifacts/'native-web'
if web.exists():
    assert (web/'manifest.json').is_file()
    shutil.rmtree(web)
files=extract_web(native,web)
assert json.loads((web/'manifest.json').read_text())['version']==version
release={'schemaVersion':1,'appId':'document-workflow','version':version,'apiVersion':1,'minOpenCloud':'9.0.0','nativeSHA256':digest(native),'files':files}
(artifacts/'release.json').write_text(json.dumps(release,indent=2)+'\n')
# The accepted public-file inventory is checked into source, so rebuilding the kit
# does not require the previous private release ZIP or a running installation.
known=json.loads((root/'deploy/installer/known-web-releases.json').read_text())
assert all(r['appId']=='document-workflow' and r['files'].get('manifest.json') for r in known)
(artifacts/'known-web-releases.json').write_text(json.dumps(known,indent=2)+'\n')
image=stage/'image'
for folder in ['draft-stage','native-web']:
    shutil.copytree(artifacts/folder,image/'artifacts'/folder)
runtime=image/'artifacts/draft-stage'
source=runtime/'source'
shutil.copy2(root/'.dockerignore',source/'.dockerignore')
# Corresponding application/build/test source stays included; deployment-specific
# acceptance scripts and history do not belong in a generic installation image.
for name in ['docs','deploy','scripts']:
    shutil.rmtree(source/name)
for name in ['container','installer']:
    shutil.copytree(root/'deploy'/name,source/'deploy'/name)
shutil.copytree(root/'deploy/screenshots',source/'deploy/screenshots')
for name in ['cover.svg','store-entry.template.json']:
    shutil.copy2(root/'deploy'/name,source/'deploy'/name)
for name in ['package.py','package_draft.py','package_installer.py','store_entry.py','sbom.py','pdf_assets.py','notices.py','validate_release.py','accept_fresh_install.sh','accept_upgrade.sh']:
    target=source/'scripts'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/'scripts'/name,target)
for name in ['ARCHITECTURE.md','PROCESSING_SAFETY.md','LOCAL_BUILD.md','INSTALLATION.md','QUICK_INSTALL.md','STORE_PACKAGING.md',f'RELEASE_NOTES_{version}.md',f'ACCEPTANCE_{version}.md','dependencies.cdx.json']:
    target=source/'docs'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/'docs'/name,target)
generic_readme='# Document Workflow\n\nSee docs/QUICK_INSTALL.md for installation, docs/LOCAL_BUILD.md for source builds, and docs/STORE_PACKAGING.md for distribution boundaries.\n'
(source/'README.md').write_text(generic_readme)
demo_guide='# Local synthetic testing\n\nRun Node with WORKFLOW_MODE=demo for an isolated synthetic journal. See docs/LOCAL_BUILD.md and docs/QUICK_INSTALL.md. No live OpenCloud document or credential is packaged.\n'
(source/'docs/LIVE_TESTING.md').write_text(demo_guide)
(runtime/'docs/LIVE_TESTING.md').write_text(demo_guide)
for name in ['release.json','known-web-releases.json',native.name]:
    shutil.copy2(artifacts/name,image/'artifacts'/name)
for file in (root/'deploy/installer').glob('*.mjs'):
    target=image/'deploy/installer'/file.name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
target=image/'deploy/container/Dockerfile';target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/'deploy/container/Dockerfile',target)
shutil.copy2(target,image/'Dockerfile')
shutil.copy2(root/'.dockerignore',image/'.dockerignore')
shutil.copy2(root/'deploy/installer/install.sh',stage/'install.sh');(stage/'install.sh').chmod(0o755)
shutil.copy2(root/'docs/QUICK_INSTALL.md',stage/'README.md')
shutil.copy2(root/'LICENSE',stage/'LICENSE')
shutil.copy2(root/'THIRD_PARTY_NOTICES.md',stage/'THIRD_PARTY_NOTICES.md')
shutil.copy2(root/'deploy/store-entry.template.json',stage/'store-entry.template.json')
(stage/'VERSION').write_text(version+'\n')
(stage/'RELEASE.json').write_text(json.dumps({key:release[key] for key in ['schemaVersion','appId','version','apiVersion','minOpenCloud','nativeSHA256']},indent=2)+'\n')
paths=sorted(p for p in stage.rglob('*') if p.is_file())
(stage/'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.relative_to(stage)}\n' for p in paths))
out=artifacts/'releases'/version;out.mkdir(parents=True,exist_ok=True)
web_out=out/f'document-workflow-{version}.zip'
# The catalogue ZIP has manifest.json at its root, as required by the store.
# The coordinated installer retains its internal app-directory archive.
with zipfile.ZipFile(web_out,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(web.rglob('*')):
        if p.is_file():z.write(p,str(p.relative_to(web)))
bundle=out/f'document-workflow-{version}-install.tar.gz'
with tarfile.open(bundle,'w:gz') as tar:tar.add(stage,arcname='document-workflow')
source_archive=out/f'document-workflow-{version}-companion-source.zip'
with zipfile.ZipFile(source_archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(source.rglob('*')):
        if p.is_file():z.write(p,'document-workflow-source/'+str(p.relative_to(source)))
shutil.copy2(root/'deploy/cover.svg',out/'cover.svg')
with zipfile.ZipFile(out/f'document-workflow-{version}-screenshots.zip','w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted((root/'deploy/screenshots').iterdir()):
        if p.is_file():z.write(p,'screenshots/'+p.name)
shutil.copy2(root/f'docs/RELEASE_NOTES_{version}.md',out/'RELEASE_NOTES.md')
for name in ['INSTALLATION.md','QUICK_INSTALL.md','STORE_PACKAGING.md']:
    shutil.copy2(root/'docs'/name,out/name)
shutil.copy2(root/'deploy/store-entry.template.json',out/'store-entry.template.json')
publish_files=[p for p in sorted(out.iterdir()) if p.is_file() and p.name not in ['SHA256SUMS','BUILD-RECEIPT.json']]
(out/'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in publish_files))
receipt={'version':version,'releaseChannel':json.loads((root/'package.json').read_text()).get('releaseChannel','development'),'publiclyPublished':False,'minimumAcceptedBaseline':'OpenCloud 9 / SDK 8.2.1; exact-release isolated image acceptance recorded separately','files':{p.name:digest(p) for p in publish_files},'installerFileCount':len(paths),'hostRequirements':['Bash','Docker','Docker Compose v2','sha256sum'],'bundledTools':['Node22','SQLite','Poppler','Tesseract','English/Japanese OCR packs','PDF preview assets'],'storeHooks':'Standard web ZIP plus installation resource link; no server execution hook in current catalogue'}
(out/'BUILD-RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n')
print('Created coordinated installation kit:',bundle)
print('SHA256',digest(bundle))

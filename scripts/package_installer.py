#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Build a self-contained installation kit without touching a host."""
import hashlib,json,shutil,stat,tarfile,zipfile
from pathlib import Path
from package_inputs import regular, checksum, seal
from release_files import check_directory, deliverables
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
runtime=image/'artifacts/draft-stage'
draft=artifacts/'draft-stage'
for name,expected in json.loads(regular(draft,'.workflow-stage-files.json').read_text()).items():
    file=regular(draft,name)
    if checksum(file)!=expected: raise ValueError('Draft input changed: '+name)
    target=runtime/name
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(file,target)
shutil.copytree(web,image/'artifacts/native-web')
source=runtime/'source'
selected_scripts={'package_inputs.py','release_files.py','package.py','package_draft.py','package_installer.py','store_entry.py','sbom.py','pdf_assets.py','notices.py','validate_release.py','accept_fresh_install.sh','accept_upgrade.sh'}
selected_docs={'ARCHITECTURE.md','PROCESSING_SAFETY.md','LOCAL_BUILD.md','INSTALLATION.md','QUICK_INSTALL.md','STORE_PACKAGING.md',f'RELEASE_NOTES_{version}.md',f'ACCEPTANCE_{version}.md','dependencies.cdx.json'}
for folder,keep in [('scripts',selected_scripts),('docs',selected_docs),('deploy',{'container','installer','screenshots','cover.svg','store-entry.template.json'})]:
    for entry in (source/folder).iterdir():
        if entry.name not in keep:
            if entry.is_dir(): shutil.rmtree(entry)
            else: entry.unlink()
generic_readme='# Document Workflow\n\nSee docs/QUICK_INSTALL.md for installation, docs/LOCAL_BUILD.md for source builds, and docs/STORE_PACKAGING.md for distribution boundaries.\n'
(source/'README.md').write_text(generic_readme)
demo_guide='# Local synthetic testing\n\nRun Node with WORKFLOW_MODE=demo for an isolated synthetic journal. See docs/LOCAL_BUILD.md and docs/QUICK_INSTALL.md. No live OpenCloud document or credential is packaged.\n'
(source/'docs/LIVE_TESTING.md').write_text(demo_guide)
(runtime/'docs/LIVE_TESTING.md').write_text(demo_guide)
seal(source)
for name in ['release.json','known-web-releases.json',native.name]:
    shutil.copy2(artifacts/name,image/'artifacts'/name)
for file in (source/'deploy/installer').glob('*.mjs'):
    target=image/'deploy/installer'/file.name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
target=image/'deploy/container/Dockerfile';target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/'deploy/container/Dockerfile',target)
shutil.copy2(target,image/'Dockerfile')
shutil.copy2(source/'.dockerignore',image/'.dockerignore')
shutil.copy2(source/'deploy/installer/install.sh',stage/'install.sh');(stage/'install.sh').chmod(0o755)
shutil.copy2(source/'docs/QUICK_INSTALL.md',stage/'README.md')
shutil.copy2(source/'LICENSE',stage/'LICENSE')
shutil.copy2(source/'THIRD_PARTY_NOTICES.md',stage/'THIRD_PARTY_NOTICES.md')
shutil.copy2(source/'deploy/store-entry.template.json',stage/'store-entry.template.json')
(stage/'VERSION').write_text(version+'\n')
(stage/'RELEASE.json').write_text(json.dumps({key:release[key] for key in ['schemaVersion','appId','version','apiVersion','minOpenCloud','nativeSHA256']},indent=2)+'\n')
# Bind executable files in the selected image to the verified kit. Source-only
# material is excluded because the registry and installer include different docs.
runtime_files = {}
for public, directory in [('/app', runtime), ('/distribution/web', web)]:
    for file in directory.rglob('*'):
        rel = file.relative_to(directory)
        if file.is_file() and rel.parts[0] not in ('source', 'docs'):
            runtime_files[public + '/' + rel.as_posix()] = digest(file)
for file in (source/'deploy/installer').glob('*.mjs'):
    runtime_files['/distribution/' + file.name] = digest(file)
for name in ('Dockerfile','known-web-releases.json'):
    runtime_files['/distribution/' + name] = digest(image/'Dockerfile' if name=='Dockerfile' else artifacts/name)
(stage/'RUNTIME-SHA256SUMS').write_text(''.join(f'{runtime_files[path]}  {path}\n' for path in sorted(runtime_files)))
paths=sorted(p for p in stage.rglob('*') if p.is_file())
(stage/'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.relative_to(stage)}\n' for p in paths))
out=artifacts/'releases'/version;out.mkdir(parents=True,exist_ok=True)
check_directory(out, version)
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
shutil.copy2(source/'deploy/cover.svg',out/'cover.svg')
with zipfile.ZipFile(out/f'document-workflow-{version}-screenshots.zip','w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted((source/'deploy/screenshots').iterdir()):
        if p.is_file():z.write(p,'screenshots/'+p.name)
shutil.copy2(source/f'docs/RELEASE_NOTES_{version}.md',out/'RELEASE_NOTES.md')
for name in ['INSTALLATION.md','QUICK_INSTALL.md','STORE_PACKAGING.md']:
    shutil.copy2(source/'docs'/name,out/name)
shutil.copy2(source/'deploy/store-entry.template.json',out/'store-entry.template.json')
publish_files=[out/name for name in sorted(deliverables(version))]
(out/'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in publish_files))
receipt={'version':version,'releaseChannel':json.loads((root/'package.json').read_text()).get('releaseChannel','development'),'publiclyPublished':False,'minimumAcceptedBaseline':'OpenCloud 9 / SDK 8.2.1; exact-release isolated image acceptance recorded separately','files':{p.name:digest(p) for p in publish_files},'installerFileCount':len(paths),'hostRequirements':['Bash','Docker','Docker Compose v2','sha256sum'],'bundledTools':['Node22','SQLite','Poppler','Tesseract','English/Japanese OCR packs','PDF preview assets'],'storeHooks':'Standard web ZIP plus installation resource link; no server execution hook in current catalogue'}
(out/'BUILD-RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n')
print('Created coordinated installation kit:',bundle)
print('SHA256',digest(bundle))

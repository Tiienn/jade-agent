"""Build a self-contained Windows x64 pilot. Run with Python 3 and .NET 10 SDK."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]
ASSETS = {
    'cadcraft.zip': ('https://github.com/storytold/cadcraft/releases/download/v0.7.0/cadcraft-0.7.0-windows-x64-portable.zip', '1eebfb2f73ffdc0ead1313c1053de12ec26da6b2f4038bfe989ad51b34053c8a'),
    'python.zip': ('https://www.python.org/ftp/python/3.13.12/python-3.13.12-embed-amd64.zip', '76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0'),
}


def extract(archive, target, strip=False):
    with zipfile.ZipFile(archive) as z:
        for entry in z.infolist():
            parts = Path(entry.filename).parts[1:] if strip else Path(entry.filename).parts
            if not parts or entry.is_dir():
                continue
            dest = target.joinpath(*parts)
            if not dest.resolve().is_relative_to(target.resolve()):
                raise ValueError('Unsafe archive path')
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(entry))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--published', type=Path, help='Use an already published Windows build')
    args = parser.parse_args()
    cache = APP / '.cache'
    cache.mkdir(exist_ok=True)
    for name, (url, digest) in ASSETS.items():
        archive = cache / name
        if not archive.exists():
            print('Downloading', url, flush=True)
            urllib.request.urlretrieve(url, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            raise ValueError('Checksum mismatch for ' + name + '. Remove the cached file and retry.')
    artifacts = APP / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    out = artifacts / 'Jade Lease Studio'
    if out.exists():
        shutil.rmtree(out)
    if args.published:
        shutil.copytree(args.published, out)
    else:
        subprocess.run(['dotnet', 'publish', str(APP / 'JadeLeaseStudio.csproj'), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', str(out)], check=True)
    extract(cache / 'python.zip', out / 'runtime')
    extract(cache / 'cadcraft.zip', out / 'engine', strip=True)
    # Ship only the headless engine; users see our focused lease-plan interface.
    (out / 'engine' / 'cadcraft.exe').unlink()
    for dll in (out / 'runtime').glob('vcruntime*.dll'):
        shutil.copy2(dll, out / 'engine' / dll.name)
    (out / 'worker').mkdir()
    shutil.copy2(APP / 'worker' / 'studio_worker.py', out / 'worker')
    shutil.copy2(APP / 'worker' / 'studio_edits.py', out / 'worker')
    shutil.copytree(APP / 'ui', out / 'ui')
    shutil.copy2(REPO / 'scripts' / 'lease_plans' / 'cadcraft_bridge.py', out / 'worker')
    for name in ['THIRD-PARTY-NOTICES.txt', 'START HERE.txt', 'Uninstall Jade Lease Studio.cmd']:
        shutil.copy2(APP / 'packaging' / name, out)
    # NuGet runtime licence files are not automatically copied by dotnet publish.
    assets = json.loads((APP / 'obj' / 'project.assets.json').read_text())
    licenses = out / 'licenses'
    licenses.mkdir()
    for package, info in assets['libraries'].items():
        if info['type'] != 'package':
            continue
        for root in assets['packageFolders']:
            folder = Path(root) / info['path']
            if not folder.exists():
                continue
            for item in folder.iterdir():
                if item.is_file() and any(word in item.name.lower() for word in ['license', 'notice']):
                    shutil.copy2(item, licenses / (package.replace('/', '-') + '-' + item.name))
    # Runtime packs may be in downloadDependencies instead of the compile graph.
    for framework in ['microsoft.netcore.app.runtime.win-x64', 'microsoft.windowsdesktop.app.runtime.win-x64']:
        runtime_version = json.loads((out / 'JadeLeaseStudio.deps.json').read_text())['libraries']
        version = next(k.rsplit('/', 1)[1] for k in runtime_version if k.lower().startswith('runtimepack.' + framework + '/'))
        for root in assets['packageFolders']:
            folder = Path(root) / framework / version
            if folder.exists():
                for item in folder.iterdir():
                    if item.is_file() and any(word in item.name.lower() for word in ['license', 'notice']):
                        shutil.copy2(item, licenses / (framework + '-' + item.name))
    shutil.copy2(APP / 'packaging' / 'CADCRAFT-NOTICE.txt', out / 'engine' / 'NOTICE')
    manifest = {'product': 'Jade Lease Studio', 'version': '0.2.0', 'platform': 'windows-x64',
                'scope': 'Palm Square F18 pilot', 'dependencies': ASSETS,
                'files': {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in sorted(out.rglob('*')) if p.is_file()}}
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2))
    archive = Path(shutil.make_archive(str(artifacts / 'Jade-Lease-Studio-0.2.0-Windows-x64'), 'zip', artifacts, out.name))
    archive.with_suffix('.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
    print(archive)


if __name__ == '__main__':
    main()

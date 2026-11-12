#!/usr/bin/env python3
"""Install/remove the user's login helper without administrator privileges."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

LABEL = 'mu.jade.dot-cad-helper'
HOME = Path.home()
DEST = HOME / 'Applications' / 'Dot CAD Helper'
PLIST = HOME / 'Library' / 'LaunchAgents' / (LABEL + '.plist')
DOMAIN = f'gui/{os.getuid()}'

def main():
    os.umask(0o077)
    if '--disable' in sys.argv:
        subprocess.run(['launchctl', 'bootout', DOMAIN + '/' + LABEL], capture_output=True)
        PLIST.unlink(missing_ok=True)
        print('Automatic CAD helper disabled. Your saved drawings remain in Documents / Jade Lease Plans.')
        return
    if not Path('/Applications/CADCraft.app/Contents/MacOS/CADCraft').is_file():
        raise RuntimeError('Install CADCraft in Applications first.')
    source = Path(__file__).resolve().parent
    DEST.mkdir(parents=True, exist_ok=True)
    for name in ['cadcraft_bridge.py', 'install_helper.py', 'Enable Automatic Helper.command', 'Disable Automatic Helper.command', 'Start Dot CAD Helper.command', 'QUICK START.txt']:
        if source != DEST:
            shutil.copy2(source / name, DEST / name)
    logs = HOME / 'Library' / 'Logs' / 'Dot CAD Helper'
    logs.mkdir(parents=True, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    config = {'Label': LABEL, 'ProgramArguments': [sys.executable, str(DEST / 'cadcraft_bridge.py'), '--auto-pair'], 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15, 'ProcessType': 'Interactive', 'WorkingDirectory': str(DEST), 'StandardOutPath': str(logs / 'helper.log'), 'StandardErrorPath': str(logs / 'error.log')}
    subprocess.run(['launchctl', 'bootout', DOMAIN + '/' + LABEL], capture_output=True)
    PLIST.write_bytes(plistlib.dumps(config))
    subprocess.run(['launchctl', 'enable', DOMAIN + '/' + LABEL], check=True)
    subprocess.run(['launchctl', 'bootstrap', DOMAIN, str(PLIST)], check=True)
    print('Automatic helper enabled. It starts at login and reconnects to Jade Agent without a code. You may close Terminal.')

if __name__ == '__main__':
    main()

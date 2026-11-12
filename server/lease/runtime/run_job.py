"""One isolated cloud job. Input/output files only; no credentials or network."""
import base64
import json
from pathlib import Path
import shutil
import sys
from cadcraft_bridge import process
from studio_worker import HeadlessCad
from studio_edits import save_edits, editor_view

root = Path('/tmp/lease-reviews')
root.mkdir(exist_ok=True)
data = json.loads(Path('/tmp/input.json').read_text())
with open('/tmp/engine.log', 'ab') as log:
    cad = HeadlessCad(sys.argv[1], log)
    try:
        if data['kind'] == 'generate':
            request = data['request']
            request['dwg'] = base64.b64encode(Path('/tmp/source.dwg').read_bytes()).decode()
            result = process(cad, root, request)
        else:
            parent = data['parent']
            folder = root / parent['id']
            folder.mkdir()
            (folder / 'review.json').write_text(json.dumps(parent))
            shutil.copyfile('/tmp/source.dwg', folder / parent['dwg'])
            result = save_edits(cad, root, data['request'])
        folder = root / result['id']
        view = editor_view(cad, root, result['id'])
        # Stable output paths are the only files returned to the web service.
        shutil.copyfile(folder / result['dwg'], '/tmp/result.dwg')
        shutil.copyfile(folder / result['pdf'], '/tmp/result.pdf')
        result['folder'] = 'Private Jade Agent storage'
        Path('/tmp/review.json').write_text(json.dumps(result))
        Path('/tmp/editor.json').write_text(json.dumps(view))
        Path('/tmp/outcome.json').write_text(json.dumps({'ok': True}))
    except ValueError as error:
        Path('/tmp/outcome.json').write_text(json.dumps({'ok': False, 'error': str(error)}))
    finally:
        cad.close()

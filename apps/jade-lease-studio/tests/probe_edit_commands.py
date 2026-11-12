"""Bounded synthetic CADCraft experiment captured by REA; no customer drawings."""
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
from studio_worker import HeadlessCad
from cadcraft_bridge import equivalent

engine, output = Path(sys.argv[1]), Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
with (output / 'engine.log').open('ab') as log:
    cad = HeadlessCad(engine, log)
    try:
        cad.command('new', {'metric': True})
        cad.command('layer.new', {'name': 'Jade Studio Highlight', 'color': 'red', 'current': True})
        cad.command('pline', {'vertices': [[0, 0], [12000, 0], [12000, 8000], [0, 8000]], 'closed': True, 'width': 60})
        first = cad.inspect()['entities'][0]
        cad.command('properties.set', {'handles': [first['handle']], 'color': 'blue'})
        cad.command('layer.new', {'name': 'Jade Studio Notes', 'color': 'white', 'current': True})
        cad.command('text', {'at': [1000, 1000], 'text': 'Lease note', 'height': 750, 'justify': 'L'})
        before = cad.inspect()
        drawing = output / 'command-probe.dwg'
        cad.command('saveas', {'path': str(drawing), 'version': 2018})
        cad.call('app.open', {'path': str(drawing)})
        after = cad.inspect()
        assert equivalent(before['entities'], after['entities'])
        assert after['entities'][0]['color'] == 'Blue'
        assert after['entities'][1]['geometry']['value'] == 'Lease note'
        report = {'engineSha256': hashlib.sha256(engine.read_bytes()).hexdigest(),
                  'checks': ['closed polyline created', 'highlight colour changed to blue',
                             'text placed at requested location and height', 'entities unchanged after DWG save and reopen'],
                  'entities': after['entities'], 'scope': 'Synthetic drawing; not Windows UI or arbitrary DWG compatibility'}
        (output / 'report.json').write_text(json.dumps(report, indent=2))
        print(json.dumps({'status': 'passed', 'checks': report['checks']}))
    finally:
        cad.close()

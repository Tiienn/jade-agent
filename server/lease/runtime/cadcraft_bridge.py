#!/usr/bin/env python3
"""Local-only lease-plan CADCraft worker. No Microsoft or Supabase credentials required."""
import argparse
import base64
import datetime as dt
import hashlib
import hmac
import json
import math
import copy
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 24 * 1024 * 1024
MONTHS = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split()


def validate_request(data):
    tenant = data.get('tenant', '').strip()
    if not tenant or len(tenant) > 70 or any(ord(c) < 32 or c in '/\\<>:"|?*{}%' for c in tenant):
        raise ValueError('Enter a tenant name of 1–70 characters without filename or CAD formatting symbols.')
    date = data.get('date', '')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
        raise ValueError('Choose a valid drawing date.')
    day = dt.date.fromisoformat(date)
    if day.year < 2000 or day.year > 2100:
        raise ValueError('Drawing date must be between 2000 and 2100.')
    request_id = str(uuid.UUID(data.get('requestId', '')))
    unit = data.get('unit', 'F18').strip().upper()
    project = data.get('project', 'Palm Square').strip()
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9 ()._-]{0,19}', unit):
        raise ValueError('Enter a unit number using letters, numbers, spaces, dots or hyphens.')
    if not project or len(project) > 100 or any(ord(c) < 32 or c in '/\\<>:"|?*' for c in project):
        raise ValueError('Choose a valid project.')
    source = data.get('source', {})
    if not isinstance(source, dict) or not unit_matches(unit, source.get('name', '')) or not source['name'].lower().endswith('.dwg'):
        raise ValueError('Select a DWG matching the requested unit.')
    source = {key: source[key] for key in ('id', 'driveId', 'name', 'path', 'size', 'lastModified') if key in source}
    label = f'{day.day:02d} {MONTHS[day.month - 1]} {day.year}'
    return tenant, label, request_id, source, unit, project


def single(items, description):
    if len(items) != 1:
        raise ValueError(f'Expected one {description}; found {len(items)}. This drawing needs manual review.')
    return items[0]


def contains(vertices, point):
    x, y = point['x'], point['y']
    inside = False
    for i, v in enumerate(vertices):
        a, b = v['p'], vertices[i - 1]['p']
        if (a['y'] > y) != (b['y'] > y) and x < (b['x'] - a['x']) * (y - a['y']) / (b['y'] - a['y']) + a['x']:
            inside = not inside
    return inside


def unit_matches(unit, text):
    return re.search(r'(?<![A-Za-z0-9])' + re.escape(unit) + r'(?![A-Za-z0-9]|-[A-Za-z0-9]|[.][0-9])', text, re.I) is not None


def unit_codes(text):
    """Canonical unit labels: UNIT 5D, F - 4/5, F4.5, 204.205."""
    value = re.sub(r'^(?:UNIT|OFFICE)\s*', '', text.strip(), flags=re.I).upper()
    value = re.sub(r'\s+', '', value)
    value = re.sub(r'^([A-Z]+)-(\d)', r'\1\2', value)
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9()./_-]{0,39}', value):
        return ()
    parts = re.split(r'[./]', value)
    prefix = re.match(r'^([A-Z]+)\d', parts[0])
    if prefix:
        parts = [part if not part.isdigit() else prefix[1] + part for part in parts]
    return tuple(parts)


def unit_entities(texts, unit):
    codes = unit_codes(unit)
    exact = [e for e in texts if unit_codes(e['geometry']['value']) == codes]
    if exact:
        return [single(exact, f'{unit} unit label')]
    if len(codes) > 1:
        return [single([e for e in texts if unit_codes(e['geometry']['value']) == (code,)], f'{code} unit label') for code in codes]
    raise ValueError(f'Could not find the {unit} unit label inside this drawing. Check that the source file matches the selected unit.')


def title_parts(text, unit):
    # Preserve the source spelling of combined units (F4/5 versus F4.5).
    variants = {unit}
    if '.' in unit:
        variants.add(unit.replace('.', '/'))
    pattern = '(?:' + '|'.join(re.escape(v) for v in sorted(variants)) + ')'
    prefix = r'(.*?(?<![A-Za-z0-9])' + pattern + r'\s*-\s*)'
    found = re.fullmatch(prefix + r'(.+?)(\s*-\s*Lease\s*Agreement)', text.strip(), re.I)
    if found:
        return found
    blank = re.fullmatch(prefix + r'(Lease\s*Agreement)', text.strip(), re.I)
    if blank:
        return (blank[0], blank[1], '', ' - ' + blank[2])
    return None


def outline_vertices(entity):
    vertices = entity.get('geometry', {}).get('vertices', [])
    if len(vertices) > 3 and equivalent(vertices[0]['p'], vertices[-1]['p']):
        return vertices[:-1]
    return vertices


def closed_outline(entity):
    g = entity.get('geometry', {})
    vertices = g.get('vertices', [])
    return len(vertices) >= 3 and (g.get('closed') or (len(vertices) > 3 and equivalent(vertices[0]['p'], vertices[-1]['p'])))


def effective_color(drawing, entity):
    color = entity.get('color')
    if color == 'ByLayer':
        return next((layer.get('color') for layer in drawing.get('layers', []) if layer['name'] == entity.get('layer')), color)
    return color


def identify(drawing, unit_number='F18', outline_handle=None):
    if drawing.get('skipped', {}).get('count', 0):
        raise ValueError('CADCraft skipped drawing objects. Export stopped for manual review.')
    entities = drawing.get('entities', [])
    if len(entities) != drawing.get('entityCount'):
        raise ValueError('Could not inspect every drawing object.')
    texts = [e for e in entities if e.get('geometry', {}).get('type') == 'text']
    units = unit_entities(texts, unit_number)
    title = single([e for e in texts if title_parts(e['geometry']['value'], unit_number)], f'{unit_number} lease title')
    date = single([e for e in texts if e['layer'] == title['layer'] and re.fullmatch(r'\d{1,2}\s+[A-Za-z]{3,9}\s+(?:\d{2}|\d{4})', e['geometry']['value'].strip())], 'title-block date')
    scale_entity = single([e for e in texts if e['layer'] == title['layer'] and re.fullmatch(r'1\s*:\s*[1-9][0-9]*', e['geometry']['value'].strip())], 'title-block scale')
    scale = int(scale_entity['geometry']['value'].split(':')[1])
    candidates = [e for e in entities if closed_outline(e) and all(contains(e['geometry']['vertices'], unit['geometry']['insert']) for unit in units)]
    if outline_handle:
        candidates = [e for e in candidates if e['handle'] == outline_handle]
    else:
        studio = [e for e in candidates if e.get('layer') == 'Jade Studio Highlight']
        candidates = studio or [e for e in candidates if effective_color(drawing, e) == 'Red']
    outline = single(candidates, f'unit outline around {unit_number}')
    return title, date, outline, scale


def paper_setup(extents, scale):
    width = (extents[1][0] - extents[0][0]) / scale
    height = (extents[1][1] - extents[0][1]) / scale
    for paper, w, h in [('A4', 210, 297), ('A3', 297, 420), ('A2', 420, 594), ('A1', 594, 841), ('A0', 841, 1189)]:
        for landscape in [False, True]:
            pw, ph = (h, w) if landscape else (w, h)
            if width <= pw - 10 and height <= ph - 10:
                return paper, landscape
    raise ValueError('Drawing does not fit A0 at its stated scale. Review page setup manually.')


def equivalent(a, b):
    """DWG numeric roundoff only; never use relative tolerance on coordinates."""
    if isinstance(a, (float, int)) and not isinstance(a, bool) and isinstance(b, (float, int)) and not isinstance(b, bool):
        return math.isclose(a, b, rel_tol=0, abs_tol=1e-8)
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(equivalent(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(equivalent(x, y) for x, y in zip(a, b))
    return a == b


def verify_roundtrip(before, after, styles):
    """Allow only proven aligned-dimension cache regeneration, not geometry edits.

    The F18 source caches scaled measurements; DWG save writes raw distances.
    DIMLFAC remains in its style. Automatic text centres and anonymous block
    names are regenerated too. Exact PDF equality is separately mandatory.
    """
    expected = {e['handle']: e for e in before['entities']}
    actual = {e['handle']: e for e in after['entities']}
    if expected.keys() != actual.keys():
        raise ValueError('Saved DWG changed object handles.')
    for handle, entity in expected.items():
        a, b = copy.deepcopy(entity), copy.deepcopy(actual[handle])
        ga, gb = a.get('geometry', {}), b.get('geometry', {})
        if ga.get('type') == gb.get('type') == 'dimension' and ga.get('kind') == gb.get('kind') == 'aligned':
            distance = math.dist([ga['p13'][k] for k in ('x', 'y', 'z')], [ga['p14'][k] for k in ('x', 'y', 'z')])
            factor = styles[ga['style']]['linearFactor']
            if not equivalent(ga.get('measurement'), gb.get('measurement')):
                if not (math.isclose(ga['measurement'], distance * factor, rel_tol=0, abs_tol=1e-6) and equivalent(gb['measurement'], distance)):
                    raise ValueError('Saved DWG changed a dimension measurement unexpectedly.')
                ga.pop('measurement'); gb.pop('measurement')
            if ga.get('userTextPos') is False and gb.get('userTextPos') is False:
                ga.pop('textMid', None); gb.pop('textMid', None)
            if re.fullmatch(r'\*D[0-9]+', ga.get('block', '')) and re.fullmatch(r'\*D[0-9]+', gb.get('block', '')):
                ga.pop('block'); gb.pop('block')
        if not equivalent(a, b):
            raise ValueError(f'Saved DWG changed drawing object {handle}. Manual review is required.')


class Cad:
    def __init__(self, port):
        self.port = port

    def call(self, method, params=None):
        with socket.create_connection(('127.0.0.1', self.port), timeout=5) as connection:
            connection.settimeout(65)
            stream = connection.makefile('rwb')
            stream.write((json.dumps({'id': 1, 'method': method, 'params': params or {}}) + '\n').encode())
            stream.flush()
            response = json.loads(stream.readline(64 * 1024 * 1024))
            if not response.get('ok'):
                raise ValueError('CADCraft: ' + str(response.get('error', 'Request failed')))
            return response.get('result')

    def command(self, command, params):
        return self.call('engine.execute', {'command': command, 'params': params})

    def inspect(self):
        return self.call('drawing.inspect', {'entities': True, 'limit': 100000})


def process(cad, root, data):
    tenant, date, request_id, source, unit, project = validate_request(data)
    raw = base64.b64decode(data.get('dwg', ''), validate=True)
    if not 6 < len(raw) <= MAX_BYTES or not re.match(b'AC10[0-9]{2}', raw[:6]):
        raise ValueError('The source is not a supported DWG, or exceeds 24 MB.')
    fingerprint = hashlib.sha256(raw + json.dumps([tenant, date, source, unit, project], sort_keys=True).encode()).hexdigest()
    folder = root / request_id
    manifest = folder / 'review.json'
    if manifest.exists():
        result = json.loads(manifest.read_text())
        if result['requestFingerprint'] != fingerprint:
            raise ValueError('This request ID has already been used for different inputs.')
        return result
    if folder.exists():
        raise ValueError('An earlier attempt did not finish. Start a new review set.')
    folder.mkdir(mode=0o700, parents=True)
    original = folder / 'source.dwg'
    original.write_bytes(raw)
    opened = cad.call('app.open', {'path': str(original)})
    if opened.get('warnings'):
        raise ValueError('CADCraft reported import warnings; review the source manually before exporting.')
    if cad.command('getvar', {'name': 'INSUNITS'}).get('value') != 4:
        raise ValueError('Expected a drawing in millimetres. Review its units manually.')
    # CADCraft derives paper units from MEASUREMENT; this source has metric geometry
    # but imperial paper settings. Use millimetres for the declared 1:300 export.
    cad.command('setvar', {'name': 'MEASUREMENT', 'value': 1})
    before = cad.inspect()
    title, date_entity, outline, scale = identify(before, unit)
    parts = title_parts(title['geometry']['value'], unit)
    new_title = parts[1] + tenant + parts[3]
    # Keep the title within the verified source field width. Refuse illegibly long names.
    width = min(title['geometry']['widthFactor'], title['geometry']['widthFactor'] * len(title['geometry']['value']) / len(new_title))
    if width < 0.48:
        raise ValueError('This tenant name is too long for the title block. Use a shorter approved name.')
    cad.command('properties.set', {'handles': [title['handle']], 'text': new_title, 'widthFactor': width})
    cad.command('properties.set', {'handles': [date_entity['handle']], 'text': date})
    updated = cad.inspect()
    expected = {e['handle']: e for e in before['entities']}
    for entity in updated['entities']:
        if entity['handle'] not in (title['handle'], date_entity['handle']) and entity != expected.get(entity['handle']):
            raise ValueError('Unexpected drawing change detected; export stopped.')
    if updated['entityCount'] != before['entityCount']:
        raise ValueError('Drawing object count changed unexpectedly.')
    stem = f'{project} - {unit} - {tenant} - Lease Agreement - {date}'
    dwg, pdf = folder / (stem + '.dwg'), folder / (stem + '.pdf')
    paper, landscape = paper_setup(before['extents'], scale)
    plot_options = {'layout': 'Model', 'paper': paper, 'landscape': landscape, 'fit': False, 'scale': f'1:{scale}', 'center': True, 'plotArea': 'extents'}
    reference_pdf = folder / 'before-save.pdf'
    cad.command('exportpdf', {'path': str(reference_pdf), **plot_options})
    style_names = {e['geometry']['style'] for e in updated['entities'] if e.get('geometry', {}).get('type') == 'dimension'}
    styles = {name: cad.command('dimstyle.list', {'name': name})['style'] for name in style_names}
    cad.command('saveas', {'path': str(dwg), 'version': 2018})
    reopened = cad.call('app.open', {'path': str(dwg)})
    if reopened.get('warnings'):
        raise ValueError('Saved DWG produced warnings when reopened.')
    verified = cad.inspect()
    vt, vd, vo, verified_scale = identify(verified, unit)
    if vt['geometry']['value'] != new_title or vd['geometry']['value'] != date or verified['counts'] != before['counts'] or verified_scale != scale:
        raise ValueError('Saved DWG failed the title, date, or object-count checks.')
    verified_styles = {name: cad.command('dimstyle.list', {'name': name})['style'] for name in style_names}
    if not equivalent(styles, verified_styles):
        raise ValueError('Saved DWG changed dimension styles.')
    verify_roundtrip(updated, verified, styles)
    if vo['geometry'] != outline['geometry']:
        raise ValueError('Saved DWG changed the unit boundary.')
    plotted = cad.command('exportpdf', {'path': str(pdf), **plot_options})
    if plotted.get('pages') != 1 or not pdf.read_bytes().startswith(b'%PDF-') or not dwg.read_bytes().startswith(b'AC10'):
        raise ValueError('CADCraft did not produce valid review files.')
    if reference_pdf.read_bytes() != pdf.read_bytes():
        raise ValueError('Saved DWG changed the PDF output. Manual review is required.')
    result = {'id': request_id, 'unit': unit, 'project': project, 'tenant': tenant, 'date': date, 'source': source, 'sourceSha256': hashlib.sha256(raw).hexdigest(), 'requestFingerprint': fingerprint, 'folder': str(folder), 'dwg': dwg.name, 'pdf': pdf.name, 'paper': f'{paper} {"landscape" if landscape else "portrait"}, 1:{scale}', 'checks': ['Tenant and date verified after reopening DWG', 'Drawing object counts preserved', 'Dimension geometry and styles verified', 'PDF identical before and after DWG save', f'Existing {unit} outline preserved'], 'createdAt': dt.datetime.now(dt.timezone.utc).isoformat()}
    manifest.write_text(json.dumps(result, indent=2))
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log bearer tokens, request bodies, or tenant names.

    def reply(self, status, value, mime='application/json'):
        body = json.dumps(value).encode() if mime == 'application/json' else value
        self.send_response(status)
        if self.headers.get('Origin') in self.server.origins:
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def allowed_site(self):
        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}' or self.headers.get('Origin') not in self.server.origins:
            self.reply(403, {'error': 'This website is not connected to the CAD helper.'})
            return False
        return True

    def authorized(self):
        if not self.allowed_site():
            return False
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.token):
            self.reply(401, {'error': 'Reconnect to the drawing app and try again.'})
            return False
        return True

    def do_OPTIONS(self):
        if self.headers.get('Origin') not in self.server.origins:
            return self.reply(403, {'error': 'Origin not allowed'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Vary', 'Origin')
        self.end_headers()

    def do_GET(self):
        if self.path == '/pair':
            if not self.allowed_site():
                return
            if not getattr(self.server, 'auto_pair', False):
                return self.reply(403, {'error': 'Automatic connection is not enabled. Run Enable Automatic Helper.command on your Mac.'})
            return self.reply(200, {'token': self.server.token, 'outputRoot': str(self.server.output), 'version': 2,
                                    'product': getattr(self.server, 'product', 'CADCraft'),
                                    'supportedUnits': getattr(self.server, 'supported_units', None)})
        if not self.authorized():
            return
        if self.path == '/health':
            try:
                self.server.cad.call('engine.commands')
                return self.reply(200, {'ready': True, 'outputRoot': str(self.server.output)})
            except Exception:
                return self.reply(503, {'error': 'CADCraft is not responding. Restart the helper.'})
        if self.path == '/reviews':
            results = []
            for p in sorted(self.server.output.glob('*/review.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
                results.append(json.loads(p.read_text()))
            return self.reply(200, {'reviews': results})
        match = re.fullmatch(r'/reviews/([a-f0-9-]{36})/(dwg|pdf)', self.path)
        if match:
            manifest = self.server.output / match[1] / 'review.json'
            if manifest.is_file():
                entry = json.loads(manifest.read_text())
                path = manifest.parent / entry[match[2]]
                return self.reply(200, path.read_bytes(), 'application/pdf' if match[2] == 'pdf' else 'application/acad')
        self.reply(404, {'error': 'Review file not found.'})

    def do_POST(self):
        if not self.authorized():
            return
        if self.path != '/generate':
            return self.reply(404, {'error': 'Not found'})
        if not self.server.lock.acquire(blocking=False):
            return self.reply(409, {'error': 'A drawing is already processing. Wait for it to finish.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length < MAX_BYTES * 1.4:
                return self.reply(413, {'error': 'Drawing request exceeds 24 MB.'})
            if self.headers.get('Content-Type') != 'application/json':
                return self.reply(415, {'error': 'Expected JSON'})
            self.connection.settimeout(30)
            data = json.loads(self.rfile.read(length))
            supported = getattr(self.server, 'supported_units', None)
            if supported is not None:
                *_, unit, project = validate_request(data)
                if {'project': project, 'unit': unit} not in supported:
                    raise ValueError('This Jade Lease Studio pilot supports Palm Square / F18 only.')
            self.reply(200, process(self.server.cad, self.server.output, data))
        except (ValueError, KeyError, TypeError) as exc:
            self.reply(422, {'error': str(exc)})
        except Exception:
            self.reply(500, {'error': 'CAD processing stopped. No review set was marked complete. Restart the helper and try again.'})
        finally:
            self.server.lock.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', action='append', default=['https://jade-file-finder.vercel.app', 'https://jade-agent.vercel.app', 'http://localhost:5173'])
    parser.add_argument('--auto-pair', action='store_true', help='Allow trusted Jade Agent sites to connect without a code')
    parser.add_argument('--port', type=int, default=17819)
    parser.add_argument('--output', type=Path, default=Path.home() / 'Documents' / 'Jade Lease Plans')
    parser.add_argument('--cadcraft', default='/Applications/CADCraft.app/Contents/MacOS/CADCraft')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    os.umask(0o077)
    args.output = args.output.expanduser().resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.origins, server.output, server.lock = set(args.origin), args.output, threading.Lock()
    server.token = secrets.token_urlsafe(32)
    server.auto_pair = args.auto_pair
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        cad_port = sock.getsockname()[1]
    profile = args.output / '.cadcraft-profile'
    profile.mkdir(exist_ok=True)
    log = (profile / 'cadcraft.log').open('ab')
    app = subprocess.Popen([args.cadcraft, '--control', str(cad_port)], env={**os.environ, 'CADCRAFT_CONFIG_DIR': str(profile)}, stdout=log, stderr=log)
    server.cad = Cad(cad_port)
    try:
        for _ in range(60):
            try:
                server.cad.call('engine.commands')
                break
            except OSError:
                if app.poll() is not None:
                    raise RuntimeError('CADCraft could not start. Check ' + str(profile / 'cadcraft.log'))
                time.sleep(0.5)
        else:
            raise RuntimeError('CADCraft did not start within 30 seconds.')
        print('Dot CAD helper ready. Automatic connection enabled.' if args.auto_pair else 'Connection code: ' + server.token, flush=True)
        server.timeout = 1
        while app.poll() is None:
            server.handle_request()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.terminate()
        log.close()


if __name__ == '__main__':
    main()

"""Bounded lease edits. No browser-supplied CAD commands, paths or object handles."""
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
import uuid

from cadcraft_bridge import contains, equivalent, identify, paper_setup, verify_roundtrip, unit_entities, unit_codes, outline_vertices, effective_color

COLORS = {'Red', 'Blue', 'Green', 'Magenta'}
HIGHLIGHT_LAYER = 'Jade Studio Highlight'
NOTES_LAYER = 'Jade Studio Notes'


def review_source(root, review_id):
    folder = root / str(uuid.UUID(review_id))
    entry = json.loads((folder / 'review.json').read_text())
    if not isinstance(entry.get('unit'), str) or not re.fullmatch(r'[A-Z0-9][A-Z0-9 ()._-]{0,19}', entry['unit']):
        raise ValueError('This review has no valid unit number. Generate a new review.')
    name = entry['dwg']
    if Path(name).name != name or not name.lower().endswith('.dwg'):
        raise ValueError('Invalid saved drawing filename.')
    return entry, folder / name


def open_review(cad, root, review_id):
    entry, source = review_source(root, review_id)
    opened = cad.call('app.open', {'path': str(source)})
    if opened.get('warnings'):
        raise ValueError('The saved drawing has import warnings. Editing stopped.')
    drawing = cad.inspect()
    title, date, outline, scale = identify(drawing, entry['unit'], entry.get('outlineHandle'))
    # This simple editor displays straight polygon corners, not curved segments.
    if any(v.get('bulge') for v in outline['geometry']['vertices']):
        raise ValueError('This outline has curved segments. It needs a CAD review.')
    entities = {e['handle']: e for e in drawing['entities']}
    notes = []
    for handle in entry.get('studioNoteHandles', []):
        e = entities.get(handle, {})
        if e.get('layer') != NOTES_LAYER or e.get('geometry', {}).get('type') != 'text':
            raise ValueError('A saved Studio note changed outside the editor. Review it manually.')
        notes.append(e)
    return entry, source, drawing, title, date, outline, scale, notes


def editor_view(cad, root, review_id):
    entry, source, drawing, title, date, outline, scale, notes = open_review(cad, root, review_id)
    bounds = drawing['extents']
    handles = [outline['handle']] + [n['handle'] for n in notes]
    try:
        cad.command('properties.set', {'handles': handles, 'visible': False})
        result = cad._rpc('tools/call', {'name': 'render', 'arguments': {'window': bounds, 'width': 3200, 'height': 4800}})
        if result.get('isError'):
            raise ValueError('Could not render the drawing for editing.')
        image = next(c['data'] for c in result['content'] if c.get('type') == 'image')
    finally:
        cad.command('properties.set', {'handles': handles, 'visible': True})
    return {'reviewId': entry['id'], 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'project': entry['project'], 'unit': entry['unit'], 'image': image, 'width': 3200, 'height': 4800, 'bounds': bounds, 'scale': scale,
            'outline': {'vertices': [[v['p']['x'], v['p']['y']] for v in outline_vertices(outline)],
                        'color': effective_color(drawing, outline) if effective_color(drawing, outline) in COLORS else 'Red'},
            'notes': [{'text': n['geometry']['value'], 'x': n['geometry']['insert']['x'],
                       'y': n['geometry']['insert']['y'], 'height': n['geometry']['height']} for n in notes]}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Drawing positions must be finite numbers.')
    return float(value)


def point(value, bounds):
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError('Choose a point on the drawing.')
    x, y = map(number, value)
    if not bounds[0][0] <= x <= bounds[1][0] or not bounds[0][1] <= y <= bounds[1][1]:
        raise ValueError('Keep the outline and text inside the drawing.')
    return [x, y]


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def intersect(a, b, c, d):
    def on(a, b, p):
        return abs(cross(a, b, p)) < 1e-6 and min(a[0], b[0]) - 1e-8 <= p[0] <= max(a[0], b[0]) + 1e-8 and min(a[1], b[1]) - 1e-8 <= p[1] <= max(a[1], b[1]) + 1e-8
    return (cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0) or any([on(a, b, c), on(a, b, d), on(c, d, a), on(c, d, b)])


def validate_edits(data, drawing, unit_number='F18', scale=300):
    outline = data.get('outline')
    if not isinstance(outline, dict) or outline.get('color') not in COLORS:
        raise ValueError('Choose a supported highlight colour.')
    vertices = outline.get('vertices')
    if not isinstance(vertices, list) or not 3 <= len(vertices) <= 64:
        raise ValueError('Use between 3 and 64 outline corners.')
    vertices = [point(p, drawing['extents']) for p in vertices]
    for i, a in enumerate(vertices):
        for j, b in enumerate(vertices):
            if i < j and math.dist(a, b) < 1e-4:
                raise ValueError('Outline corners must be distinct.')
        b = vertices[(i + 1) % len(vertices)]
        for j in range(i + 1, len(vertices)):
            if j == i + 1 or (i == 0 and j == len(vertices) - 1):
                continue
            if intersect(a, b, vertices[j], vertices[(j + 1) % len(vertices)]):
                raise ValueError('The outline crosses itself. Move the corners or redraw it.')
    if abs(sum(a[0] * vertices[(i + 1) % len(vertices)][1] - vertices[(i + 1) % len(vertices)][0] * a[1] for i, a in enumerate(vertices))) < 2:
        raise ValueError('The outline is too small.')
    polygon = [{'p': {'x': x, 'y': y}} for x, y in vertices]
    texts = [e for e in drawing['entities'] if e.get('geometry', {}).get('type') == 'text']
    targets = unit_entities(texts, unit_number)
    if not all(contains(polygon, e['geometry']['insert']) for e in targets):
        raise ValueError(f'The highlight must enclose every {unit_number} unit label.')
    layers = {e.get('layer') for e in targets}
    requested = set(unit_codes(unit_number))
    for e in texts:
        g = e['geometry']
        explicit = re.match(r'^(?:UNIT|OFFICE)\s+', g['value'].strip(), re.I)
        if e in targets or (e.get('layer') not in layers and not explicit):
            continue
        codes = unit_codes(g['value'])
        if codes and (explicit or any(c.isdigit() for c in ''.join(codes))) and not set(codes).issubset(requested) and contains(polygon, g['insert']):
            raise ValueError(f'This outline also includes {g["value"]}. Keep it around {unit_number} only.')
    raw_notes = data.get('notes', [])
    if not isinstance(raw_notes, list) or len(raw_notes) > 20:
        raise ValueError('Add up to 20 notes per plan.')
    notes = []
    for note in raw_notes:
        if not isinstance(note, dict):
            raise ValueError('Invalid text note.')
        text = note.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 120 or any(ord(c) < 32 or c in '\\{}%' for c in text):
            raise ValueError('Use 1–120 plain characters per note, without CAD formatting symbols.')
        x, y = point([note.get('x'), note.get('y')], drawing['extents'])
        height = number(note.get('height'))
        if not 0.6 * scale <= height <= 6 * scale:
            raise ValueError('Choose a text size between 0.6 and 6 mm on the printed plan.')
        notes.append({'text': text.strip(), 'x': x, 'y': y, 'height': height})
    return {'vertices': vertices, 'color': outline['color']}, notes


def layer(cad, drawing, name, color):
    if not any(l['name'] == name for l in drawing['layers']):
        cad.command('layer.new', {'name': name, 'color': color, 'current': True})
    else:
        old = next(l for l in drawing['layers'] if l['name'] == name)
        if old.get('locked') or old.get('frozen') or not old.get('on', True):
            raise ValueError('The Studio editing layer is locked or hidden. Review the drawing manually.')
        cad.command('layer.current', {'name': name})


def created(cad, command, params):
    before = {e['handle'] for e in cad.inspect()['entities']}
    cad.command(command, params)
    added = [e for e in cad.inspect()['entities'] if e['handle'] not in before]
    if len(added) != 1:
        raise ValueError('The drawing engine did not create exactly one expected object.')
    return added[0]['handle']


def save_edits(cad, root, data):
    request_id = str(uuid.UUID(data.get('requestId', '')))
    review_id = str(uuid.UUID(data.get('reviewId', '')))
    entry, source = review_source(root, review_id)
    raw = source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if data.get('sourceSha256') != digest:
        raise ValueError('The source review changed. Reopen the editor before saving.')
    fingerprint = hashlib.sha256(json.dumps([digest, review_id, data.get('outline'), data.get('notes')], sort_keys=True, allow_nan=False).encode()).hexdigest()
    folder = root / request_id
    manifest = folder / 'review.json'
    if manifest.exists():
        result = json.loads(manifest.read_text())
        if result.get('requestFingerprint') != fingerprint:
            raise ValueError('This save identifier has already been used for different edits.')
        return result
    if folder.exists():
        raise ValueError('An earlier save did not finish. Reopen the editor and try again.')
    entry, source, before, title, date, old_outline, scale, old_notes = open_review(cad, root, review_id)
    outline, notes = validate_edits(data, before, entry['unit'], scale)
    folder.mkdir(mode=0o700)
    (folder / 'source.dwg').write_bytes(raw)
    # From here the only document mutations are the selected outline and our recorded notes.
    removed = {old_outline['handle']} | {n['handle'] for n in old_notes}
    cad.command('erase', {'handles': sorted(removed)})
    layer(cad, before, HIGHLIGHT_LAYER, 'red')
    outline_handle = created(cad, 'pline', {'vertices': outline['vertices'], 'closed': True, 'width': old_outline['geometry'].get('const_width', 100)})
    cad.command('properties.set', {'handles': [outline_handle], 'color': outline['color'].lower()})
    note_handles = []
    if notes:
        layer(cad, cad.inspect(), NOTES_LAYER, 'white')
        # Use the drawing's actual style spelling; DWG canonicalizes STANDARD.
        standard = [name for name in before.get('textStyles', []) if name.casefold() == 'standard']
        if len(standard) != 1:
            raise ValueError('The drawing needs a unique Standard text style before adding notes.')
        cad.command('style', {'name': standard[0], 'current': True})
    for note in notes:
        h = created(cad, 'text', {'at': [note['x'], note['y']], 'text': note['text'], 'height': note['height'], 'justify': 'L'})
        cad.command('properties.set', {'handles': [h], 'color': 'white'})
        note_handles.append(h)
    after = cad.inspect()
    original = {e['handle']: e for e in before['entities'] if e['handle'] not in removed}
    actual = {e['handle']: e for e in after['entities']}
    if set(actual) != set(original) | {outline_handle} | set(note_handles) or any(not equivalent(e, actual[h]) for h, e in original.items()):
        raise ValueError('An unrelated drawing object changed. Export stopped.')
    made = actual[outline_handle]
    if made['color'] != outline['color'] or not made['geometry']['closed'] or not equivalent([[v['p']['x'], v['p']['y']] for v in made['geometry']['vertices']], outline['vertices']):
        raise ValueError('The saved highlight does not match the requested outline.')
    for h, note in zip(note_handles, notes):
        g = actual[h]['geometry']
        if g['value'] != note['text'] or not equivalent([g['insert']['x'], g['insert']['y'], g['height']], [note['x'], note['y'], note['height']]):
            raise ValueError('Text placement did not match the requested note.')
    # Keep the original page framing; do not silently shrink or clip the plan.
    b, a = before['extents'], after['extents']
    if any(a[0][i] < b[0][i] - 1e-6 or a[1][i] > b[1][i] + 1e-6 for i in (0, 1)):
        raise ValueError('A note extends past the drawing edge. Move it inward or choose a smaller size.')
    paper, landscape = paper_setup(b, scale)
    plot = {'layout': 'Model', 'paper': paper, 'landscape': landscape, 'fit': False, 'scale': f'1:{scale}', 'center': True, 'plotArea': 'window', 'window': b}
    names = {e['geometry']['style'] for e in after['entities'] if e.get('geometry', {}).get('type') == 'dimension'}
    styles = {n: cad.command('dimstyle.list', {'name': n})['style'] for n in names}
    dwg = folder / source.name
    pdf = dwg.with_suffix('.pdf')
    reference = folder / 'before-save.pdf'
    cad.command('exportpdf', {'path': str(reference), **plot})
    cad.command('saveas', {'path': str(dwg), 'version': 2018})
    opened = cad.call('app.open', {'path': str(dwg)})
    if opened.get('warnings'):
        raise ValueError('The edited DWG produced import warnings after saving.')
    verified = cad.inspect()
    vt, vd, vo, vs = identify(verified, entry['unit'], outline_handle)
    if vt['geometry'] != title['geometry'] or vd['geometry'] != date['geometry'] or vs != scale:
        raise ValueError('An edit changed the tenant, date or drawing scale.')
    verify_roundtrip(after, verified, styles)
    if not equivalent(styles, {n: cad.command('dimstyle.list', {'name': n})['style'] for n in names}):
        raise ValueError('The edited drawing changed dimension styles.')
    plotted = cad.command('exportpdf', {'path': str(pdf), **plot})
    if plotted.get('pages') != 1 or not pdf.read_bytes().startswith(b'%PDF-') or reference.read_bytes() != pdf.read_bytes():
        raise ValueError('The edited drawing changed its PDF output after saving. Review stopped.')
    if source.read_bytes() != raw:
        raise ValueError('The original review changed during editing. Reopen it before saving.')
    result = {**entry, 'id': request_id, 'parentReviewId': review_id, 'folder': str(folder), 'dwg': dwg.name,
              'pdf': pdf.name, 'requestFingerprint': fingerprint, 'sourceSha256': digest,
              'outlineHandle': outline_handle, 'studioNoteHandles': note_handles,
              'paper': f'{paper} {"landscape" if landscape else "portrait"}, 1:{scale}',
              'checks': ['Tenant, date and scale unchanged', 'Only the selected highlight and Studio notes edited',
                         'Dimensions and unrelated geometry preserved', 'Requested outline and text verified',
                         'PDF identical before and after DWG save', 'Previous review kept unchanged'],
              'createdAt': dt.datetime.now(dt.timezone.utc).isoformat()}
    temporary = manifest.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2))
    temporary.replace(manifest)
    return result

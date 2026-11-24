import copy
import json
from pathlib import Path
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from tempfile import TemporaryDirectory
from cadcraft_bridge import Handler, validate_request, identify, contains, verify_roundtrip, unit_matches, title_parts, paper_setup


class InputTests(unittest.TestCase):
    def setUp(self):
        self.request = {'tenant': 'Dr. Antoine Leuteritz', 'date': '2026-10-14', 'requestId': 'c9cdbe57-5c14-49c4-b907-083935902ad5', 'source': {'name': 'PS-F18.dwg'}}

    def test_date_and_tenant(self):
        self.assertEqual(validate_request(self.request)[:2], ('Dr. Antoine Leuteritz', '14 OCT 2026'))

    def test_reject_traversal_and_cad_formatting(self):
        for name in ['../other', 'a\\b', 'name\ntext', 'a%u', '{formatted}', 'x' * 71]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_request({**self.request, 'tenant': name})

    def test_reject_invalid_dates_unit_and_request_id(self):
        for patch in [{'date': '2026-02-30'}, {'date': '14/10/26'}, {'source': {'name': 'F180.dwg'}}, {'source': {'name': 'F18.pdf'}}, {'requestId': '../file'}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate_request({**self.request, **patch})

    def test_other_units_and_projects(self):
        data = {**self.request, 'project': 'Raffles Tower 1', 'unit': '3C', 'source': {'name': 'RT - Unit 3C - Tenant - Lease Agreement.dwg'}}
        self.assertEqual(validate_request(data)[4:], ('3C', 'Raffles Tower 1'))
        self.assertFalse(unit_matches('F18', 'PS-F180.dwg'))
        self.assertFalse(unit_matches('F18', 'PS-F18-1.dwg'))
        self.assertTrue(unit_matches('3C', data['source']['name']))
        parts = title_parts('RT - Unit 3C - Old Tenant - Lease Agreement', '3C')
        self.assertEqual(parts[1] + 'New Tenant' + parts[3], 'RT - Unit 3C - New Tenant - Lease Agreement')
        self.assertIsNone(title_parts('RT - Unit 3C1 - Old - Lease Agreement', '3C'))
        self.assertEqual(paper_setup([[0, 0], [57000, 91000]], 300), ('A3', False))

    def test_polygon_does_not_highlight_wrong_unit(self):
        vertices = [{'p': {'x': x, 'y': y}} for x, y in [(0,0), (10,0), (10,5), (0,5)]]
        self.assertTrue(contains(vertices, {'x': 4, 'y': 2}))
        self.assertFalse(contains(vertices, {'x': 20, 'y': 2}))

    def test_incomplete_import_fails(self):
        with self.assertRaisesRegex(ValueError, 'skipped'):
            identify({'skipped': {'count': 1}})
        with self.assertRaisesRegex(ValueError, 'every'):
            identify({'entities': [], 'entityCount': 1})


class DimensionTests(unittest.TestCase):
    def setUp(self):
        self.entity = {'handle': 'A1', 'geometry': {'type': 'dimension', 'kind': 'aligned', 'style': 'Metric', 'measurement': 2500.0, 'p13': {'x': 0, 'y': 0, 'z': 0}, 'p14': {'x': 0, 'y': 2.5, 'z': 0}, 'textMid': {'x': 1, 'y': 1, 'z': 0}, 'userTextPos': False, 'block': '*D86'}}
        self.after = copy.deepcopy(self.entity)
        self.after['geometry'].update(measurement=2.5, block='*D85', textMid={'x': 1, 'y': 1.25, 'z': 0})
        self.styles = {'Metric': {'linearFactor': 1000}}

    def verify(self):
        verify_roundtrip({'entities': [self.entity]}, {'entities': [self.after]}, self.styles)

    def test_scaled_cache_regeneration(self):
        self.verify()

    def test_geometry_changes_rejected(self):
        self.after['geometry']['p14']['y'] = 3
        with self.assertRaises(ValueError): self.verify()

    def test_wrong_measurement_rejected(self):
        self.after['geometry']['measurement'] = 25
        with self.assertRaises(ValueError): self.verify()

    def test_manual_text_position_preserved(self):
        self.entity['geometry']['userTextPos'] = True
        self.after['geometry']['userTextPos'] = True
        with self.assertRaises(ValueError): self.verify()


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.origins = {'https://jade-file-finder.vercel.app'}
        self.server.token = 'test-token'
        self.server.output = Path(self.temp.name)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()

    def request(self, path, origin='https://jade-file-finder.vercel.app', token='test-token'):
        req = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}{path}', headers={'Origin': origin, 'Authorization': 'Bearer ' + token})
        return urllib.request.urlopen(req)

    def test_requires_token_and_allowed_origin(self):
        for origin, token in [('https://evil.example', 'test-token'), ('https://jade-file-finder.vercel.app', 'wrong'), ('null', 'test-token')]:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.request('/reviews', origin, token)
            self.assertIn(caught.exception.code, [401, 403])
            caught.exception.close()

    def test_automatic_pairing_requires_opt_in_and_trusted_origin(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/pair', token='')
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()
        self.server.auto_pair = True
        with self.request('/pair', token='') as res:
            self.assertEqual(json.load(res)['token'], 'test-token')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/pair', origin='https://evil.example', token='')
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()

    def test_review_listing_and_no_arbitrary_files(self):
        with self.request('/reviews') as res:
            self.assertEqual(json.load(res), {'reviews': []})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/reviews/../../etc/passwd')
        self.assertEqual(caught.exception.code, 404)
        caught.exception.close()



class AdditionalTemplateTests(unittest.TestCase):
    def test_combined_units_and_empty_tenant(self):
        from cadcraft_bridge import unit_codes, unit_entities
        self.assertEqual(unit_codes('F - 4/5'), ('F4', 'F5'))
        self.assertEqual(unit_codes('UNIT 204.205'), ('204','205'))
        parts=title_parts('RT-1FL- Unit 1J - Lease Agreement','1J')
        self.assertEqual(parts[1]+'New Tenant'+parts[3], 'RT-1FL- Unit 1J - New Tenant - Lease Agreement')
        self.assertTrue(title_parts('PS-F4/5 - Tenant - Lease Agreement','F4.5'))
        self.assertFalse(unit_matches('F4','PS-F4.5 - Lease Agreement.dwg'))
        self.assertTrue(unit_matches('F4.5','PS-F4.5 - Lease Agreement.dwg'))
        texts=[{'geometry':{'value':v}} for v in ['UNIT 2C','UNIT 2D','UNIT 2E']]
        self.assertEqual(len(unit_entities(texts,'2C.2D')),2)
        with self.assertRaises(ValueError):unit_entities(texts,'2C.2F')

    def test_layer_colour_and_geometrically_closed_outline(self):
        from cadcraft_bridge import closed_outline, outline_vertices, effective_color
        points=[{'p':{'x':x,'y':y}} for x,y in [(0,0),(10,0),(10,10),(0,0)]]
        entity={'layer':'Highlight','color':'ByLayer','geometry':{'vertices':points,'closed':False}}
        self.assertTrue(closed_outline(entity))
        self.assertEqual(len(outline_vertices(entity)),3)
        self.assertEqual(effective_color({'layers':[{'name':'Highlight','color':'Red'}]},entity),'Red')
        entity['geometry']['vertices'][-1]['p']['x']=1
        self.assertFalse(closed_outline(entity))


class TenantLabelTests(unittest.TestCase):
    """The tenant is named in the plan as well as in the title block (Le Manhattan S08B)."""

    def setUp(self):
        square = [{'p': {'x': x, 'y': y}} for x, y in [(0, 0), (100, 0), (100, 100), (0, 100)]]
        self.outline = {'handle': 'O', 'geometry': {'vertices': square, 'closed': True}}
        text = lambda h, v, x, y: {'handle': h, 'geometry': {'type': 'text', 'value': v, 'insert': {'x': x, 'y': y}, 'widthFactor': 1.0}}
        self.drawing = {'entities': [
            text('T', 'B: S08B - Billard Blitz Ltd - Lease Agreement', 500, 500),
            text('U', 'S08 B', 40, 60),
            text('L', 'Billard  Blitz LTD ', 40, 50),       # inside S08B: whitespace and case differ
            text('N', 'Billard Blitz Ltd', 150, 50),        # same company, next unit: must keep its name
            text('P', 'Billard Blitz Ltd (Mezzanine)', 40, 40),  # not an exact match
        ]}

    def test_only_the_outgoing_name_inside_the_unit(self):
        from cadcraft_bridge import tenant_labels
        found = tenant_labels(self.drawing, 'Billard Blitz Ltd', self.outline, 'T')
        self.assertEqual([e['handle'] for e in found], ['L'])

    def test_blank_title_tenant_touches_nothing(self):
        from cadcraft_bridge import tenant_labels
        self.assertEqual(tenant_labels(self.drawing, '', self.outline, 'T'), [])
        self.assertEqual(tenant_labels(self.drawing, '   ', self.outline, 'T'), [])

    def test_title_block_is_never_a_label(self):
        from cadcraft_bridge import tenant_labels
        self.drawing['entities'][0]['geometry']['insert'] = {'x': 50, 'y': 50}
        self.drawing['entities'][0]['geometry']['value'] = 'Billard Blitz Ltd'
        self.assertNotIn('T', [e['handle'] for e in tenant_labels(self.drawing, 'Billard Blitz Ltd', self.outline, 'T')])

    def test_label_width(self):
        from cadcraft_bridge import label_width
        self.assertEqual(label_width('Billard Blitz Ltd', 'Sportime Ltd', 1.0), (1.0, True))      # shorter: untouched
        self.assertEqual(label_width('ABCD', 'ABCDEFGH', 0.8), (0.5, False))   # needs 0.4: floor at 0.5
        width, fits = label_width('ABCDEF', 'ABCDEFGH', 1.0)
        self.assertAlmostEqual(width, 0.75); self.assertTrue(fits)
        self.assertEqual(label_width('AB', 'ABCDEFGH', 0.4), (0.4, False))                        # never wider than source

    def test_checklist_says_what_happened(self):
        from cadcraft_bridge import label_checks
        self.assertEqual(label_checks([{}], 'X Ltd', True), ['Tenant name in the plan updated (1 label)'])
        self.assertEqual(len(label_checks([{}, {}], 'X Ltd', False)), 2)
        self.assertIn('not found inside the unit', label_checks([], 'Billard Blitz Ltd', True)[0])
        self.assertEqual(label_checks([], '', True), [])



class FontTests(unittest.TestCase):
    def test_reports_only_used_unresolved_truetype_fonts(self):
        from cadcraft_bridge import missing_fonts, font_checks
        styles = [{'name': 'STYLE2', 'font': 'ARIALN.TTF', 'trueType': False},   # used, missing: report
                  {'name': 'arial', 'font': 'ARIALN.TTF', 'trueType': False},    # same file: once
                  {'name': 'Myriad', 'font': 'monos.ttf', 'trueType': False},    # unused: ignore
                  {'name': 'RomanS', 'font': 'romans.shx', 'trueType': False},   # SHX: ignore
                  {'name': 'OK', 'font': 'ARIALN.TTF', 'trueType': True}]        # resolved: ignore
        texts = {'entities': [{'geometry': {'type': 'text', 'style': s}} for s in ('STYLE2', 'arial', 'RomanS', 'OK')]}
        self.assertEqual(missing_fonts(styles, texts), ['ARIALN.TTF'])
        self.assertEqual(font_checks([]), [])
        self.assertEqual(font_checks(['ARIALN.TTF']), ['Font not available, drawn in a substitute: ARIALN.TTF'])


if __name__ == '__main__':
    unittest.main()

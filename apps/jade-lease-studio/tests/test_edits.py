import copy
from pathlib import Path
import sys
import unittest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'worker'))
sys.path.insert(0, str(APP.parents[1] / 'scripts' / 'lease_plans'))
from studio_edits import validate_edits


class EditValidation(unittest.TestCase):
    def setUp(self):
        self.drawing = {'extents': [[0, 0], [20000, 20000]], 'entities': [
            {'geometry': {'type': 'text', 'value': 'F18', 'insert': {'x': 5000, 'y': 5000}}},
            {'geometry': {'type': 'text', 'value': 'F19', 'insert': {'x': 15000, 'y': 5000}}}]}
        self.data = {'outline': {'vertices': [[1000, 1000], [9000, 1000], [9000, 9000], [1000, 9000]], 'color': 'Blue'},
                     'notes': [{'text': 'Entrance', 'x': 2000, 'y': 2000, 'height': 900}]}

    def test_accepts_simple_boundary_and_plain_text(self):
        outline, notes = validate_edits(self.data, self.drawing)
        self.assertEqual(outline['color'], 'Blue')
        self.assertEqual(notes[0]['text'], 'Entrance')

    def test_rejects_crossed_duplicate_and_degenerate_polygons(self):
        for vertices in [[[1000,1000],[9000,9000],[9000,1000],[1000,9000]],
                         [[1000,1000],[9000,1000],[9000,1000],[1000,9000]],
                         [[1000,1000],[2000,2000],[3000,3000]]]:
            with self.subTest(vertices=vertices), self.assertRaises(ValueError):
                validate_edits({**self.data, 'outline': {'vertices': vertices, 'color':'Red'}}, self.drawing)

    def test_rejects_wrong_or_multiple_units(self):
        for vertices in [[[11000,1000],[19000,1000],[19000,9000],[11000,9000]],
                         [[1000,1000],[19000,1000],[19000,9000],[1000,9000]]]:
            with self.subTest(vertices=vertices), self.assertRaises(ValueError):
                validate_edits({**self.data, 'outline': {'vertices': vertices, 'color':'Red'}}, self.drawing)

    def test_rejects_outside_nonfinite_or_oversized_inputs(self):
        for bad in [-1, 30000, float('nan'), float('inf'), True, '100']:
            value = copy.deepcopy(self.data); value['outline']['vertices'][0][0] = bad
            with self.subTest(value=bad), self.assertRaises(ValueError):
                validate_edits(value, self.drawing)
        value = copy.deepcopy(self.data); value['notes'] *= 21
        with self.assertRaises(ValueError): validate_edits(value, self.drawing)

    def test_rejects_formatting_and_unsafe_text_sizes(self):
        for patch in [{'text':''}, {'text':'a\\Pnew'}, {'text':'{font}'}, {'text':'%value'},
                      {'text':'line\nbreak'}, {'text':'x'*121}, {'height':1}, {'height':2000}, {'x':-1}]:
            value = copy.deepcopy(self.data); value['notes'][0].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate_edits(value, self.drawing)


class OtherUnitValidation(unittest.TestCase):
    def test_unit_codes_and_printed_scale(self):
        for unit, neighbour in [('5D','5E'),('101','102'),('G01','G02'),('A-02','A-03')]:
            with self.subTest(unit=unit):
                drawing={'extents': [[0,0],[20000,20000]], 'entities': [
                    {'layer':'Units','geometry':{'type':'text','value':unit,'insert':{'x':5000,'y':5000}}},
                    {'layer':'Units','geometry':{'type':'text','value':neighbour,'insert':{'x':15000,'y':5000}}}]}
                data={'outline':{'vertices':[[1000,1000],[9000,1000],[9000,9000],[1000,9000]],'color':'Blue'},
                      'notes':[{'text':'Entrance','x':2000,'y':2000,'height':300}]}
                validate_edits(data,drawing,unit,100)
                bad=copy.deepcopy(data);bad['outline']['vertices'][1][0]=19000;bad['outline']['vertices'][2][0]=19000
                with self.assertRaisesRegex(ValueError,'also includes'):validate_edits(bad,drawing,unit,100)
                bad=copy.deepcopy(data);bad['notes'][0]['height']=900
                with self.assertRaisesRegex(ValueError,'text size'):validate_edits(bad,drawing,unit,100)
                with self.assertRaisesRegex(ValueError,'unit label'):validate_edits(data,drawing,'F18',100)

    def test_combined_units_and_neighbour_on_another_layer(self):
        drawing={'extents':[[0,0],[20000,20000]],'entities':[
            {'layer':'Labels','geometry':{'type':'text','value':'F - 4/5','insert':{'x':5000,'y':5000}}},
            {'layer':'Other labels','geometry':{'type':'text','value':'Unit F6','insert':{'x':15000,'y':5000}}}]}
        data={'outline':{'vertices':[[1000,1000],[9000,1000],[9000,9000],[1000,9000]],'color':'Red'},'notes':[]}
        validate_edits(data,drawing,'F4.5',250)
        data['outline']['vertices'][1][0]=19000;data['outline']['vertices'][2][0]=19000
        with self.assertRaisesRegex(ValueError,'also includes'):validate_edits(data,drawing,'F4.5',250)

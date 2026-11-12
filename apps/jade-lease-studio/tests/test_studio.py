"""Real headless/HTTP integration. Optional private fixture stays outside the repo.
STUDIO_TEST_ENGINE=/path/to/cadcraft-cli STUDIO_TEST_DWG=/path/to/F18.dwg python3 -m unittest discover -s apps/jade-lease-studio/tests -v
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'worker'))
from studio_worker import HeadlessCad

ENGINE = os.environ.get('STUDIO_TEST_ENGINE')
DWG = os.environ.get('STUDIO_TEST_DWG')


@unittest.skipUnless(ENGINE, 'Set STUDIO_TEST_ENGINE for real engine integration')
class StudioIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.token_path = cls.root / 'token.txt'
        cls.log = (cls.root / 'worker.log').open('wb')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); cls.port = sock.getsockname()[1]
        cls.proc = subprocess.Popen([sys.executable, str(APP / 'worker' / 'studio_worker.py'),
                                    '--engine', ENGINE, '--output', str(cls.root / 'reviews'),
                                    '--port', str(cls.port), '--desktop-token', str(cls.token_path)],
                                   stdin=subprocess.PIPE, stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            if cls.token_path.exists():
                cls.token = cls.token_path.read_text(); break
            if cls.proc.poll() is not None:
                raise AssertionError('Worker failed: ' + (cls.root / 'worker.log').read_text())
            time.sleep(0.1)
        else:
            cls.proc.kill(); raise AssertionError('Worker startup timed out')

    @classmethod
    def tearDownClass(cls):
        cls.proc.stdin.close()
        cls.proc.wait(timeout=10)
        assert cls.proc.returncode == 0, 'Worker did not exit cleanly'
        assert not cls.token_path.exists(), 'Desktop token was not removed'
        cls.log.close(); cls.temp.cleanup()

    def request(self, path, data=None, origin='https://jade-agent.vercel.app', token=None):
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}',
                                     data=None if data is None else json.dumps(data).encode(),
                                     headers={'Origin': origin, 'Authorization': 'Bearer ' + (self.token if token is None else token), 'Content-Type': 'application/json'})
        return urllib.request.urlopen(req, timeout=180)

    def test_pair_and_health(self):
        with self.request('/pair', token='') as response:
            data = json.load(response)
        self.assertEqual(data['product'], 'Jade Lease Studio')
        self.assertEqual(data['token'], self.token)
        self.assertEqual(data['supportedUnits'], [{'project': 'Palm Square', 'unit': 'F18'}])
        with self.request('/health') as response:
            self.assertTrue(json.load(response)['ready'])

    def test_refuses_untrusted_origin_and_wrong_token(self):
        for path, origin, token, expected in [('/pair', 'https://evil.example', '', 403),
                                               ('/reviews', 'https://jade-agent.vercel.app', 'wrong', 401)]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(path, origin=origin, token=token)
            self.assertEqual(error.exception.code, expected); error.exception.close()

    def test_other_unit_rejected_before_engine_or_file_write(self):
        data = {'tenant': 'Test', 'date': '2026-10-14', 'requestId': str(uuid.uuid4()),
                'unit': 'F19', 'project': 'Palm Square', 'source': {'name': 'PS-F19.dwg'}, 'dwg': ''}
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('/generate', data)
        self.assertEqual(error.exception.code, 422)
        self.assertIn('F18 only', json.load(error.exception)['error']); error.exception.close()
        self.assertFalse((self.root / 'reviews' / data['requestId']).exists())

    @unittest.skipUnless(DWG, 'Set STUDIO_TEST_DWG to test the private F18 drawing')
    def test_real_f18_roundtrip_and_review_download(self):
        source = Path(DWG)
        original = source.read_bytes()
        data = {'tenant': 'Dr. Antoine Leuteritz', 'date': '2026-10-14', 'requestId': str(uuid.uuid4()),
                'unit': 'F18', 'project': 'Palm Square', 'source': {'name': source.name},
                'dwg': base64.b64encode(original).decode()}
        with self.request('/generate', data) as response:
            review = json.load(response)
        self.assertEqual(review['paper'], 'A3 portrait, 1:300')
        self.assertEqual(review['tenant'], data['tenant'])
        self.assertEqual(review['date'], '14 OCT 2026')
        self.assertEqual(review['sourceSha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(source.read_bytes(), original)
        for kind, signature in [('pdf', b'%PDF-'), ('dwg', b'AC10')]:
            with self.request(f"/reviews/{review['id']}/{kind}") as response:
                result = response.read()
            self.assertTrue(result.startswith(signature))
            self.assertEqual(result, (Path(review['folder']) / review[kind]).read_bytes())
        with self.request('/generate', data) as response:
            self.assertEqual(json.load(response)['id'], review['id'])  # retry is idempotent
        with self.request('/studio/open', {'reviewId': review['id']}) as response:
            view = json.load(response)
        self.assertEqual(view['notes'], [])
        self.assertTrue(base64.b64decode(view['image']).startswith(b'\x89PNG'))
        edit = {k: view[k] for k in ['reviewId', 'sourceSha256', 'outline', 'notes']}
        edit['requestId'] = str(uuid.uuid4())
        edit['outline']['color'] = 'Blue'
        edit['outline']['vertices'][0][0] += 100
        edit['notes'] = [{'text': 'Proposed entrance', 'x': 272000, 'y': -56000, 'height': 900}]
        parent_bytes = (Path(review['folder']) / review['dwg']).read_bytes()
        with self.request('/studio/edit', edit) as response:
            edited = json.load(response)
        self.assertEqual(edited['parentReviewId'], review['id'])
        self.assertEqual((Path(review['folder']) / review['dwg']).read_bytes(), parent_bytes)
        with self.request('/studio/edit', edit) as response:
            self.assertEqual(json.load(response)['id'], edited['id'])
        with self.request('/studio/open', {'reviewId': edited['id']}) as response:
            reopened = json.load(response)
        self.assertEqual(reopened['outline']['color'], 'Blue')
        self.assertEqual(reopened['outline']['vertices'], edit['outline']['vertices'])
        self.assertEqual(reopened['notes'], edit['notes'])
        # Notes can be edited or removed again without accumulating hidden copies.
        next_edit = {k: reopened[k] for k in ['reviewId', 'sourceSha256', 'outline', 'notes']}
        next_edit['requestId'] = str(uuid.uuid4()); next_edit['notes'] = []
        with self.request('/studio/edit', next_edit) as response:
            cleared = json.load(response)
        with self.request('/studio/open', {'reviewId': cleared['id']}) as response:
            self.assertEqual(json.load(response)['notes'], [])
        stale = {**next_edit, 'requestId': str(uuid.uuid4()), 'sourceSha256': 'wrong'}
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('/studio/edit', stale)
        self.assertEqual(error.exception.code, 422); error.exception.close()
        data['tenant'] = 'A different tenant'
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('/generate', data)
        self.assertEqual(error.exception.code, 422); error.exception.close()

"""Jade Lease Studio's private CAD engine and compatible Jade Agent bridge."""
import argparse
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import threading
from http.server import ThreadingHTTPServer

# The packager places the unchanged, shared validator alongside this module.
if len(Path(__file__).resolve().parents) > 3:
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts' / 'lease_plans'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cadcraft_bridge import Cad, Handler
from studio_edits import editor_view, save_edits

ORIGINS = {'https://jade-agent.vercel.app', 'https://jade-file-finder.vercel.app'}


class HeadlessCad(Cad):
    """Adapt the existing validation pipeline to CADCraft's headless MCP engine.

    One persistent document; no CAD window or exposed CAD command socket.
    Serialise health requests with commands to avoid crossing RPC responses.
    """
    METHODS = {'app.open': 'open', 'engine.execute': 'execute',
               'drawing.inspect': 'inspect_drawing', 'engine.commands': 'list_commands'}

    def __init__(self, executable, log):
        options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        self.app = subprocess.Popen([str(executable), 'mcp'], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=log, **options)
        self.responses = queue.Queue()
        self.rpc_lock = threading.Lock()
        self.counter = 0
        threading.Thread(target=self._read, daemon=True).start()
        self._rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                                 'clientInfo': {'name': 'jade-lease-studio', 'version': '0.2.0'}})
        self.app.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        self.app.stdin.flush()

    def _read(self):
        try:
            while line := self.app.stdout.readline(64 * 1024 * 1024):
                self.responses.put(json.loads(line))
        except Exception:
            pass
        finally:
            self.responses.put(None)

    def _rpc(self, method, params):
        with self.rpc_lock:
            if self.app.poll() is not None:
                raise RuntimeError('The drawing engine stopped. Restart Jade Lease Studio.')
            self.counter += 1
            self.app.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': self.counter,
                                             'method': method, 'params': params}) + '\n').encode())
            self.app.stdin.flush()
            try:
                result = self.responses.get(timeout=90)
            except queue.Empty:
                self.app.kill()  # Never reuse a document with an unknown command outcome.
                raise RuntimeError('The drawing engine timed out. Restart Jade Lease Studio.') from None
            if not result or result.get('id') != self.counter:
                raise RuntimeError('Lost the drawing engine connection. Restart Jade Lease Studio.')
            if result.get('error'):
                raise ValueError(result['error']['message'])
            return result['result']

    def call(self, method, params=None):
        result = self._rpc('tools/call', {'name': self.METHODS[method], 'arguments': params or {}})
        content = result.get('content', [])
        text = '\n'.join(c['text'] for c in content if c.get('type') == 'text')
        if result.get('isError'):
            raise ValueError('Drawing engine: ' + text)
        return json.loads(text)

    def close(self):
        if self.app.poll() is None:
            self.app.terminate()
            try:
                self.app.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.app.kill()
                self.app.wait()
        self.app.stdin.close()
        self.app.stdout.close()


class StudioHandler(Handler):
    def do_POST(self):
        if self.path not in ('/studio/open', '/studio/edit'):
            return super().do_POST()
        if not self.authorized():
            return
        if not self.server.lock.acquire(blocking=False):
            return self.reply(409, {'error': 'A drawing is processing. Please wait and try again.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                return self.reply(413, {'error': 'This edit request is too large.'})
            if self.headers.get('Content-Type') != 'application/json':
                return self.reply(415, {'error': 'Expected JSON'})
            self.connection.settimeout(30)
            data = json.loads(self.rfile.read(length))
            if self.path == '/studio/open':
                result = editor_view(self.server.cad, self.server.output, data.get('reviewId', ''))
            else:
                result = save_edits(self.server.cad, self.server.output, data)
            self.reply(200, result)
        except (ValueError, KeyError, TypeError, FileNotFoundError) as e:
            self.reply(422, {'error': str(e)})
        except Exception:
            self.reply(500, {'error': 'Editing stopped. Your previous review is unchanged. Reopen the editor and try again.'})
        finally:
            self.server.lock.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--port', type=int, default=17819)
    parser.add_argument('--desktop-token', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with (args.output / 'studio-engine.log').open('ab') as log:
        cad = HeadlessCad(args.engine, log)
        try:
            with ThreadingHTTPServer(('127.0.0.1', args.port), StudioHandler) as server:
                server.origins = ORIGINS
                server.output = args.output
                server.lock = threading.Lock()
                server.token = secrets.token_urlsafe(32)
                server.auto_pair = True
                server.cad = cad
                server.product = 'Jade Lease Studio'
                server.supported_units = [{'project': 'Palm Square', 'unit': 'F18'}]
                args.desktop_token.write_text(server.token, encoding='utf-8')
                # Closing the native app's stdin pipe ends its worker and engine.
                threading.Thread(target=lambda: (sys.stdin.buffer.read(), server.shutdown()), daemon=True).start()
                threading.Thread(target=lambda: (cad.app.wait(), server.shutdown()), daemon=True).start()
                server.serve_forever(poll_interval=0.5)
        finally:
            cad.close()
            args.desktop_token.unlink(missing_ok=True)


if __name__ == '__main__':
    main()

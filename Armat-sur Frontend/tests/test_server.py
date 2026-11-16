"""Save-request security tests. All writes use an isolated temporary directory."""
import importlib.util
import io
import json
from email.message import Message
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

with patch('sys.argv', ['serve.py']):
    spec = importlib.util.spec_from_file_location('armat_server', Path(__file__).resolve().parents[1] / 'serve.py')
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)


class SaveSecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='armat-server-test-')
        self.addCleanup(self.tmp.cleanup)
        self.patch = patch.object(server, 'SAVES_DIR', self.tmp.name)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.save = Path(self.tmp.name) / 'test.json'
        self.original = {'branches': {'main': {}}, 'messages': {'original': {}}}
        self.save.write_text(json.dumps(self.original), encoding='utf-8')

    def request(self, changes=None, path='/save?name=test', method='POST', payload=None):
        headers = {'Host': 'localhost:8000', 'Origin': 'http://localhost:8000',
                   'Content-Type': 'application/json', 'X-ArmatSur-Request': '1',
                   'Sec-Fetch-Site': 'same-origin'}
        headers.update(changes or {})
        body = json.dumps(payload if payload is not None else {'branches': {}, 'messages': {}, 'meta': {'name': 'new'}}).encode()
        h = server.Handler.__new__(server.Handler)
        h.server = SimpleNamespace(server_address=('127.0.0.1', 8000))
        h.path = path
        h.headers = Message()
        for k, v in headers.items():
            if v is not None:
                h.headers[k] = v
        h.headers['Content-Length'] = str(len(body))
        h.rfile, h.wfile = io.BytesIO(body), io.BytesIO()
        statuses = []
        h.send_response = statuses.append
        h.send_header = lambda *args: None
        h.end_headers = lambda: None
        getattr(h, 'do_' + method)()
        return statuses[0], h.wfile.getvalue()

    def test_same_origin_save_and_load(self):
        self.assertEqual(self.request()[0], 200)
        code, body = self.request(path='/load?name=test', method='GET')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['meta']['name'], 'new')

    def test_numeric_loopback_and_custom_port(self):
        self.assertEqual(self.request({'Host': '127.0.0.1:8000', 'Origin': 'http://127.0.0.1:8000'})[0], 200)

    def test_cross_site_write_cannot_overwrite_existing_save(self):
        for headers in [
            {'Origin': 'http://untrusted.example'},
            {'Origin': 'null'},
            {'Sec-Fetch-Site': 'cross-site'},
            {'Origin': 'http://localhost:9000'},
            {'Host': 'untrusted.example:8000', 'Origin': 'http://untrusted.example:8000'},
            {'Host': 'localhost:9000', 'Origin': 'http://localhost:9000'},
            {'X-ArmatSur-Request': None},
            {'Origin': None, 'Sec-Fetch-Site': None, 'X-ArmatSur-Request': None, 'Content-Type': 'text/plain'},
        ]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers)[0], 403)
                self.assertEqual(json.loads(self.save.read_text()), self.original)

    def test_simple_content_types_rejected_even_with_header(self):
        for content_type in ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']:
            with self.subTest(content_type=content_type):
                self.assertEqual(self.request({'Content-Type': content_type})[0], 415)
                self.assertEqual(json.loads(self.save.read_text()), self.original)

    def test_rebinding_host_cannot_read_sessions(self):
        self.assertEqual(self.request({'Host': 'untrusted.example:8000'}, path='/sessions', method='GET')[0], 403)

    def test_cli_json_with_request_header_and_no_origin_allowed(self):
        self.assertEqual(self.request({'Origin': None, 'Sec-Fetch-Site': None})[0], 200)

    def test_log_endpoint_uses_same_checks(self):
        self.assertEqual(self.request({'Origin': 'http://untrusted.example'}, path='/log')[0], 403)
        self.assertEqual(self.request(path='/log')[0], 204)


class DeleteSecurityTests(unittest.TestCase):
    setUp = SaveSecurityTests.setUp
    request = SaveSecurityTests.request

    def test_delete_removes_only_the_named_save(self):
        other = Path(self.tmp.name) / 'other.json'
        other.write_text('{}')
        code, body = self.request(path='/delete?name=test')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body), {'deleted': 'test'})
        self.assertFalse(self.save.exists())
        self.assertTrue(other.exists())
        code, body = self.request(path='/sessions', method='GET')
        self.assertEqual([s['name'] for s in json.loads(body)['sessions']], ['other'])
        self.assertEqual(self.request(path='/delete?name=test')[0], 404)

    def test_delete_rejects_cross_site_requests(self):
        for headers in [{'Origin': 'http://untrusted.example'}, {'X-ArmatSur-Request': None},
                        {'Host': 'untrusted.example:8000'}, {'Sec-Fetch-Site': 'cross-site'}]:
            self.assertEqual(self.request(headers, path='/delete?name=test')[0], 403)
            self.assertTrue(self.save.exists())
        self.assertEqual(self.request({'Content-Type': 'text/plain'}, path='/delete?name=test')[0], 415)
        self.assertTrue(self.save.exists())

    def test_delete_never_sanitizes_a_name_into_another_target(self):
        for query in ['', '?name=', '?name=../test', '?name=..%5Ctest', '?name=test%00',
                      '?name=%20test', '?name=test&name=other', '?name=test:stream', '?name=' + 'x' * 61]:
            with self.subTest(query=query):
                self.assertEqual(self.request(path='/delete' + query)[0], 400)
                self.assertTrue(self.save.exists())

    def test_delete_refuses_resolved_paths_outside_saves(self):
        realpath = server.os.path.realpath
        outside = str(Path(self.tmp.name).parent / 'outside.json')
        with patch.object(server.os.path, 'realpath', side_effect=lambda p: outside if p.endswith('test.json') else realpath(p)):
            self.assertEqual(self.request(path='/delete?name=test')[0], 400)
        self.assertTrue(self.save.exists())

    def test_delete_permission_error_is_reported_without_touching_save(self):
        with patch.object(server.os, 'unlink', side_effect=PermissionError('private path')):
            code, body = self.request(path='/delete?name=test')
        self.assertEqual(code, 500)
        self.assertNotIn(b'private path', body)
        self.assertTrue(self.save.exists())


class ProviderRelayTests(SaveSecurityTests):
    def response(self, status=200, chunks=None):
        from unittest.mock import Mock
        conn = Mock()
        response = conn.getresponse.return_value
        response.status = status
        response.getheader.return_value = 'text/event-stream'
        response.read1.side_effect = chunks or [b'data: {"choices":[]}\n\n', b'data: [DONE]\n\n', b'']
        return conn

    def test_stream_passthrough_uses_fixed_host_and_minimal_headers(self):
        conn = self.response()
        payload = {'model': 'example', 'messages': [{'role':'user','content':'hello'}], 'stream':True}
        with patch.object(server.http.client, 'HTTPSConnection', return_value=conn) as connect:
            code, body = self.request({'Authorization':'Bearer test-key'}, '/api/abliteration/chat/completions', payload=payload)
        self.assertEqual(code, 200)
        self.assertIn(b'[DONE]', body)
        connect.assert_called_once_with('api.abliteration.ai', timeout=120)
        args, kwargs = conn.request.call_args
        self.assertEqual(args, ('POST','/v1/chat/completions'))
        self.assertEqual(json.loads(kwargs['body']),payload)
        self.assertEqual(kwargs['headers']['Authorization'],'Bearer test-key')
        self.assertNotIn('Origin', kwargs['headers'])
        conn.close.assert_called_once()

    def test_model_list_is_upstream_get(self):
        conn = self.response(chunks=[b'{"data":[]}',b''])
        with patch.object(server.http.client, 'HTTPSConnection', return_value=conn):
            code, body = self.request({'Authorization':'Bearer test-key'}, '/api/abliteration/models', payload={})
        self.assertEqual(code,200)
        self.assertEqual(json.loads(body),{'data':[]})
        self.assertEqual(conn.request.call_args.args,('GET','/v1/models'))
        self.assertIsNone(conn.request.call_args.kwargs['body'])

    def test_untrusted_or_unknown_requests_never_connect(self):
        with patch.object(server.http.client, 'HTTPSConnection') as connect:
            for headers,path,expected in [
                ({'Origin':'https://evil.example'},'/api/abliteration/models',403),
                ({'X-ArmatSur-Request':None},'/api/abliteration/models',403),
                ({'Host':'evil.example:8000'},'/api/abliteration/models',403),
                ({},'/api/abliteration/models',401),
                ({'Authorization':'Bearer test-key'},'/api/abliteration/https://evil.example',404),
                ({'Authorization':'Bearer test-key'},'/api/abliteration/models?url=https://evil.example',400),
            ]:
                with self.subTest(path=path,headers=headers):
                    self.assertEqual(self.request(headers,path)[0],expected)
            connect.assert_not_called()

    def test_redirect_is_not_followed_and_connection_errors_do_not_expose_secrets(self):
        conn = self.response(status=302)
        with patch.object(server.http.client, 'HTTPSConnection', return_value=conn):
            self.assertEqual(self.request({'Authorization':'Bearer secret'},'/api/abliteration/models')[0],502)
        conn.request.side_effect = OSError('secret')
        with patch.object(server.http.client, 'HTTPSConnection', return_value=conn):
            code,body = self.request({'Authorization':'Bearer secret'},'/api/abliteration/models')
        self.assertEqual(code,502)
        self.assertNotIn(b'secret',body)

    def test_client_disconnect_closes_upstream(self):
        conn = self.response()
        with patch.object(server.http.client, 'HTTPSConnection', return_value=conn):
            # A write failure at the streaming stage is a normal stopped request.
            conn.getresponse.return_value.read1.side_effect = BrokenPipeError()
            self.request({'Authorization':'Bearer test-key'},'/api/abliteration/chat/completions')
        conn.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()

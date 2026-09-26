"""Local verification of deployment response headers and gzip, not an AWS emulator."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import re
from deploy_cloud import encode

ROOT = Path('dist').resolve()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = unquote(urlsplit(self.path).path).lstrip('/') or 'index.html'
        file = (ROOT / path).resolve()
        if not file.is_relative_to(ROOT) or not file.is_file():
            self.send_error(404)
            return
        immutable = path.startswith('assets/') or bool(re.match(r'data/[^/]+/[0-9a-f]{16}/', path))
        body, headers = encode(file, path if immutable else 'releases/local/' + path)
        self.send_response(200)
        for key in ('ContentType', 'ContentEncoding', 'CacheControl'):
            self.send_header({'ContentType': 'Content-Type', 'ContentEncoding': 'Content-Encoding', 'CacheControl': 'Cache-Control'}[key], headers[key])
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


if __name__ == '__main__':
    print('Cloud-header preview: http://127.0.0.1:4175', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 4175), Handler).serve_forever()

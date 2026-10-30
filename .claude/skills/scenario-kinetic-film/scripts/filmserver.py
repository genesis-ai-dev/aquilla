# filmserver.py: serve a film folder on a free local port (used by render.py, mix.py and finish.py).
import http.server, socketserver, threading, functools, socket, os
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
def serve(folder):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    h = functools.partial(Quiet, directory=os.path.abspath(folder))
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', port), h); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{port}/', srv

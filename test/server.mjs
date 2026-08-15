// Local, fully-controlled HTTP test target for the Chronoscope test suite.
// Deliberately NOT any real site — every scenario (slow/fast, with/without
// Server-Timing, custom status) is driven entirely by query params, and
// connection reuse is verified via a server-side TCP connection counter
// (ground truth — Navigation Timing's own connect/dns fields read ~0 for
// loopback connections regardless of whether they're actually fresh or
// reused, so they can't be trusted to prove reuse on their own).
import http from 'http';

export function startTestServer() {
  let connectionCount = 0;
  let lastHeaders = null;
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    lastHeaders = req.headers;
    const delayMs = Number(url.searchParams.get('delayMs') || 0);
    const serverTimingMs = url.searchParams.get('serverTimingMs');
    const serverTimingName = url.searchParams.get('serverTimingName') || 'origin-rtt';
    const status = Number(url.searchParams.get('status') || 200);

    const send = () => {
      const headers = { 'Content-Type': 'text/html' };
      if (serverTimingMs !== null) {
        headers['Server-Timing'] = `${serverTimingName};dur=${serverTimingMs}`;
      }
      res.writeHead(status, headers);
      res.end(`<html><head><title>chronoscope-test</title></head><body>chronoscope-test-page ${Date.now()}</body></html>`);
    };
    if (delayMs > 0) {
      setTimeout(send, delayMs);
    } else {
      send();
    }
  });

  server.on('connection', (socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        getConnectionCount: () => connectionCount,
        resetConnectionCount: () => {
          connectionCount = 0;
        },
        getLastHeaders: () => lastHeaders,
        async stop() {
          for (const s of sockets) s.destroy();
          await new Promise((res2) => server.close(res2));
        },
      });
    });
  });
}

// Mock upstream server for testing upstreamFetchAndConsume
// Spins up on 127.0.0.1:0 (auto-assigned port).
import http from 'node:http';

export function startMockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((e) => {
        try { res.writeHead(500); res.end('mock error: ' + e.message); } catch {}
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

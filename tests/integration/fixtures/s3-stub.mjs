// A tiny S3 HTTP fixture for the examples' PUT and GET requests; it does not verify signatures.
import http from 'node:http';
const objects = new Map();
http
  .createServer((req, res) => {
    const key = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"test"' }).end();
      });
    } else if ((req.method === 'GET' || req.method === 'HEAD') && objects.has(key)) {
      res
        .writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': objects.get(key).length,
          'last-modified': new Date().toUTCString(),
        })
        .end(req.method === 'HEAD' ? undefined : objects.get(key));
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res
        .writeHead(404, { 'content-type': 'application/xml' })
        .end('<Error><Code>NoSuchKey</Code></Error>');
    }
  })
  .listen(9000, '0.0.0.0');

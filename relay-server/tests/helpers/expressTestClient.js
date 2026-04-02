'use strict';

const http = require('http');
const { Duplex } = require('stream');

class MockSocket extends Duplex {
  constructor() {
    super();
    this.remoteAddress = '127.0.0.1';
    this.remotePort = 12345;
    this.encrypted = false;
    this.destroyed = false;
  }

  _read() {}

  _write(_chunk, _encoding, callback) {
    callback();
  }

  _final(callback) {
    callback();
  }

  setTimeout() {}

  setNoDelay() {}

  setKeepAlive() {}

  destroy(err) {
    this.destroyed = true;
    if (err) this.emit('error', err);
    this.emit('close');
  }
}

function createClient(app) {
  function request(method, path, { body, token, headers = {}, cookie } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      function finalize(res, chunks) {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        const headers = res.getHeaders();
        if (headers['set-cookie'] && !Array.isArray(headers['set-cookie'])) {
          headers['set-cookie'] = [headers['set-cookie']];
        }
        let parsedBody = text;
        try {
          parsedBody = text ? JSON.parse(text) : null;
        } catch {}
        resolve({
          status: res.statusCode,
          headers,
          body: parsedBody,
          text,
        });
      }

      const socket = new MockSocket();
      const req = new http.IncomingMessage(socket);
      req.method = method.toUpperCase();
      req.url = path;
      req.originalUrl = path;
      req.httpVersion = '1.1';
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 1;
      req.connection = socket;

      const reqHeaders = {};
      for (const [key, value] of Object.entries(headers || {})) {
        reqHeaders[String(key).toLowerCase()] = value;
      }
      if (token && reqHeaders.authorization === undefined) {
        reqHeaders.authorization = `Bearer ${token}`;
      }
      if (cookie && reqHeaders.cookie === undefined) {
        reqHeaders.cookie = cookie;
      }

      let payload = null;
      if (body !== undefined) {
        payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        if (reqHeaders['content-type'] === undefined) reqHeaders['content-type'] = 'application/json';
        reqHeaders['content-length'] = String(payload.length);
      }

      req.headers = reqHeaders;
      req.rawHeaders = Object.entries(reqHeaders).flatMap(([key, value]) => [key, String(value)]);

      const res = new http.ServerResponse(req);
      const chunks = [];
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);

      res.write = (chunk, encoding, callback) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        return origWrite(chunk, encoding, callback);
      };

      res.end = (chunk, encoding, callback) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        const result = origEnd(chunk, encoding, callback);
        finalize(res, chunks);
        return result;
      };

      res.assignSocket(socket);
      req.res = res;
      res.req = req;

      res.on('error', reject);
      req.on('error', reject);
      socket.on('error', reject);

      try {
        app.handle(req, res, (err) => {
          if (err) return reject(err);
          if (!res.writableEnded) {
            if (res.statusCode === 200) res.statusCode = 404;
            res.end();
          }
        });

        process.nextTick(() => {
          if (payload?.length) req.push(payload);
          req.push(null);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  return {
    get: (path, opts) => request('GET', path, opts),
    post: (path, opts) => request('POST', path, opts),
    put: (path, opts) => request('PUT', path, opts),
    patch: (path, opts) => request('PATCH', path, opts),
    delete: (path, opts) => request('DELETE', path, opts),
    close: () => Promise.resolve(),
  };
}

module.exports = { createClient };

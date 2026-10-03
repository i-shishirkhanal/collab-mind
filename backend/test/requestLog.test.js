const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requestLog } = require('../src/middleware/requestLog');

const run = (headers, opts) => {
  const lines = [];
  const req = { method: 'GET', originalUrl: '/api/x?token=secret', get: (h) => headers[h.toLowerCase()], user: { id: 'u1' }, ip: '1.2.3.4' };
  const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; } });
  requestLog({ write: (l) => lines.push(l), ...opts })(req, res, () => {});
  res.emit('finish');
  return { req, res, lines };
};

test('assigns a request id, echoes it, and logs one JSON line without the query string', () => {
  const { req, res, lines } = run({}, { json: true });
  assert.match(req.id, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers['X-Request-Id'], req.id);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.path, '/api/x');
  assert.equal(entry.status, 200);
  assert.equal(entry.user, 'u1');
  assert.ok(!lines[0].includes('secret'));
});

test('honours a sane client request id and rejects a hostile one', () => {
  assert.equal(run({ 'x-request-id': 'abc-12345678' }, { json: false }).req.id, 'abc-12345678');
  assert.notEqual(run({ 'x-request-id': 'bad id\r\nSet-Cookie: x' }, { json: false }).req.id, 'bad id\r\nSet-Cookie: x');
});

test('writes nothing when JSON logging is off (development uses morgan)', () => {
  assert.equal(run({}, { json: false }).lines.length, 0);
});

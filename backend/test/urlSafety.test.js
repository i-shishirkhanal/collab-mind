// Phase 4 regression: the backend SSRF pre-check must treat every spelling of an internal address as internal.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPublicHttpUrl, isPrivateAddress } = require('../src/utils/urlSafety');

const blocked = async (u) => assert.rejects(assertPublicHttpUrl(u), (e) => e.status === 400, `${u} must be rejected`);

test('internal IPv4 in every URL spelling is rejected', async () => {
  for (const u of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://169.254.169.254/latest/meta-data',
    'http://10.1.2.3/', 'http://192.168.0.5/', 'http://172.16.0.1/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://localhost./', 'http://x.internal/']) {
    await blocked(u);
  }
});

test('IPv6 forms that embed or alias internal IPv4 are rejected (regression: [::ffff:7f00:1] used to pass)', async () => {
  for (const u of ['http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/',
    'http://[::ffff:10.0.0.1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b::a00:1]/',
    'http://[2002:7f00:1::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[ff02::1]/']) {
    await blocked(u);
  }
});

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('credentials, odd schemes and garbage are rejected', async () => {
  for (const u of ['http://user:pw@example.com/', 'ftp://example.com/', 'file:///etc/passwd', 'not a url', 'javascript:alert(1)']) await blocked(u);
});

const dns = require('dns').promises;
const net = require('net');
const { httpError } = require('./http');

/** True for loopback, private, link-local, CGNAT, multicast, reserved and ULA ranges. */
const isPrivateAddress = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower === '::' || lower === '::1' ||
      lower.startsWith('fc') || lower.startsWith('fd') ||
      lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') ||
      lower.startsWith('ff')
    );
  }
  return true; // not an IP we understand: refuse
};

/**
 * Rejects URLs a workspace member must not be able to make the AI service
 * fetch: non-http(s), embedded credentials, and hosts that are (or resolve to)
 * internal addresses such as the cloud metadata endpoint, localhost, or the
 * docker network. Throws a 400 httpError.
 */
const assertPublicHttpUrl = async (value) => {
  const bad = () => httpError(400, 'That URL cannot be added. Use a public http(s) address.');
  let url;
  try { url = new URL(value); } catch { throw bad(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw bad();

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw bad();

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw bad();
    return url;
  }

  let addresses;
  try { addresses = await dns.lookup(host, { all: true }); } catch { throw bad(); }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw bad();
  return url;
};

module.exports = { assertPublicHttpUrl, isPrivateAddress };

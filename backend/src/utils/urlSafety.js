const dns = require('dns').promises;
const net = require('net');
const { httpError } = require('./http');

/** Expand any valid IPv6 text form (including an embedded dotted IPv4 tail) to 8 16-bit groups. */
const ipv6Groups = (ip) => {
  let text = ip.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, rest] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = rest === undefined ? [] : (rest ? rest.split(':') : []);
  const fill = rest === undefined ? [] : new Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
};

const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

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
    const g = ipv6Groups(ip);
    if (g.length !== 8 || g.some(Number.isNaN)) return true;
    const zeros = (n) => g.slice(0, n).every((x) => x === 0);
    // ::/96 (unspecified, loopback, deprecated IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped):
    // judge by the embedded IPv4 address; `::` and `::1` fall out as 0.0.0.0 / 0.0.0.1.
    if (zeros(5) && (g[5] === 0 || g[5] === 0xffff)) return isPrivateAddress(v4FromGroups(g[6], g[7]));
    // 64:ff9b::/96 NAT64 -> embedded IPv4; 64:ff9b:1::/48 local-use NAT64 -> refuse
    if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).every((x) => x === 0) ? isPrivateAddress(v4FromGroups(g[6], g[7])) : true;
    // 2002::/16 6to4 -> embedded IPv4
    if (g[0] === 0x2002) return isPrivateAddress(v4FromGroups(g[1], g[2]));
    return (
      (g[0] & 0xfe00) === 0xfc00 ||  // fc00::/7 unique local
      (g[0] & 0xffc0) === 0xfe80 ||  // fe80::/10 link-local
      (g[0] & 0xffc0) === 0xfec0 ||  // fec0::/10 site-local (deprecated)
      (g[0] & 0xff00) === 0xff00 ||  // ff00::/8 multicast
      (g[0] === 0x2001 && g[1] === 0x0db8) // documentation
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

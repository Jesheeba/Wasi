// SSRF guard for URLs a client types in that the server then calls (first
// use: a WooCommerce store URL - build-docs/features/woocommerce-integration.md).
// The URL must be https and every address its host resolves to must be
// public: no loopback, private, link-local (incl. cloud metadata 169.254.x),
// CGNAT, multicast or unique-local IPv6. Callers must also fetch with
// redirect: 'error' so a public URL can't bounce to an internal one.
const dns = require('dns').promises;
const net = require('net');

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIPv4(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8')
    || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

// Exposed so tests can replace DNS resolution for fake store hosts.
const resolver = { lookup: (host) => dns.lookup(host, { all: true }) };

// Returns the normalised origin + path (no trailing slash, no query/hash).
// Throws an Error with a client-readable message on anything unsafe.
async function assertPublicHttpsUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new Error('Enter the full store address, for example https://shop.example.com');
  }
  if (url.protocol !== 'https:') throw new Error('The store address must start with https://');
  if (url.username || url.password) throw new Error('Remove the username/password from the store address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That store address is not reachable from the internet.');
  }
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host }];
  else {
    try {
      addresses = await resolver.lookup(host);
    } catch {
      throw new Error(`Could not find ${host}. Check the store address.`);
    }
  }
  if (!addresses.length || addresses.some((a) => isPrivateIP(a.address))) {
    throw new Error('That store address is not reachable from the internet.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

module.exports = { assertPublicHttpsUrl, isPrivateIP, resolver };

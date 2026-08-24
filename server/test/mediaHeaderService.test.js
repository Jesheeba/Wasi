const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isMediaHeaderType, buildMediaHeaderComponent,
  isBlockedAddress, assertPublicHttpsUrl, MediaResolutionError,
} = require('../src/services/mediaHeaderService');

test('isMediaHeaderType: true for IMAGE/VIDEO/DOCUMENT, false for TEXT/NONE/undefined', () => {
  assert.equal(isMediaHeaderType('IMAGE'), true);
  assert.equal(isMediaHeaderType('VIDEO'), true);
  assert.equal(isMediaHeaderType('DOCUMENT'), true);
  assert.equal(isMediaHeaderType('TEXT'), false);
  assert.equal(isMediaHeaderType('NONE'), false);
  assert.equal(isMediaHeaderType(null), false);
  assert.equal(isMediaHeaderType(undefined), false);
});

test('buildMediaHeaderComponent: IMAGE/VIDEO use just {id}, no filename key', () => {
  assert.deepEqual(buildMediaHeaderComponent('IMAGE', 'media123', null), {
    type: 'header',
    parameters: [{ type: 'image', image: { id: 'media123' } }],
  });
  assert.deepEqual(buildMediaHeaderComponent('VIDEO', 'media456', 'ignored.mp4'), {
    type: 'header',
    parameters: [{ type: 'video', video: { id: 'media456' } }],
  });
});

test('buildMediaHeaderComponent: DOCUMENT includes filename when present', () => {
  assert.deepEqual(buildMediaHeaderComponent('DOCUMENT', 'media789', 'invoice.pdf'), {
    type: 'header',
    parameters: [{ type: 'document', document: { id: 'media789', filename: 'invoice.pdf' } }],
  });
});

test('buildMediaHeaderComponent: DOCUMENT with no filename omits the key rather than sending null', () => {
  const component = buildMediaHeaderComponent('DOCUMENT', 'media789', null);
  assert.deepEqual(component.parameters[0].document, { id: 'media789' });
});

// --- isBlockedAddress / assertPublicHttpsUrl — resolveMediaIdFromUrl's
// SSRF guard for a CRM-supplied headerMediaUrl. Pure enough to test without
// a network: dns.lookup on an IP literal resolves it locally, no real DNS
// query — same "no DB, no network" reasoning as flowEngine.test.js. ---

test('isBlockedAddress: blocks loopback, RFC1918, and link-local (cloud metadata) IPv4', () => {
  assert.equal(isBlockedAddress('127.0.0.1'), true);
  assert.equal(isBlockedAddress('10.1.2.3'), true);
  assert.equal(isBlockedAddress('172.16.5.5'), true);
  assert.equal(isBlockedAddress('192.168.1.1'), true);
  assert.equal(isBlockedAddress('169.254.169.254'), true); // cloud instance-metadata endpoint
});

test('isBlockedAddress: allows ordinary public IPv4', () => {
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
});

test('isBlockedAddress: blocks IPv6 loopback, unique-local, and link-local', () => {
  assert.equal(isBlockedAddress('::1'), true);
  assert.equal(isBlockedAddress('fe80::1'), true);
  assert.equal(isBlockedAddress('fd00::1'), true);
});

test('isBlockedAddress: sees through an IPv4-mapped IPv6 address to the blocked IPv4 underneath', () => {
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
});

test('assertPublicHttpsUrl: rejects non-https URLs before any network lookup', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl('http://example.com/file.pdf'),
    MediaResolutionError
  );
});

test('assertPublicHttpsUrl: rejects an https URL whose host is a blocked IP literal', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data/'),
    MediaResolutionError
  );
});

test('assertPublicHttpsUrl: rejects malformed input', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl('not a url'),
    MediaResolutionError
  );
});

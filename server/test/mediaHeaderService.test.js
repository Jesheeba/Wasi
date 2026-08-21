const test = require('node:test');
const assert = require('node:assert/strict');
const { isMediaHeaderType, buildMediaHeaderComponent } = require('../src/services/mediaHeaderService');

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

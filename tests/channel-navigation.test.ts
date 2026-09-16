import assert from 'node:assert/strict';
import test from 'node:test';
import { nextEnabledChannel } from '../lib/channel-navigation.ts';

test('brightness navigation skips unchecked channels, ends at Merge and preserves settings', () => {
  const channels = [
    { id: 'dapi', enabled: true, displayMin: 144, displayMax: 2543 },
    { id: 'td', enabled: false, displayMin: 0, displayMax: 4095 },
    { id: '488', enabled: true, displayMin: 100, displayMax: 1800 },
    { id: '647', enabled: true, displayMin: 20, displayMax: 900 },
  ];
  const original = structuredClone(channels);
  assert.equal(nextEnabledChannel(channels, 'dapi'), channels[2]);
  assert.equal(nextEnabledChannel(channels, '488'), channels[3]);
  assert.equal(nextEnabledChannel(channels, '647'), null);
  assert.equal(nextEnabledChannel(channels, 'missing'), channels[0]);
  assert.equal(nextEnabledChannel([channels[0]], 'dapi'), null);
  assert.equal(nextEnabledChannel([channels[1]], 'td'), null);
  assert.equal(nextEnabledChannel([], ''), null);
  assert.deepEqual(channels, original);
});

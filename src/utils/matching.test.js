import test from 'node:test';
import assert from 'node:assert/strict';
import { locationIsValid } from './matching.js';

test('matching requires actual numeric GPS coordinates and rejects missing or invalid pins', () => {
  for (const value of [null,{}, {latitude:null,longitude:null}, {latitude:'13',longitude:'123'}, {latitude:91,longitude:0}, {latitude:0,longitude:181}, {latitude:NaN,longitude:0}]) assert.equal(locationIsValid(value),false);
  assert.equal(locationIsValid({latitude:0,longitude:0}),true);
  assert.equal(locationIsValid({latitude:13.62,longitude:123.19}),true);
});

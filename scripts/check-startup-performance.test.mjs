import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePerformanceBudget, parsePerformanceThreshold } from './check-startup-performance.mjs';

test('classifies values below indicator, above indicator, and above budget', () => {
  assert.deepEqual(evaluatePerformanceBudget(40, 50, 175), { warning: false, exceeded: false });
  assert.deepEqual(evaluatePerformanceBudget(151, 50, 175), { warning: true, exceeded: false });
  assert.deepEqual(evaluatePerformanceBudget(176, 50, 175), { warning: true, exceeded: true });
});

test('parses positive configurable thresholds and rejects invalid values', () => {
  assert.equal(parsePerformanceThreshold(undefined, 50, 'indicator'), 50);
  assert.equal(parsePerformanceThreshold('75.5', 50, 'indicator'), 75.5);
  assert.throws(() => parsePerformanceThreshold('0', 50, 'indicator'), /indicator must be a positive number/);
  assert.throws(() => parsePerformanceThreshold('fast', 50, 'indicator'), /indicator must be a positive number/);
});

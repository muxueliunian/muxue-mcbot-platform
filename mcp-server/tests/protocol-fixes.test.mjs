import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { applyProtocolFixes } from '../dist/protocol-fixes.js';

const require = createRequire(import.meta.url);

function potionContents(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((c) => potionContents(c, out));
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'potion_contents' && Array.isArray(v) && v[0] === 'container') out.push(v[1]);
    else potionContents(v, out);
  }
  return out;
}

test('1.21.1 的 potion_contents 去掉 1.21.2 才有的 customName（不然带药水的箱子打不开）；只改一次', () => {
  const protocol = require('minecraft-data')('1.21.1').protocol;
  applyProtocolFixes();
  const defs = potionContents(protocol);
  assert.ok(defs.length > 0, '协议里应该有 potion_contents');
  for (const fields of defs) {
    assert.deepEqual(fields.map((f) => f.name), ['potionId', 'customColor', 'customEffects']);
  }
  assert.deepEqual(applyProtocolFixes(), []);
});

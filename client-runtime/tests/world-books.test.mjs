import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlaceBook } from '../dist/places.js';
import { MachineBook } from '../dist/machines.js';

const position = { x: 10, y: 64, z: 20 }, dimension = 'minecraft:overworld';
const cases = [
  { folder: 'places', Book: PlaceBook, add: b => b.set({ name: '家', dimension, position }), remove: b => b.remove('家') },
  { folder: 'machines', Book: MachineBook, add: b => b.track({ dimension, position, block: 'minecraft:furnace', queued: 12, loadedAt: 1, readyAt: 2 }), remove: b => b.forget(dimension, position) },
];
for (const { folder, Book, add, remove } of cases) {
  test(`${folder}: Chinese worlds stay separate and stored world identity is checked`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-world-books-'));
    t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
    add(new Book(dir, 'sp-世界一'));
    assert.equal(new Book(dir, 'sp-世界二').list().length, 0);
    add(new Book(dir, 'sp-世界二'));
    remove(new Book(dir, 'sp-世界二'));
    assert.equal(new Book(dir, 'sp-世界一').list().length, 1);
    assert.equal(new Book(dir, 'sp-世界二').list().length, 0);
    const files = fs.readdirSync(path.join(dir, folder));
    assert.equal(files.length, 2);
    const file = files.map(f => path.join(dir, folder, f)).find(f => JSON.parse(fs.readFileSync(f, 'utf8')).worldId === 'sp-世界一');
    assert.ok(file, 'file stores its original worldId');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...saved, worldId: 'sp-世界二' }));
    assert.equal(new Book(dir, 'sp-世界一').list().length, 0, 'wrong identity is not loaded');
  });
  test(`${folder}: old ASCII records remain readable, ambiguous old Chinese records are ignored`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-world-books-'));
    t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
    const old = new Book(); add(old);
    fs.mkdirSync(path.join(dir, folder));
    fs.writeFileSync(path.join(dir, folder, 'test-world.json'), JSON.stringify(old.list()));
    fs.writeFileSync(path.join(dir, folder, 'sp-___.json'), JSON.stringify(old.list()));
    const loaded = new Book(dir, 'test-world');
    assert.equal(loaded.list().length, 1);
    add(loaded);
    assert.equal(new Book(dir, 'test-world').list().length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, folder, 'test-world.json'), 'utf8')).worldId, 'test-world');
    assert.equal(new Book(dir, 'sp-世界一').list().length, 0);
  });
}

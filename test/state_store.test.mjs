import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createStateStore } from '../lib/state_store.mjs';

const TEST_DATA_DIR = path.join(process.cwd(), 'test-data-state');

test('StateStore', async (t) => {
  await t.before(async () => {
    await mkdir(TEST_DATA_DIR, { recursive: true });
  });

  await t.after(async () => {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  await t.test('JsonStateStore - basic read/write', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'test.json');
    const store = createStateStore({
      backend: 'json',
      jsonFilePath: filePath
    });

    await store.init();
    const initial = await store.read();
    assert.ok(Array.isArray(initial.users));

    const newState = { ...initial, users: [{ id: '1', name: 'test' }] };
    await store.write(newState);

    const readBack = await store.read();
    assert.equal(readBack.users.length, 1);
    assert.equal(readBack.users[0].name, 'test');
  });

  await t.test('SqliteStateStore - basic read/write', async () => {
    const sqlitePath = path.join(TEST_DATA_DIR, 'test.db');
    const jsonPath = path.join(TEST_DATA_DIR, 'fallback.json');
    const store = createStateStore({
      backend: 'sqlite',
      sqliteFilePath: sqlitePath,
      jsonFilePath: jsonPath
    });

    await store.init();
    const initial = await store.read();
    assert.ok(Array.isArray(initial.projects));

    const newState = { ...initial, projects: [{ id: 'p1', title: 'Test Project' }] };
    await store.write(newState);

    const readBack = await store.read();
    assert.equal(readBack.projects.length, 1);
    assert.equal(readBack.projects[0].title, 'Test Project');
  });
});

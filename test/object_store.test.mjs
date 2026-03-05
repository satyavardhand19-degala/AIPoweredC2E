import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createObjectStore } from '../lib/object_store.mjs';

const TEST_UPLOAD_DIR = path.join(process.cwd(), 'test-uploads');

test('ObjectStore', async (t) => {
  await t.before(async () => {
    await mkdir(TEST_UPLOAD_DIR, { recursive: true });
  });

  await t.after(async () => {
    await rm(TEST_UPLOAD_DIR, { recursive: true, force: true });
  });

  await t.test('LocalObjectStore - put/get', async () => {
    const store = createObjectStore({
      backend: 'local',
      baseDir: TEST_UPLOAD_DIR,
      baseUrl: '/uploads'
    });

    await store.init();
    const content = Buffer.from('test data');
    const result = await store.put({
      keyPrefix: 'prefix',
      originalName: 'test.txt',
      buffer: content,
      mimeType: 'text/plain'
    });

    assert.ok(result.fileName.startsWith('prefix_'));
    assert.ok(result.url.includes(result.fileName));
    assert.equal(result.sizeBytes, content.length);

    const { data } = await store.get({ fileName: result.fileName });
    assert.equal(data.toString(), 'test data');
  });
});

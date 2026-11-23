import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applyPatch, assembleSlices, sha256Hex } from '../service/delta.mjs';
import { startSources } from '../sources/server.mjs';

const inventory = JSON.parse(await readFile(new URL('../data/cache-inventory.json', import.meta.url)));

test('更新块按公示区间装配并落到目标指纹', async () => {
  const source = await startSources();
  try {
    const media = await (await fetch(source.url + '/publisher/media')).json();
    const a2 = media.find(item => item.asset === 'a2');
    const parts = [];
    for (const slice of a2.slices) {
      const response = await fetch(source.url + slice.url);
      assert.equal(response.status, 200);
      parts.push({ range: slice.range, bytes: Buffer.from(await response.arrayBuffer()) });
    }
    const patch = assembleSlices(parts);
    assert.equal(sha256Hex(patch), a2.patchSha);
    const base = Buffer.from(inventory.find(item => item.asset === 'a1').base64, 'base64');
    const output = applyPatch(base, patch, a2.base);
    assert.equal(sha256Hex(output), a2.sha256);
    assert.equal(output.length, a2.bytes);
    assert.equal(output.toString(), 'AUDIO:plant-root-run2:grove\n');
  } finally {
    await source.close();
  }
});

test('区间不连续或基件不符的更新块被拒绝', () => {
  assert.throws(
    () => assembleSlices([{ range: [1, 2], bytes: Buffer.from('a') }]),
    /不连续/,
  );
  assert.throws(
    () => assembleSlices([{ range: [0, 2], bytes: Buffer.from('a') }]),
    /实收/,
  );
  const patch = Buffer.from('{"base":"x","offset":1,"remove":1,"bytes":"WQ=="}');
  assert.throws(() => applyPatch(Buffer.from('abc'), patch, 'y'), /基件/);
  assert.throws(
    () => applyPatch(Buffer.from('abc'), Buffer.from('{"offset":9,"remove":1,"bytes":"WQ=="}'), null),
    /超出基件/,
  );
});

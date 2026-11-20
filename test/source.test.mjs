import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { startSources } from '../sources/server.mjs';

const probes = JSON.parse(await readFile(new URL('../data/probes.json', import.meta.url)));

test('演练来源按原始发布记录及所处阶段响应', async () => {
  const source = await startSources();
  try {
    for (const probe of probes) {
      const selection = await fetch(source.url + '/scenario/' + probe.stage, { method: 'POST' });
      assert.equal(selection.status, 204, probe.stage);
      const response = await fetch(source.url + probe.path, {
        method: probe.method,
        body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
        headers: probe.body === undefined ? {} : { 'Content-Type': 'application/json' },
      });
      assert.equal(response.status, probe.status, probe.path);
      const contentType = response.headers.get('content-type');
      if (contentType?.startsWith('application/json')) {
        const raw = await response.json();
        let field = raw;
        for (const key of probe.expected.path) field = field[key];
        assert.deepEqual(field, probe.expected.value, probe.path);
      } else if (probe.expected.hex) {
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.toString('hex'), probe.expected.hex, probe.path);
      } else {
        const raw = await response.text();
        assert.ok(raw.includes(probe.expected.includes), probe.path);
      }
    }
    assert.equal(source.calls.length, probes.length);
  } finally {
    await source.close();
  }
});

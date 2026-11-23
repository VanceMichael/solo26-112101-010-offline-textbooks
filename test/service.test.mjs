import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createService } from '../service/server.mjs';
import { startSources } from '../sources/server.mjs';

const INVENTORY = new URL('../data/cache-inventory.json', import.meta.url);
const S1 = '9bf23646925cfb5591e9796f32602d103e0176d451966b51956e51ebd41259ff';
const E1 = '51ac08bc4164f4f24b80fd47618e2a28c13f2745fa0d50f523312c8aeef91323';
const E2 = 'b3ecee624262b1cc490d903ec6cc7a6568ca45575ef024adaa6582056135af98';

async function setup() {
  const source = await startSources();
  const dir = await mkdtemp(join(tmpdir(), 'school-receive-'));
  const service = await createService({
    sourceUrl: source.url,
    port: 0,
    cacheDir: join(dir, 'cache'),
    statePath: join(dir, 'state.json'),
    inventoryPath: INVENTORY,
  });
  return { source, service, dir };
}

async function cleanup(ctx) {
  await ctx.service.close();
  await ctx.source.close();
  await rm(ctx.dir, { recursive: true, force: true });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

const byId = (plan, id) => plan.reservations.find(view => view.reservation === id);

test('初始窗口：给出完备领取证明并按优先级执行', async () => {
  const ctx = await setup();
  try {
    const plan = (await postJson(ctx.service.url + '/sync')).body;
    assert.equal(plan.quota.limit, 4);
    assert.equal(plan.quota.planned, 1);
    assert.equal(plan.quota.remaining, 3);
    assert.equal(plan.disk.used, 81);
    assert.equal(plan.disk.planned, 27);
    assert.equal(plan.disk.free, 12);

    const r1 = byId(plan, 'R1');
    assert.equal(r1.state, 'active');
    assert.equal(r1.offlineReady, true);
    assert.equal(r1.usable.release, 1);
    assert.equal(r1.usable.plan, 'RES-101');
    assert.deepEqual(r1.downloads, []);

    const r3 = byId(plan, 'R3');
    assert.equal(r3.state, 'planned');
    assert.deepEqual(r3.downloads.map(item => [item.ref, item.asset, item.cost]), [['home', 'e2', 1]]);

    const r2 = byId(plan, 'R2');
    assert.equal(r2.state, 'blocked');
    assert.ok(r2.blocking.some(text => text.includes('尚未封版')));
    assert.ok(r2.blocking.some(text => text.includes('接收额度不足')));
    assert.ok(r2.blocking.some(text => text.includes('磁盘空间不足')));
    const [lab, sound] = r2.entries;
    assert.equal(lab.status, 'fetchable');
    assert.equal(lab.cost, 2);
    assert.equal(sound.status, 'fetchable');
    assert.equal(sound.delivery, 'delta');
    assert.equal(sound.cost, 3);

    const report = (await postJson(ctx.service.url + '/receive')).body;
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.downloads.map(item => [item.ref, item.asset, item.state]), [['home', 'e2', 'stored']]);
    assert.deepEqual(report.installs.map(item => [item.device, item.plan]), [['TAB-2', 'RES-302']]);
    assert.equal(byId(report.plan, 'R3').state, 'awaiting-activation');
    assert.equal(byId(report.plan, 'R1').state, 'active');

    const cache = (await getJson(ctx.service.url + '/cache')).body;
    assert.ok(cache.some(item => item.sha256 === E2));
    const s1 = cache.find(item => item.sha256 === S1);
    assert.equal(s1.referencedBy.length, 3);
    assert.ok(s1.referencedBy.every(ref => ref.valid));

    const paths = ctx.source.calls.map(call => `${call.method} ${call.path}`);
    assert.ok(paths.includes('GET /publisher/media/e2'));
    assert.ok(paths.includes('POST /devices/TAB-2/install'));
  } finally {
    await cleanup(ctx);
  }
});

test('封版后额度与磁盘仍不足：保留先开课的可用版本', async () => {
  const ctx = await setup();
  try {
    await postJson(ctx.service.url + '/sync');
    await postJson(ctx.service.url + '/receive');
    await postJson(ctx.source.url + '/scenario/sync');
    const plan = (await postJson(ctx.service.url + '/sync')).body;

    const r2 = byId(plan, 'R2');
    assert.equal(r2.state, 'blocked');
    assert.ok(!r2.blocking.some(text => text.includes('尚未封版')));
    assert.ok(r2.blocking.some(text => text.includes('接收额度不足')));
    assert.ok(r2.blocking.some(text => text.includes('磁盘空间不足')));
    assert.equal(r2.usable.release, 1);
    assert.equal(r2.offlineReady, false);

    assert.equal(byId(plan, 'R1').state, 'active');
    assert.equal(byId(plan, 'R3').state, 'awaiting-activation');

    const cache = (await getJson(ctx.service.url + '/cache')).body;
    assert.ok(cache.some(item => item.sha256 === E1));

    const tab1Posts = ctx.source.calls.filter(call => call.method === 'POST' && call.path.startsWith('/devices/TAB-1/'));
    assert.equal(tab1Posts.length, 0);
  } finally {
    await cleanup(ctx);
  }
});

test('撤回生效：排课标出缺口，另一教材的独立授权继续可用', async () => {
  const ctx = await setup();
  try {
    await postJson(ctx.service.url + '/sync');
    await postJson(ctx.service.url + '/receive');
    await postJson(ctx.source.url + '/scenario/sync');
    await postJson(ctx.service.url + '/sync');
    await postJson(ctx.source.url + '/scenario/revoked');
    const plan = (await postJson(ctx.service.url + '/sync')).body;

    const r1 = byId(plan, 'R1');
    assert.equal(r1.state, 'gap');
    assert.deepEqual(r1.affectedEntries, ['field']);
    assert.ok(r1.blocking.some(text => text.includes('N-11')));
    assert.equal(r1.usable.release, 1);
    assert.equal(r1.offlineReady, false);
    assert.equal(r1.entries.find(entry => entry.ref === 'field').status, 'revoked');
    assert.equal(r1.entries.find(entry => entry.ref === 'lab').status, 'cached');

    const r3 = byId(plan, 'R3');
    assert.equal(r3.state, 'active');
    assert.equal(r3.offlineReady, true);
    assert.equal(r3.entries.find(entry => entry.ref === 'field').status, 'cached');

    const records = (await getJson(ctx.service.url + '/classroom-records')).body;
    assert.equal(records.length, 2);
    const r1Record = records.find(record => record.reservation === 'R1');
    const recordField = r1Record.entries.find(entry => entry.ref === 'field');
    const recordLab = r1Record.entries.find(entry => entry.ref === 'lab');
    assert.equal(recordField.reloadableToday, false);
    assert.ok(recordField.reason.includes('N-11'));
    assert.equal(recordLab.reloadableToday, true);
    const r3Record = records.find(record => record.reservation === 'R3');
    assert.ok(r3Record.entries.every(entry => entry.reloadableToday));

    const forClass = (await getJson(ctx.service.url + '/classroom-records?class=' + encodeURIComponent('三甲'))).body;
    assert.equal(forClass.length, 1);
    assert.equal(forClass[0].reservation, 'R1');

    const cache = (await getJson(ctx.service.url + '/cache')).body;
    const s1 = cache.find(item => item.sha256 === S1);
    const validity = Object.fromEntries(s1.referencedBy.map(ref => [ref.grant, ref.valid]));
    assert.deepEqual(validity, { 'N-11': false, 'N-21': true, 'S-31': true });

    const reselected = (await postJson(ctx.service.url + '/reservations/R1/reselect', { release: 2 })).body;
    assert.equal(reselected.target.release, 2);
    assert.equal(reselected.state, 'partial');
    assert.ok(!reselected.blocking.some(text => text.includes('撤回')));
    assert.ok(reselected.blocking.some(text => text.includes('磁盘空间不足')));
    const persisted = (await getJson(ctx.service.url + '/reservations/R1')).body;
    assert.equal(persisted.target.release, 2);
  } finally {
    await cleanup(ctx);
  }
});

test('服务重启后凭据续领：安装不重复提交，缺口与课堂记录保留', async () => {
  const ctx = await setup();
  try {
    await postJson(ctx.service.url + '/sync');
    await postJson(ctx.service.url + '/receive');
    await postJson(ctx.source.url + '/scenario/revoked');
    await postJson(ctx.service.url + '/sync');
    await ctx.service.close();

    const reopened = await createService({
      sourceUrl: ctx.source.url,
      port: 0,
      cacheDir: join(ctx.dir, 'cache'),
      statePath: join(ctx.dir, 'state.json'),
      inventoryPath: INVENTORY,
    });
    ctx.service = reopened;
    const plan = (await postJson(reopened.url + '/sync')).body;
    assert.equal(byId(plan, 'R3').state, 'active');
    assert.equal(byId(plan, 'R1').state, 'gap');

    const status = (await getJson(reopened.url + '/status')).body;
    assert.equal(status.quota.spent, 1);
    assert.equal(status.records, 2);
    assert.equal(status.installs, 1);

    const installPosts = ctx.source.calls.filter(call => call.method === 'POST' && call.path === '/devices/TAB-2/install');
    assert.equal(installPosts.length, 1);
  } finally {
    await cleanup(ctx);
  }
});

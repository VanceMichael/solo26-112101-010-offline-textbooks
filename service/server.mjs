import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createClient } from './client.mjs';
import { applyPatch, assembleSlices, sha256Hex } from './delta.mjs';
import { buildPlan } from './planner.mjs';
import { openStore } from './store.mjs';

export async function createService({ sourceUrl, port = 0, statePath = null, cacheDir, inventoryPath = null }) {
  const client = createClient(sourceUrl);
  const store = await openStore({ statePath, cacheDir, inventoryPath });
  let snapshot = null;
  let lastPlan = null;

  async function fetchSnapshot() {
    const [releases, media, withdrawals, window, reservations] = await Promise.all([
      client.getJson('/publisher/releases'),
      client.getJson('/publisher/media'),
      client.getJson('/publisher/withdrawals'),
      client.getJson('/school/window'),
      client.getJson('/school/reservations'),
    ]);
    const named = { releases, media, withdrawals, window, reservations };
    for (const [name, result] of Object.entries(named)) {
      if (result.status !== 200) throw new Error(`来源 ${name} 返回 ${result.status}`);
    }
    const acks = new Map();
    const devices = [...new Set(reservations.body.map(item => item.device))];
    for (const device of devices) {
      const result = await client.getJson(`/devices/${encodeURIComponent(device)}/ack`);
      acks.set(device, result.status === 200 ? result.body : null);
    }
    return {
      releases: releases.body,
      media: media.body,
      withdrawals: withdrawals.body,
      window: window.body,
      reservations: reservations.body,
      acks,
    };
  }

  function computePlan() {
    return buildPlan({
      now: snapshot.window.now,
      window: snapshot.window,
      releases: snapshot.releases,
      media: snapshot.media,
      withdrawals: snapshot.withdrawals,
      reservations: snapshot.reservations,
      cacheShas: store.cache.shas(),
      cacheUsedBytes: store.cache.usedBytes(),
      acks: snapshot.acks,
      installs: store.state.installs,
      overrides: store.state.overrides,
      gaps: store.state.gaps,
      spent: store.state.spent.amount,
    });
  }

  // 目标版各练习入口应落到的内容指纹，按出版社目录与资源目录推定。
  function expectedRefsFor(target, refs) {
    const release = snapshot.releases.find(item => item.book === target.book && item.release === target.release);
    if (!release) return null;
    const mediaByAsset = new Map(snapshot.media.map(item => [item.asset, item]));
    const expected = {};
    for (const ref of refs) {
      const refInfo = release.refs.find(item => item.ref === ref);
      const item = refInfo && mediaByAsset.get(refInfo.asset);
      if (!refInfo || !item) return null;
      expected[ref] = { asset: refInfo.asset, grant: refInfo.grant, sha256: item.sha256 };
    }
    return expected;
  }

  // 只有完整激活后的回执才代表可离线使用；回执落成课堂记录，供日后对照。
  function confirmActivations(plan) {
    for (const view of plan.reservations) {
      const ack = snapshot.acks.get(view.device);
      if (!ack || ack.state !== 'active') continue;
      if (ack.book !== view.target.book || ack.release !== view.target.release) continue;
      const reservation = snapshot.reservations.find(item => item.reservation === view.reservation);
      const expected = expectedRefsFor(view.target, reservation.refs);
      if (!expected) continue;
      if (!reservation.refs.every(ref => ack.refs?.[ref] === expected[ref].sha256)) continue;
      const id = `${view.reservation}#${ack.plan ?? 'unknown'}`;
      if (store.state.records.some(record => record.id === id)) continue;
      store.state.records.push({
        id,
        class: view.class,
        reservation: view.reservation,
        device: view.device,
        book: ack.book,
        release: ack.release,
        plan: ack.plan ?? null,
        refs: expected,
        confirmedAt: snapshot.window.now,
        preExisting: !store.state.installs.some(item => item.device === view.device && item.plan === ack.plan),
      });
    }
  }

  async function refreshAcks() {
    for (const device of new Set(snapshot.reservations.map(item => item.device))) {
      const result = await client.getJson(`/devices/${encodeURIComponent(device)}/ack`);
      snapshot.acks.set(device, result.status === 200 ? result.body : null);
    }
  }

  async function sync() {
    snapshot = await fetchSnapshot();
    const windowKey = `until:${snapshot.window.endsAt}`;
    if (store.state.spent.windowKey !== windowKey) {
      store.state.spent = { windowKey, amount: 0 };
    }
    store.state.withdrawalsRevision = snapshot.withdrawals.revision ?? null;
    store.state.lastSyncAt = snapshot.window.now;
    let plan = computePlan();
    const fresh = plan.newGaps.filter(gap =>
      !store.state.gaps.some(item => item.reservation === gap.reservation && item.ref === gap.ref));
    if (fresh.length > 0) {
      store.state.gaps.push(...fresh.map(gap => ({ ...gap, seenAt: snapshot.window.now })));
      plan = computePlan();
    }
    confirmActivations(plan);
    lastPlan = plan;
    await store.save();
    return lastPlan;
  }

  async function downloadAsset(item) {
    if (!item.base) {
      const result = await client.getBytes(item.download);
      if (result.status !== 200) {
        const message = result.status === 425 ? '资源仍在传播，未到可领时点' : `来源返回 ${result.status}`;
        throw new Error(message);
      }
      if (sha256Hex(result.bytes) !== item.sha256) throw new Error('整件内容指纹与目录公示不符');
      if (result.bytes.length !== item.bytes) throw new Error('整件字节数与目录公示不符');
      await store.cache.put(item.sha256, result.bytes);
      return;
    }
    const parts = [];
    for (const slice of item.slices ?? []) {
      const result = await client.getBytes(slice.url);
      if (result.status !== 200) throw new Error(`更新块分片 ${slice.url} 返回 ${result.status}`);
      parts.push({ range: slice.range, bytes: result.bytes });
    }
    const patch = assembleSlices(parts);
    if (sha256Hex(patch) !== item.patchSha) throw new Error('更新块指纹与目录公示不符');
    const base = await store.cache.read(item.base);
    if (!base) throw new Error('基件不在校端缓存');
    const output = applyPatch(base, patch, item.base);
    if (sha256Hex(output) !== item.sha256) throw new Error('更新结果指纹与目录公示不符');
    if (output.length !== item.bytes) throw new Error('更新结果字节数与目录公示不符');
    await store.cache.put(item.sha256, output);
  }

  async function receive() {
    if (!snapshot || !lastPlan) throw Object.assign(new Error('请先同步再领取'), { statusCode: 409 });
    const report = { downloads: [], installs: [], failures: [] };
    const mediaByAsset = new Map(snapshot.media.map(item => [item.asset, item]));
    for (const view of lastPlan.reservations) {
      for (const download of view.downloads) {
        const item = mediaByAsset.get(download.asset);
        try {
          if (!item) throw new Error(`资源目录未收录 ${download.asset}`);
          await downloadAsset(item);
          store.state.spent.amount += download.cost;
          report.downloads.push({
            reservation: view.reservation,
            ref: download.ref,
            asset: download.asset,
            sha256: download.sha256,
            cost: download.cost,
            state: 'stored',
          });
        } catch (error) {
          report.failures.push({ reservation: view.reservation, ref: download.ref, asset: download.asset, message: error.message });
          break;
        }
      }
    }

    // 下载齐备后重估，向设备提交安装描述；提交受理不等于完整激活。
    let plan = computePlan();
    for (const view of plan.reservations) {
      if (view.state !== 'ready') continue;
      const reservation = snapshot.reservations.find(item => item.reservation === view.reservation);
      const expected = expectedRefsFor(view.target, reservation.refs);
      if (!expected) continue;
      const refs = Object.fromEntries(Object.entries(expected).map(([ref, info]) => [ref, info.sha256]));
      const result = await client.postJson(`/devices/${encodeURIComponent(view.device)}/install`, {
        book: view.target.book,
        release: view.target.release,
        refs,
        reservation: view.reservation,
      });
      if (result.status >= 200 && result.status < 300) {
        const install = {
          device: view.device,
          book: view.target.book,
          release: view.target.release,
          refs,
          reservation: view.reservation,
          plan: result.body?.plan ?? null,
          state: result.body?.state ?? 'submitted',
          submittedAt: snapshot.window.now,
        };
        store.state.installs.push(install);
        report.installs.push(install);
      } else {
        report.failures.push({ reservation: view.reservation, message: `设备 ${view.device} 受理安装返回 ${result.status}` });
      }
    }

    await refreshAcks();
    plan = computePlan();
    confirmActivations(plan);
    lastPlan = computePlan();
    await store.save();
    report.plan = lastPlan;
    return report;
  }

  function reservationView(id) {
    return lastPlan?.reservations.find(view => view.reservation === id) ?? null;
  }

  function recordsView() {
    const now = snapshot.window.now;
    const withdrawn = new Map();
    for (const item of snapshot.withdrawals?.items ?? []) {
      if (item.effectiveAt <= now) withdrawn.set(`${item.book}#${item.release}#${item.ref}`, item);
    }
    return store.state.records.map(record => ({
      ...record,
      entries: Object.entries(record.refs).map(([ref, info]) => {
        const hit = withdrawn.get(`${record.book}#${record.release}#${ref}`);
        const inCache = store.cache.has(info.sha256);
        return {
          ref,
          ...info,
          reloadableToday: !hit && inCache,
          reason: hit ? `授权 ${info.grant} 已于 ${hit.effectiveAt} 撤回` : (inCache ? null : '字节已不在校端缓存'),
        };
      }),
    }));
  }

  function cacheView() {
    const now = snapshot.window.now;
    const withdrawn = new Set();
    for (const item of snapshot.withdrawals?.items ?? []) {
      if (item.effectiveAt <= now) withdrawn.add(`${item.book}#${item.release}#${item.ref}`);
    }
    const mediaByAsset = new Map(snapshot.media.map(item => [item.asset, item]));
    const bySha = new Map();
    for (const release of snapshot.releases) {
      for (const refInfo of release.refs) {
        const item = mediaByAsset.get(refInfo.asset);
        if (!item) continue;
        const list = bySha.get(item.sha256) ?? [];
        list.push({
          book: release.book,
          release: release.release,
          ref: refInfo.ref,
          grant: refInfo.grant,
          valid: !withdrawn.has(`${release.book}#${release.release}#${refInfo.ref}`),
        });
        bySha.set(item.sha256, list);
      }
    }
    return store.cache.items().map(item => ({ ...item, referencedBy: bySha.get(item.sha256) ?? [] }));
  }

  function statusView() {
    const spent = store.state.spent;
    const states = {};
    for (const view of lastPlan?.reservations ?? []) states[view.state] = (states[view.state] ?? 0) + 1;
    return {
      sourceUrl,
      lastSyncAt: store.state.lastSyncAt,
      withdrawalsRevision: store.state.withdrawalsRevision,
      window: snapshot ? {
        now: snapshot.window.now,
        endsAt: snapshot.window.endsAt,
        billedReadLimit: snapshot.window.billedReadLimit,
        diskBytes: snapshot.window.diskBytes,
      } : null,
      quota: snapshot ? {
        limit: snapshot.window.billedReadLimit,
        spent: spent.amount,
        remaining: snapshot.window.billedReadLimit - spent.amount,
      } : null,
      disk: {
        capacity: snapshot?.window.diskBytes ?? null,
        used: store.cache.usedBytes(),
        free: snapshot ? snapshot.window.diskBytes - store.cache.usedBytes() : null,
      },
      cacheItems: store.cache.items().length,
      installs: store.state.installs.length,
      records: store.state.records.length,
      gaps: store.state.gaps,
      reservations: lastPlan ? states : null,
    };
  }

  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  }

  const server = createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      const route = `${request.method} ${url.pathname}`;

      if (route === 'GET /') {
        return send(200, {
          service: '校端接收服务',
          endpoints: ['POST /sync', 'POST /receive', 'POST /run', 'GET /plan', 'GET /status',
            'GET /reservations', 'GET /reservations/:id', 'POST /reservations/:id/reselect',
            'GET /classroom-records', 'GET /cache', 'GET /devices/:device'],
        });
      }
      if (route === 'POST /sync') return send(200, await sync());
      if (route === 'POST /receive') return send(200, await receive());
      if (route === 'POST /run') {
        await sync();
        return send(200, { report: await receive(), plan: lastPlan });
      }
      if (route === 'GET /plan') {
        return lastPlan ? send(200, lastPlan) : send(409, { message: '尚未同步' });
      }
      if (route === 'GET /status') return send(200, statusView());
      if (route === 'GET /reservations') {
        return lastPlan ? send(200, lastPlan.reservations) : send(409, { message: '尚未同步' });
      }
      if (route === 'GET /classroom-records') {
        if (!snapshot) return send(409, { message: '尚未同步' });
        const records = recordsView();
        const filter = url.searchParams.get('class');
        return send(200, filter ? records.filter(record => record.class === filter) : records);
      }
      if (route === 'GET /cache') {
        return snapshot ? send(200, cacheView()) : send(409, { message: '尚未同步' });
      }
      const reservationMatch = url.pathname.match(/^\/reservations\/([^/]+)(\/reselect)?$/);
      if (reservationMatch) {
        const id = decodeURIComponent(reservationMatch[1]);
        if (request.method === 'GET' && !reservationMatch[2]) {
          const view = reservationView(id);
          return view ? send(200, view) : send(404, { message: `没有预约 ${id}` });
        }
        if (request.method === 'POST' && reservationMatch[2]) {
          if (!snapshot) return send(409, { message: '尚未同步' });
          const reservation = snapshot.reservations.find(item => item.reservation === id);
          if (!reservation) return send(404, { message: `没有预约 ${id}` });
          const payload = JSON.parse(await readBody(request) || '{}');
          const release = snapshot.releases.find(item => item.book === reservation.book && item.release === payload.release);
          if (!release) return send(422, { message: `出版社目录未提供 ${reservation.book} 第 ${payload.release} 版` });
          store.state.overrides[id] = { book: reservation.book, release: payload.release };
          store.state.gaps = store.state.gaps.filter(gap => gap.reservation !== id);
          lastPlan = computePlan();
          await store.save();
          return send(200, reservationView(id));
        }
      }

      const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)$/);
      if (deviceMatch && request.method === 'GET') {
        if (!snapshot) return send(409, { message: '尚未同步' });
        const device = decodeURIComponent(deviceMatch[1]);
        return send(200, {
          device,
          ack: snapshot.acks.get(device) ?? null,
          installs: store.state.installs.filter(item => item.device === device),
          reservations: lastPlan?.reservations.filter(view => view.device === device) ?? [],
          records: store.state.records.filter(record => record.device === device),
        });
      }

      return send(404, { message: '未发布此路由' });
    } catch (error) {
      return send(error.statusCode ?? 500, { message: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    store,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createService({
    sourceUrl: process.env.SOURCE_URL ?? 'http://127.0.0.1:4180',
    port: Number(process.env.PORT ?? 4181),
    statePath: process.env.STATE_PATH ?? new URL('../data/service-state.json', import.meta.url),
    cacheDir: process.env.CACHE_DIR ?? new URL('../data/service-cache', import.meta.url),
    inventoryPath: process.env.CACHE_INVENTORY ?? new URL('../data/cache-inventory.json', import.meta.url),
  });
  console.log(`校端接收服务已启动：${service.url}（来源 ${process.env.SOURCE_URL ?? 'http://127.0.0.1:4180'}）`);
}

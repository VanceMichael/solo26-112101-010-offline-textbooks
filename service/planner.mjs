// 领取规划：在现有磁盘、一次接收额度和课堂优先顺序下，证明哪些版本可完备领取、
// 哪些只能部分准备。规划只读快照，不改动任何状态；字节级缓存可跨教材共享，
// 但每条练习入口的授权（grant）与逻辑键跳转关系按各自教材的发布声明独立判定。

const releaseKey = (book, release) => `${book}#${release}`;

export function buildPlan({
  now,
  window,
  releases,
  media,
  withdrawals,
  reservations,
  cacheShas,
  cacheUsedBytes,
  acks,
  installs,
  overrides = {},
  gaps = [],
  spent = 0,
}) {
  const mediaByAsset = new Map(media.map(item => [item.asset, item]));
  const releaseByKey = new Map(releases.map(item => [releaseKey(item.book, item.release), item]));
  const withdrawn = new Map();
  for (const item of withdrawals?.items ?? []) {
    if (item.effectiveAt <= now) {
      withdrawn.set(`${item.book}#${item.release}#${item.ref}`, item);
    }
  }
  const knownGaps = new Map(gaps.map(gap => [`${gap.reservation}#${gap.ref}`, gap]));

  const quota = { limit: window.billedReadLimit, spent, planned: 0, remaining: window.billedReadLimit - spent };
  const disk = { capacity: window.diskBytes, used: cacheUsedBytes, planned: 0, free: window.diskBytes - cacheUsedBytes };
  let remainingQuota = quota.remaining;
  let freeDisk = disk.free;

  const ordered = [...reservations].sort((a, b) =>
    a.priority - b.priority
    || a.startsAt - b.startsAt
    || String(a.reservation).localeCompare(String(b.reservation)));

  const newGaps = [];
  const views = [];

  for (const reservation of ordered) {
    const target = overrides[reservation.reservation]
      ?? { book: reservation.book, release: reservation.release };
    const release = releaseByKey.get(releaseKey(target.book, target.release));
    const entries = [];
    const blocking = [];
    const downloads = [];
    let versionBlocked = false;

    if (!release) {
      versionBlocked = true;
      blocking.push(`出版社目录未提供 ${target.book} 第 ${target.release} 版`);
    } else {
      const uncovered = reservation.scope.filter(item => !release.scope.includes(item));
      if (uncovered.length > 0) {
        versionBlocked = true;
        blocking.push(`预约范围 ${reservation.scope.join('/')} 不在该版适用范围 ${release.scope.join('/')}`);
      }
      if (!release.complete) {
        versionBlocked = true;
        blocking.push(`第 ${target.release} 版目录尚未封版，不能完备领取`);
      }
    }
    if (reservation.startsAt > window.endsAt) {
      blocking.push(`课堂开始于 ${reservation.startsAt}，晚于本接收窗口关闭 ${window.endsAt}，需后续窗口继续`);
    }

    const refMap = new Map((release?.refs ?? []).map(item => [item.ref, item]));
    for (const ref of reservation.refs) {
      const entry = { ref };
      entries.push(entry);
      const known = knownGaps.get(`${reservation.reservation}#${ref}`);
      if (known) {
        // 已标出的缺口不因后续同步静默恢复，须教师重新选版。
        entry.status = 'revoked';
        entry.grant = known.grant;
        entry.reason = `授权 ${known.grant} 已于 ${known.effectiveAt} 撤回，待教师重新选版`;
        continue;
      }
      const refInfo = refMap.get(ref);
      if (!refInfo) {
        entry.status = 'blocked';
        entry.reason = `第 ${target.release} 版未提供练习入口 ${ref}`;
        continue;
      }
      entry.asset = refInfo.asset;
      entry.grant = refInfo.grant;
      const hit = withdrawn.get(`${target.book}#${target.release}#${ref}`);
      if (hit) {
        entry.status = 'revoked';
        entry.reason = `授权 ${refInfo.grant} 已于 ${hit.effectiveAt} 撤回`;
        newGaps.push({ reservation: reservation.reservation, ref, grant: refInfo.grant, effectiveAt: hit.effectiveAt });
        continue;
      }
      const item = mediaByAsset.get(refInfo.asset);
      if (!item) {
        entry.status = 'blocked';
        entry.reason = `资源目录未收录 ${refInfo.asset}`;
        continue;
      }
      entry.sha256 = item.sha256;
      entry.bytes = item.bytes;
      if (cacheShas.has(item.sha256)) {
        entry.status = 'cached';
        continue;
      }
      if (item.base) {
        if (!cacheShas.has(item.base)) {
          entry.status = 'blocked';
          entry.reason = `缺少基件 ${item.base}`;
          continue;
        }
        const slices = item.slices ?? [];
        const expired = slices.find(slice => slice.until < now);
        if (expired) {
          entry.status = 'blocked';
          entry.reason = `更新块分片 ${expired.url} 已于 ${expired.until} 截止`;
          continue;
        }
        entry.delivery = 'delta';
        entry.cost = slices.reduce((total, slice) => total + slice.cost, 0);
        entry.status = 'fetchable';
        continue;
      }
      if (item.until != null && now > item.until) {
        entry.status = 'blocked';
        entry.reason = `整件领取已于 ${item.until} 截止`;
        continue;
      }
      entry.delivery = 'full';
      entry.cost = item.cost ?? 1;
      entry.status = 'fetchable';
    }

    const revokedEntries = entries.filter(entry => entry.status === 'revoked');
    const blockedEntries = entries.filter(entry => entry.status === 'blocked');
    const needed = entries.filter(entry => entry.status === 'fetchable');
    const needCost = needed.reduce((total, entry) => total + entry.cost, 0);
    const needBytes = needed.reduce((total, entry) => total + entry.bytes, 0);

    const ack = acks.get(reservation.device) ?? null;
    const everyRefOnDevice = ack != null
      && ack.state === 'active'
      && ack.book === target.book
      && ack.release === target.release
      && reservation.refs.every(ref => {
        const entry = entries.find(item => item.ref === ref);
        return entry?.sha256 != null && ack.refs?.[ref] === entry.sha256;
      });
    const install = installs.find(item =>
      item.device === reservation.device
      && item.book === target.book
      && item.release === target.release) ?? null;

    let state;
    if (revokedEntries.length > 0) {
      state = 'gap';
      for (const entry of revokedEntries) blocking.push(`练习入口 ${entry.ref}：${entry.reason}`);
    } else if (versionBlocked) {
      state = 'blocked';
    } else if (blockedEntries.length > 0) {
      state = entries.some(entry => entry.status === 'cached') ? 'partial' : 'blocked';
      for (const entry of blockedEntries) blocking.push(`练习入口 ${entry.ref}：${entry.reason}`);
    } else if (needed.length === 0) {
      if (everyRefOnDevice) state = 'active';
      else if (install) state = 'awaiting-activation';
      else state = 'ready';
    } else if (needCost <= remainingQuota && needBytes <= freeDisk) {
      // 同一预约的下载按整套分配：要么完备领取，要么保持原状，不贸然替换课堂版。
      state = 'planned';
      for (const entry of needed) {
        entry.status = 'planned';
        downloads.push({
          ref: entry.ref,
          asset: entry.asset,
          sha256: entry.sha256,
          bytes: entry.bytes,
          cost: entry.cost,
          delivery: entry.delivery,
        });
      }
      remainingQuota -= needCost;
      freeDisk -= needBytes;
      quota.planned += needCost;
      disk.planned += needBytes;
    } else {
      state = entries.some(entry => entry.status === 'cached') ? 'partial' : 'blocked';
    }
    if (needed.length > 0 && state !== 'planned') {
      if (needCost > remainingQuota) {
        blocking.push(`接收额度不足：完备领取还需 ${needCost}，本窗口剩余 ${remainingQuota}`);
      }
      if (needBytes > freeDisk) {
        blocking.push(`磁盘空间不足：还需 ${needBytes} 字节，剩余 ${freeDisk} 字节`);
      }
    }

    const usable = ack && ack.state === 'active' && ack.book === target.book
      ? {
        book: ack.book,
        release: ack.release,
        plan: ack.plan ?? null,
        coversReservedRefs: ack.release === target.release && everyRefOnDevice,
      }
      : null;

    views.push({
      reservation: reservation.reservation,
      class: reservation.class,
      device: reservation.device,
      priority: reservation.priority,
      startsAt: reservation.startsAt,
      scope: reservation.scope,
      target,
      state,
      offlineReady: state === 'active',
      usable,
      entries,
      downloads,
      blocking,
      affectedEntries: entries
        .filter(entry => entry.status === 'revoked' || entry.status === 'blocked')
        .map(entry => entry.ref),
    });
  }

  quota.remaining = remainingQuota;
  disk.free = freeDisk;

  return {
    now,
    window: {
      endsAt: window.endsAt,
      billedReadLimit: window.billedReadLimit,
      diskBytes: window.diskBytes,
    },
    quota,
    disk,
    reservations: views,
    newGaps,
  };
}

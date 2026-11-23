import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './delta.mjs';

const asPath = value => (value instanceof URL ? fileURLToPath(value) : value);

const emptyState = () => ({
  spent: { windowKey: null, amount: 0 },
  installs: [],
  records: [],
  gaps: [],
  overrides: {},
  withdrawalsRevision: null,
  lastSyncAt: null,
});

// 校端库存按内容指纹寻址：同名文件不会覆盖在用的课堂版，
// 只有完整核验指纹后的字节才进入缓存。
export async function openStore({ statePath = null, cacheDir, inventoryPath = null }) {
  statePath = statePath ? asPath(statePath) : null;
  cacheDir = asPath(cacheDir);
  inventoryPath = inventoryPath ? asPath(inventoryPath) : null;

  await mkdir(cacheDir, { recursive: true });
  const cache = new Map();

  async function putBytes(sha, bytes) {
    const temporary = join(cacheDir, `.${sha}.${process.pid}.tmp`);
    await writeFile(temporary, bytes);
    await rename(temporary, join(cacheDir, `${sha}.bin`));
    cache.set(sha, { size: bytes.length });
  }

  for (const file of await readdir(cacheDir)) {
    if (!file.endsWith('.bin')) continue;
    const info = await stat(join(cacheDir, file));
    cache.set(file.slice(0, -'.bin'.length), { size: info.size });
  }

  // 窗口开始前校端已有的原件，与设备各自确认的本地安装是独立库存。
  if (inventoryPath) {
    let inventory = null;
    try {
      inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const item of inventory ?? []) {
      if (cache.has(item.sha256)) continue;
      const bytes = Buffer.from(item.base64, 'base64');
      if (sha256Hex(bytes) !== item.sha256) {
        throw new Error(`校端库存 ${item.asset} 的内容指纹与登记不符`);
      }
      await putBytes(item.sha256, bytes);
    }
  }

  let state = emptyState();
  if (statePath) {
    try {
      state = { ...emptyState(), ...JSON.parse(await readFile(statePath, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function save() {
    if (!statePath) return;
    const temporary = `${statePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, statePath);
  }

  return {
    state,
    save,
    cache: {
      has: sha => cache.has(sha),
      shas: () => new Set(cache.keys()),
      usedBytes: () => [...cache.values()].reduce((total, item) => total + item.size, 0),
      items: () => [...cache.entries()].map(([sha256, item]) => ({ sha256, bytes: item.size })),
      read: async sha => {
        try {
          return await readFile(join(cacheDir, `${sha}.bin`));
        } catch {
          return null;
        }
      },
      put: async (sha, bytes) => {
        if (sha256Hex(bytes) !== sha) throw new Error('写入缓存前内容指纹校验失败');
        if (!cache.has(sha)) await putBytes(sha, bytes);
      },
    },
  };
}

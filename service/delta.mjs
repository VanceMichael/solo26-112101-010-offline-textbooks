import { createHash } from 'node:crypto';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// 各镜像按各自传输切分提供同一更新块的半开字节区间，装配前不假设切分方式一致。
export function assembleSlices(parts) {
  const ordered = [...parts].sort((a, b) => a.range[0] - b.range[0]);
  let cursor = 0;
  const chunks = [];
  for (const part of ordered) {
    const [start, end] = part.range;
    if (start !== cursor) {
      throw new Error(`更新块区间不连续：期望从 ${cursor} 开始，实到分片从 ${start} 开始`);
    }
    if (part.bytes.length !== end - start) {
      throw new Error(`更新块区间 [${start}, ${end}) 应收 ${end - start} 字节，实收 ${part.bytes.length} 字节`);
    }
    chunks.push(part.bytes);
    cursor = end;
  }
  return Buffer.concat(chunks);
}

// 单次字节替换：在基件 offset 处删去 remove 个字节后写入解码所得 bytes。
export function applyPatch(baseBytes, patchBytes, expectedBase) {
  let doc;
  try {
    doc = JSON.parse(patchBytes.toString('utf8'));
  } catch {
    throw new Error('更新块不是可解析的替换描述');
  }
  if (typeof doc?.offset !== 'number' || typeof doc?.remove !== 'number' || typeof doc?.bytes !== 'string') {
    throw new Error('更新块描述缺少 offset/remove/bytes');
  }
  if (expectedBase && doc.base !== expectedBase) {
    throw new Error('更新块声明的基件与资源目录公示不符');
  }
  const { offset, remove } = doc;
  if (!Number.isInteger(offset) || !Number.isInteger(remove) || offset < 0 || remove < 0 || offset + remove > baseBytes.length) {
    throw new Error('更新块替换范围超出基件');
  }
  const insert = Buffer.from(doc.bytes, 'base64');
  return Buffer.concat([baseBytes.subarray(0, offset), insert, baseBytes.subarray(offset + remove)]);
}

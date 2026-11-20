import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const configuration = JSON.parse(await readFile(new URL('../data/sources.json', import.meta.url)));
const bodyFor = response => {
  if (response.base64) return Buffer.from(response.base64, 'base64');
  return response.text ?? JSON.stringify(response.data);
};

export async function startSources(port = 0) {
  let stage = 'initial';
  const calls = [];
  const accepted = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname.startsWith('/scenario/')) {
      const next = url.pathname.slice('/scenario/'.length);
      if (!Object.hasOwn(configuration.stages, next)) {
        response.writeHead(404).end();
        return;
      }
      stage = next;
      response.writeHead(204).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestBody = Buffer.concat(chunks).toString();
    const path = url.pathname + url.search;
    const routes = configuration.stages[stage];
    const key = request.method + ' ' + path;
    const match = routes[key] ?? configuration.stages.initial[key];
    calls.push({ stage, method: request.method, path, body: requestBody });
    if (!match) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: '来源没有发布此资源' }));
      return;
    }
    if (match.form) {
      const fields = new URLSearchParams(requestBody);
      if (Object.entries(match.form).some(([field, values]) => !values.includes(fields.get(field)))) {
        response.writeHead(422, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<p>申请表中的企业或档页不可受理。</p>');
        return;
      }
    }
    const step = match.sequence
      ? match.sequence[Math.min(accepted.get(stage + key) ?? 0, match.sequence.length - 1)]
      : match;
    if (match.sequence) accepted.set(stage + key, (accepted.get(stage + key) ?? 0) + 1);
    response.writeHead(step.status ?? 200, {
      'Content-Type': step.type ?? 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...step.headers,
    });
    response.end(bodyFor(step));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = await startSources(Number(process.env.PORT ?? 4180));
  console.log(`演练来源已启动：${source.url}`);
}

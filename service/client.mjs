export function createClient(baseUrl) {
  return {
    async getJson(path) {
      const response = await fetch(baseUrl + path);
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
    async getBytes(path) {
      const response = await fetch(baseUrl + path);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, bytes };
    },
    async postJson(path, payload) {
      const response = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
  };
}

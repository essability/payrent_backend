export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export async function readForm(req) {
  const raw = await readBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function requireApiSecret(req, config) {
  if (!config.apiSecret) return;

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  if (token !== config.apiSecret) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

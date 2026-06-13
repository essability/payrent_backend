import crypto from "node:crypto";

export function normalizeWhatsAppPhone(value) {
  return String(value || "").replace(/^whatsapp:/, "").trim();
}

export function twiml(message) {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<Response>",
    `<Message>${escapeXml(message)}</Message>`,
    "</Response>"
  ].join("");
}

export function validateTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken) return true;
  if (!signature) return false;

  const sortedKeys = Object.keys(params).sort();
  const payload = sortedKeys.reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac("sha1", authToken).update(payload).digest("base64");
  if (Buffer.byteLength(expected) !== Buffer.byteLength(signature)) return false;

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

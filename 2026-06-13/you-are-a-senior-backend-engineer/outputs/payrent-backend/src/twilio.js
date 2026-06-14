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

export async function sendTwilioWhatsAppMessage({ accountSid, authToken, from, to, body, contentSid, contentVariables }) {
  if (!accountSid || !authToken || !from) {
    throw new Error("Twilio outbound messaging is not configured.");
  }

  const params = new URLSearchParams({
    From: from,
    To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`
  });

  if (contentSid) {
    params.set("ContentSid", contentSid);
    if (contentVariables) params.set("ContentVariables", JSON.stringify(contentVariables));
  } else {
    params.set("Body", body || "");
  }

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Twilio send failed ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

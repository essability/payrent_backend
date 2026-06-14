const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN.");
}

const response = await fetch("https://content.twilio.com/v1/Content?PageSize=100", {
  headers: {
    authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
  }
});

const payload = await response.json();

if (!response.ok) {
  throw new Error(`Twilio API failed ${response.status}: ${JSON.stringify(payload)}`);
}

for (const item of payload.contents || []) {
  console.log(`${item.sid}\t${item.friendly_name}\t${item.language}`);
}

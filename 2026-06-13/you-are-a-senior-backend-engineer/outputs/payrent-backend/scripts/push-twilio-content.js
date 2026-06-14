import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const shouldSubmitApproval = args.has("--submit-approval");
const dryRun = args.has("--dry-run");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!dryRun && (!accountSid || !authToken)) {
  throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN.");
}

const templatePath = path.join(projectRoot, "twilio", "content-templates.json");
const outputPath = path.join(projectRoot, "twilio", "generated", "twilio-flow-content-sids.json");
const railwayEnvPath = path.join(projectRoot, "twilio", "generated", "railway-env.txt");
const templates = JSON.parse(await fs.readFile(templatePath, "utf8"));

const result = {};

for (const template of templates) {
  const payload = {
    friendly_name: template.friendlyName,
    language: template.language || "en",
    variables: template.variables || {},
    types: {
      "twilio/text": {
        body: template.body
      }
    }
  };

  if (dryRun) {
    console.log(`[dry-run] Would create ${template.flowName}: ${template.friendlyName}`);
    result[template.flowName] = "HX_DRY_RUN";
    continue;
  }

  console.log(`Creating Twilio Content template: ${template.flowName}`);
  const created = await twilioRequest("https://content.twilio.com/v1/Content", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  result[template.flowName] = created.sid;
  console.log(`Created ${template.flowName}: ${created.sid}`);

  if (shouldSubmitApproval) {
    console.log(`Submitting ${template.flowName} for WhatsApp approval`);
    await twilioRequest(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
      method: "POST",
      body: JSON.stringify({
        name: template.approvalName,
        category: template.approvalCategory || "UTILITY"
      })
    });
  }
}

await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
await fs.writeFile(railwayEnvPath, `TWILIO_FLOW_CONTENT_SIDS=${JSON.stringify(result)}\n`);

console.log("");
console.log(`Saved SID map: ${outputPath}`);
console.log(`Saved Railway env value: ${railwayEnvPath}`);
console.log("");
console.log("Copy this into Railway Variables:");
console.log(`TWILIO_FLOW_CONTENT_SIDS=${JSON.stringify(result)}`);

async function twilioRequest(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "content-type": "application/json"
    }
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Twilio API failed ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

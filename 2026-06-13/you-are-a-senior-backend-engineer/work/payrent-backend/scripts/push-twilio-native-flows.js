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
const flowIds = parseJsonEnv(process.env.TWILIO_WHATSAPP_FLOW_IDS, {});

if (!dryRun && (!accountSid || !authToken)) {
  throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN.");
}

const templatePath = path.join(projectRoot, "twilio", "native-flow-content-templates.json");
const outputPath = path.join(projectRoot, "twilio", "generated", "twilio-native-flow-content-sids.json");
const railwayEnvPath = path.join(projectRoot, "twilio", "generated", "railway-native-flows-env.txt");
const templates = JSON.parse(await fs.readFile(templatePath, "utf8"));

const result = {};

for (const template of templates) {
  const flowId = template.flowId || flowIds[template.flowIdEnvKey || template.flowName];
  if (!flowId && !dryRun) {
    throw new Error(`Missing WhatsApp Flow ID for ${template.flowName}. Set TWILIO_WHATSAPP_FLOW_IDS with this key.`);
  }

  const payload = buildNativeFlowContentPayload(template, flowId || "FLOW_ID_DRY_RUN");

  if (dryRun) {
    console.log(`[dry-run] Would create native WhatsApp Flow Content: ${template.flowName}`);
    console.log(JSON.stringify(payload, null, 2));
    result[template.flowName] = "HX_DRY_RUN";
    continue;
  }

  console.log(`Creating Twilio native Flow Content template: ${template.flowName}`);
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
console.log(`Saved native Flow SID map: ${outputPath}`);
console.log(`Saved Railway env value: ${railwayEnvPath}`);
console.log("");
console.log("Copy this into Railway Variables:");
console.log(`TWILIO_FLOW_CONTENT_SIDS=${JSON.stringify(result)}`);

function buildNativeFlowContentPayload(template, flowId) {
  return {
    friendly_name: template.friendlyName,
    language: template.language || "en",
    variables: template.variables || {},
    types: {
      "twilio/flows": {
        body: template.body,
        button_text: template.buttonText,
        flow_id: flowId,
        flow_token: template.flowToken || "unused",
        flow_action: "navigate",
        navigate_screen: template.navigateScreen
      }
    }
  };
}

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

function parseJsonEnv(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import { extractTwilioFlowPayload, FlowProcessor } from "./flowProcessor.js";
import { readForm, readJson, requireApiSecret, sendJson, sendText } from "./http.js";
import { OnboardingEngine } from "./onboarding.js";
import { PayRentService } from "./payrentService.js";
import { SupabaseRest } from "./supabaseRest.js";
import { normalizeWhatsAppPhone, sendTwilioWhatsAppMessage, twiml, validateTwilioSignature } from "./twilio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const config = getConfig();
const db = new SupabaseRest({
  url: config.supabaseUrl,
  serviceRoleKey: config.supabaseServiceRoleKey
});
const service = new PayRentService(db);
const onboarding = new OnboardingEngine(db, service);
const flowProcessor = new FlowProcessor(service);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "payrent-backend" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/whatsapp") {
      const welcomeTwiml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>Welcome to PayRent Kenya 👋</Message></Response>";

      try {
        console.log("Step 1");
        const form = await readForm(req);
        console.log("Incoming Twilio WhatsApp webhook:", form);

        console.log("Step 2");
        const phoneNumber = normalizeWhatsAppPhone(form.From);
        const message = form.Body || "";

        console.log("Step 3");
        sendText(res, 200, welcomeTwiml, "text/xml; charset=utf-8");

        saveIncomingWhatsAppMessageInBackground({ phoneNumber, message });
        return;
      } catch (error) {
        console.error("Webhook Error:", error);
      }

      sendText(res, 200, welcomeTwiml, "text/xml; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/flows/")) {
      requireApiSecret(req, config);
      const flowName = url.pathname.split("/").at(-1);
      const filePath = path.join(projectRoot, "flows", `${flowName}.json`);
      const file = await fs.readFile(filePath, "utf8");
      sendJson(res, 200, JSON.parse(file));
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhooks/twilio/whatsapp") {
      const form = await readForm(req);
      const fullUrl = publicUrlFromRequest(req, url);
      const valid = validateTwilioSignature({
        authToken: config.twilioAuthToken,
        url: fullUrl,
        params: form,
        signature: req.headers["x-twilio-signature"]
      });

      if (!valid) {
        sendText(res, 403, "Invalid Twilio signature");
        return;
      }

      const phoneNumber = normalizeWhatsAppPhone(form.From);
      const message = form.Body || "";
      const reply = await onboarding.handleWhatsAppMessage({ phoneNumber, body: message });
      sendText(res, 200, twiml(reply), "text/xml; charset=utf-8");
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhooks/twilio/whatsapp-flow") {
      const form = await readForm(req);
      const fullUrl = publicUrlFromRequest(req, url);
      const valid = validateTwilioSignature({
        authToken: config.twilioAuthToken,
        url: fullUrl,
        params: form,
        signature: req.headers["x-twilio-signature"]
      });

      if (!valid) {
        sendText(res, 403, "Invalid Twilio signature");
        return;
      }

      const phoneNumber = normalizeWhatsAppPhone(form.From);
      const extracted = extractTwilioFlowPayload(form);
      const result = await flowProcessor.process({
        flowName: extracted.flowName,
        source: "twilio_whatsapp_flow",
        phoneNumber,
        payload: extracted.payload
      });

      sendJson(res, 200, {
        ok: true,
        submissionId: result.submissionId,
        flowName: result.flowName
      });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/flows/") && url.pathname.endsWith("/submissions")) {
      requireApiSecret(req, config);
      const parts = url.pathname.split("/");
      const flowName = parts[3];
      const body = await readJson(req);
      const result = await flowProcessor.process({
        flowName,
        source: body.source || "web",
        phoneNumber: body.phoneNumber,
        payload: body.payload || body
      });
      sendJson(res, 201, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/twilio/send-flow") {
      requireApiSecret(req, config);
      const body = await readJson(req);
      const contentSid = body.contentSid || config.twilioFlowContentSids[body.flowName];
      if (!contentSid) {
        sendJson(res, 400, { error: "Missing contentSid. Provide contentSid or configure TWILIO_FLOW_CONTENT_SIDS for this flowName." });
        return;
      }
      const result = await sendTwilioWhatsAppMessage({
        accountSid: config.twilioAccountSid,
        authToken: config.twilioAuthToken,
        from: config.twilioWhatsAppFrom,
        to: body.to,
        contentSid,
        contentVariables: body.contentVariables || {}
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register/tenant-independent") {
      requireApiSecret(req, config);
      const body = await readJson(req);
      const result = await service.createIndependentTenant({
        fullName: body.fullName,
        phoneNumber: body.phoneNumber,
        nationalIdNumber: body.nationalIdNumber,
        monthlyRentAmount: Number(body.monthlyRentAmount),
        rentDueDay: Number(body.rentDueDay),
        signupChannel: body.signupChannel || "web"
      });
      sendJson(res, 201, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register/invitation") {
      requireApiSecret(req, config);
      const body = await readJson(req);
      const result = await service.acceptTenantInvitation({
        code: body.code,
        fullName: body.fullName,
        phoneNumber: body.phoneNumber,
        nationalIdNumber: body.nationalIdNumber,
        signupChannel: body.signupChannel || "web"
      });
      sendJson(res, 201, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register/landlord") {
      requireApiSecret(req, config);
      const body = await readJson(req);
      const result = await service.createLandlord({
        fullName: body.fullName,
        phoneNumber: body.phoneNumber,
        email: body.email,
        nationalIdNumber: body.nationalIdNumber,
        landlordType: body.landlordType || "individual_landlord",
        companyName: body.companyName,
        signupChannel: body.signupChannel || "web"
      });
      sendJson(res, 201, result);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      error: error.message || "Internal server error"
    });
  }
});

server.listen(config.port, () => {
  console.log(`PayRent backend listening on http://localhost:${config.port}`);
});

function publicUrlFromRequest(req, url) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}${url.pathname}`;
}

function saveIncomingWhatsAppMessageInBackground({ phoneNumber, message }) {
  setImmediate(async () => {
    try {
      console.log("Background save start");
      await service.saveMessage({
        phoneNumber,
        direction: "user",
        body: message,
        channel: "whatsapp"
      });
      console.log("Background save complete");
    } catch (error) {
      console.error("Webhook Error:", error);
    }
  });
}

import http from "node:http";
import { getConfig } from "./config.js";
import { readForm, readJson, requireApiSecret, sendJson, sendText } from "./http.js";
import { OnboardingEngine } from "./onboarding.js";
import { PayRentService } from "./payrentService.js";
import { SupabaseRest } from "./supabaseRest.js";
import { normalizeWhatsAppPhone, twiml, validateTwilioSignature } from "./twilio.js";

const config = getConfig();
const db = new SupabaseRest({
  url: config.supabaseUrl,
  serviceRoleKey: config.supabaseServiceRoleKey
});
const service = new PayRentService(db);
const onboarding = new OnboardingEngine(db, service);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "payrent-backend" });
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

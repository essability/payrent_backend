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

const WELCOME_MENU = [
  "🏠 Welcome to PayRent Kenya 🇰🇪",
  "",
  "We’re so happy to have you here.",
  "",
  "PayRent helps you manage rent, save towards rent, receive reminders, and make rent payments directly from WhatsApp — simple, safe, and stress-free.",
  "",
  "Please choose how you want to continue:",
  "",
  "1️⃣ I am a Tenant",
  "2️⃣ I am a Landlord",
  "3️⃣ I am a Property Manager",
  "4️⃣ I just want to Save Towards Rent",
  "",
  "With love,",
  "Ruth ❤️",
  "CEO, PayRent Kenya",
  "",
  "Reply with 1, 2, 3, or 4."
].join("\n");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "payrent-backend" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/whatsapp") {
      try {
        console.log("Step 1");
        const form = await readForm(req);
        console.log("Incoming Twilio WhatsApp webhook:", form);

        console.log("Step 2");
        const phoneNumber = normalizeWhatsAppPhone(form.From);
        const waId = form.WaId || phoneNumber;
        const message = form.Body || "";
        const decision = decidePayRentWelcomeReply(message);

        console.log("Step 3");
        sendText(res, 200, twiml(decision.reply), "text/xml; charset=utf-8");

        handleWhatsAppWebhookInBackground({
          phoneNumber,
          waId,
          incomingMessage: message,
          outgoingMessage: decision.reply,
          decision
        });
        return;
      } catch (error) {
        console.error("Webhook Error:", error);
      }

      sendText(res, 200, twiml(WELCOME_MENU), "text/xml; charset=utf-8");
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
      try {
        const form = await readForm(req);
        console.log("Incoming Twilio WhatsApp Flow webhook:", form);
        const fullUrl = publicUrlFromRequest(req, url);
        const valid = validateTwilioSignature({
          authToken: config.twilioAuthToken,
          url: fullUrl,
          params: form,
          signature: req.headers["x-twilio-signature"]
        });

        if (!valid) {
          sendJson(res, 200, { ok: false, error: "Invalid Twilio signature" });
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
        const confirmation = flowProcessor.confirmationMessage(result.flowName, extracted.payload);

        sendWhatsAppBodyInBackground({
          to: phoneNumber,
          body: confirmation
        });

        sendJson(res, 200, {
          ok: true,
          submissionId: result.submissionId,
          flowName: result.flowName,
          message: confirmation
        });
      } catch (error) {
        console.error("WhatsApp Flow Webhook Error:", error);
        sendJson(res, 200, { ok: false, error: "Flow submission could not be processed." });
      }
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

function decidePayRentWelcomeReply(message) {
  const text = String(message || "").trim();
  const normalized = text.toLowerCase();

  if (normalized.startsWith("tenant:")) {
    return {
      reply: "Thank you ❤️ We’re creating your PayRent tenant profile now.",
      fallbackFlowName: "tenant_registration",
      fallbackPayload: parseColonCsvPayload(text, "tenant")
    };
  }

  if (normalized.startsWith("save:")) {
    return {
      reply: "Beautiful ❤️ We’re creating your rent savings goal now.",
      fallbackFlowName: "save_towards_rent",
      fallbackPayload: parseColonCsvPayload(text, "save")
    };
  }

  if (normalized === "1") {
    return {
      reply: [
        "Beautiful choice ❤️",
        "",
        "I’m opening the Tenant Registration form for you now.",
        "",
        "If the form does not open in this WhatsApp Sandbox, reply like this:",
        "TENANT: Full Name, Phone Number, Email or -, Invitation Code or NO, Monthly Rent, Rent Due Day"
      ].join("\n"),
      selectedOption: "1",
      selectedUserType: "tenant",
      flowName: "tenant_registration"
    };
  }

  if (normalized === "4") {
    return {
      reply: [
        "Beautiful choice ❤️",
        "",
        "I’m opening the Save Towards Rent form for you now.",
        "",
        "If the form does not open in this WhatsApp Sandbox, reply like this:",
        "SAVE: Full Name, Phone Number, Monthly Rent, Rent Due Day, Daily/Weekly/Monthly, Target Start Date or -"
      ].join("\n"),
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      flowName: "save_towards_rent"
    };
  }

  if (normalized === "2") {
    return {
      reply: "Landlord registration is coming next. For now, please reply 1 if you want to test Tenant registration or 4 to Save Towards Rent.",
      selectedOption: "2",
      selectedUserType: "landlord"
    };
  }

  if (normalized === "3") {
    return {
      reply: "Property Manager registration is coming next. For now, please reply 1 if you want to test Tenant registration or 4 to Save Towards Rent.",
      selectedOption: "3",
      selectedUserType: "property_manager"
    };
  }

  return {
    reply: WELCOME_MENU,
    selectedOption: null,
    selectedUserType: null
  };
}

function handleWhatsAppWebhookInBackground({ phoneNumber, waId, incomingMessage, outgoingMessage, decision }) {
  setImmediate(async () => {
    try {
      console.log("WhatsApp background processing start");
      await service.saveMessage({
        phoneNumber,
        direction: "user",
        body: incomingMessage,
        channel: "whatsapp"
      });
      await service.saveMessage({
        phoneNumber,
        direction: "assistant",
        body: outgoingMessage,
        channel: "whatsapp"
      });
      await service.createOrUpdateMenuSession({
        phoneNumber,
        waId,
        selectedOption: decision.selectedOption,
        selectedUserType: decision.selectedUserType,
        currentStep: decision.flowName ? "flow_launch_requested" : "choose_user_type"
      });

      if (decision.fallbackFlowName && decision.fallbackPayload) {
        await processFallbackSubmission({
          phoneNumber,
          flowName: decision.fallbackFlowName,
          payload: decision.fallbackPayload
        });
      }

      if (decision.flowName) {
        await launchWhatsAppFlowInBackground({
          to: phoneNumber,
          flowName: decision.flowName
        });
      }

      console.log("WhatsApp background processing complete");
    } catch (error) {
      console.error("Webhook Error:", error);
    }
  });
}

async function processFallbackSubmission({ phoneNumber, flowName, payload }) {
  try {
    const result = await flowProcessor.process({
      flowName,
      source: "whatsapp_chat_fallback",
      phoneNumber,
      payload
    });
    const confirmation = flowProcessor.confirmationMessage(result.flowName, payload);
    await service.saveMessage({
      phoneNumber,
      direction: "assistant",
      body: confirmation,
      channel: "whatsapp"
    });
    await sendWhatsAppBody({ to: phoneNumber, body: confirmation });
  } catch (error) {
    console.error("Chat Fallback Error:", error);
    const fallbackError = "Sorry, we could not complete that form by chat. Please reply 1 or 4 and try again.";
    await service.saveMessage({
      phoneNumber,
      direction: "assistant",
      body: fallbackError,
      channel: "whatsapp"
    });
    await sendWhatsAppBody({ to: phoneNumber, body: fallbackError });
  }
}

async function launchWhatsAppFlowInBackground({ to, flowName }) {
  try {
    const contentSid = config.twilioFlowContentSids[flowName] ||
      (flowName === "save_towards_rent" ? config.twilioFlowContentSids.savings_deposit : null);

    if (!contentSid) {
      console.log(`No Twilio Content SID configured for ${flowName}; chat fallback remains available.`);
      return;
    }

    await sendTwilioWhatsAppMessage({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
      from: config.twilioWhatsAppFrom,
      to,
      contentSid,
      contentVariables: {
        "1": "PayRent"
      }
    });
    await service.saveMessage({
      phoneNumber: to,
      direction: "assistant",
      body: `WhatsApp Flow launched: ${flowName}`,
      channel: "whatsapp"
    });
    console.log(`WhatsApp Flow launch requested for ${flowName}`);
  } catch (error) {
    console.error("Flow Launch Error:", error);
  }
}

function sendWhatsAppBodyInBackground({ to, body }) {
  setImmediate(async () => {
    try {
      await sendWhatsAppBody({ to, body });
      await service.saveMessage({
        phoneNumber: to,
        direction: "assistant",
        body,
        channel: "whatsapp"
      });
    } catch (error) {
      console.error("Outbound WhatsApp Error:", error);
    }
  });
}

async function sendWhatsAppBody({ to, body }) {
  await sendTwilioWhatsAppMessage({
    accountSid: config.twilioAccountSid,
    authToken: config.twilioAuthToken,
    from: config.twilioWhatsAppFrom,
    to,
    body
  });
}

function parseColonCsvPayload(text, kind) {
  const raw = text.slice(text.indexOf(":") + 1);
  const parts = raw.split(",").map((part) => part.trim());

  if (kind === "tenant") {
    return {
      flow_name: "tenant_registration",
      full_name: parts[0],
      phone_number: parts[1],
      email: parts[2] === "-" ? "" : parts[2],
      has_invitation_code: parts[3] && parts[3].toLowerCase() !== "no" ? "yes" : "no",
      invitation_code: parts[3] && parts[3].toLowerCase() !== "no" ? parts[3] : "",
      monthly_rent_amount: parts[4],
      rent_due_day: parts[5]
    };
  }

  return {
    flow_name: "save_towards_rent",
    full_name: parts[0],
    phone_number: parts[1],
    monthly_rent_amount: parts[2],
    rent_due_day: parts[3],
    savings_frequency: parts[4],
    target_start_date: parts[5] === "-" ? "" : parts[5]
  };
}

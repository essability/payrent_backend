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
        const decision = await decidePayRentWelcomeReply({
          message,
          phoneNumber,
          formBaseUrl: publicBaseUrlFromRequest(req)
        });

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

    if (req.method === "GET" && url.pathname === "/forms/tenant-registration") {
      sendText(
        res,
        200,
        renderTenantRegistrationForm({
          phoneNumber: url.searchParams.get("phone") || "",
          waId: url.searchParams.get("wa_id") || ""
        }),
        "text/html; charset=utf-8"
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/forms/save-towards-rent") {
      sendText(
        res,
        200,
        renderSaveTowardsRentForm({
          phoneNumber: url.searchParams.get("phone") || "",
          waId: url.searchParams.get("wa_id") || ""
        }),
        "text/html; charset=utf-8"
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/forms/tenant-registration") {
      await handleFormSubmission({
        req,
        res,
        flowName: "tenant_registration"
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/forms/save-towards-rent") {
      await handleFormSubmission({
        req,
        res,
        flowName: "save_towards_rent"
      });
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

function publicBaseUrlFromRequest(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

async function decidePayRentWelcomeReply({ message, phoneNumber, formBaseUrl }) {
  const text = String(message || "").trim();
  const normalized = text.toLowerCase();
  const tenantFormUrl = buildFormUrl(formBaseUrl, "/forms/tenant-registration", phoneNumber);
  const saveFormUrl = buildFormUrl(formBaseUrl, "/forms/save-towards-rent", phoneNumber);

  const activeSession = await getActiveSessionForDecision(phoneNumber);
  if (activeSession?.current_step?.startsWith("chat_tenant_")) {
    return advanceTenantChatSession(activeSession, text);
  }
  if (activeSession?.current_step?.startsWith("chat_save_")) {
    return advanceSaveChatSession(activeSession, text);
  }

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
        "Tap here to fill it inside WhatsApp:",
        tenantFormUrl,
        "",
        "If the link does not open, no stress. We can continue here.",
        "",
        "First, what is your full name?"
      ].join("\n"),
      selectedOption: "1",
      selectedUserType: "tenant",
      flowName: "tenant_registration",
      currentStep: "chat_tenant_full_name",
      sessionData: {}
    };
  }

  if (normalized === "4") {
    return {
      reply: [
        "Beautiful choice ❤️",
        "",
        "I’m opening the Save Towards Rent form for you now.",
        "",
        "Tap here to fill it inside WhatsApp:",
        saveFormUrl,
        "",
        "If the link does not open, no stress. We can continue here.",
        "",
        "First, what is your full name?"
      ].join("\n"),
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      flowName: "save_towards_rent",
      currentStep: "chat_save_full_name",
      sessionData: {}
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

function buildFormUrl(baseUrl, pathname, phoneNumber) {
  const url = new URL(pathname, baseUrl);
  if (phoneNumber) {
    url.searchParams.set("phone", phoneNumber);
    url.searchParams.set("wa_id", phoneNumber);
  }
  return url.toString();
}

async function getActiveSessionForDecision(phoneNumber) {
  try {
    return await service.getActiveOnboardingSession(phoneNumber);
  } catch (error) {
    console.error("Onboarding Session Lookup Error:", error);
    return null;
  }
}

function advanceTenantChatSession(session, text) {
  const data = session.data || {};

  if (session.current_step === "chat_tenant_full_name") {
    return {
      reply: "Thank you. What phone number should we use for your PayRent account?",
      selectedOption: "1",
      selectedUserType: "tenant",
      currentStep: "chat_tenant_phone_number",
      sessionData: { ...data, full_name: text }
    };
  }

  if (session.current_step === "chat_tenant_phone_number") {
    return {
      reply: "Got it. What is your email address? Reply - if you want to skip.",
      selectedOption: "1",
      selectedUserType: "tenant",
      currentStep: "chat_tenant_email",
      sessionData: { ...data, phone_number: text }
    };
  }

  if (session.current_step === "chat_tenant_email") {
    return {
      reply: "Do you have an invitation code? Reply YES or NO.",
      selectedOption: "1",
      selectedUserType: "tenant",
      currentStep: "chat_tenant_has_invitation",
      sessionData: { ...data, email: text === "-" ? "" : text }
    };
  }

  if (session.current_step === "chat_tenant_has_invitation") {
    const hasInvitation = ["yes", "y"].includes(text.toLowerCase());
    return {
      reply: hasInvitation ? "Please enter your invitation code." : "How much is your monthly rent? Example: 15000",
      selectedOption: "1",
      selectedUserType: "tenant",
      currentStep: hasInvitation ? "chat_tenant_invitation_code" : "chat_tenant_monthly_rent",
      sessionData: { ...data, has_invitation_code: hasInvitation ? "yes" : "no" }
    };
  }

  if (session.current_step === "chat_tenant_invitation_code") {
    return {
      reply: "How much is your monthly rent? Example: 15000",
      selectedOption: "1",
      selectedUserType: "tenant",
      currentStep: "chat_tenant_monthly_rent",
      sessionData: { ...data, invitation_code: text }
    };
  }

  if (session.current_step === "chat_tenant_monthly_rent") {
    return {
      reply: "What day of the month is rent due? Example: 5",
      selectedOption: "1",
      selectedUserType: "tenant",
      currentStep: "chat_tenant_rent_due_day",
      sessionData: { ...data, monthly_rent_amount: text }
    };
  }

  if (session.current_step === "chat_tenant_rent_due_day") {
    const payload = { ...data, rent_due_day: text, flow_name: "tenant_registration" };
    return {
      reply: "Thank you ❤️ We’re creating your PayRent tenant profile now.",
      selectedOption: "1",
      selectedUserType: "tenant",
      currentStep: "completed",
      sessionData: payload,
      fallbackFlowName: "tenant_registration",
      fallbackPayload: payload,
      completeSession: true
    };
  }

  return { reply: WELCOME_MENU };
}

function advanceSaveChatSession(session, text) {
  const data = session.data || {};

  if (session.current_step === "chat_save_full_name") {
    return {
      reply: "Thank you. What phone number should we use for your PayRent savings goal?",
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      currentStep: "chat_save_phone_number",
      sessionData: { ...data, full_name: text }
    };
  }

  if (session.current_step === "chat_save_phone_number") {
    return {
      reply: "How much is your monthly rent? Example: 15000",
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      currentStep: "chat_save_monthly_rent",
      sessionData: { ...data, phone_number: text }
    };
  }

  if (session.current_step === "chat_save_monthly_rent") {
    return {
      reply: "What day of the month is rent due? Example: 5",
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      currentStep: "chat_save_rent_due_day",
      sessionData: { ...data, monthly_rent_amount: text }
    };
  }

  if (session.current_step === "chat_save_rent_due_day") {
    return {
      reply: "How often do you want to save? Reply Daily, Weekly, or Monthly.",
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      currentStep: "chat_save_frequency",
      sessionData: { ...data, rent_due_day: text }
    };
  }

  if (session.current_step === "chat_save_frequency") {
    return {
      reply: "When do you want to start? Reply with YYYY-MM-DD, or - to skip.",
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      currentStep: "chat_save_target_start_date",
      sessionData: { ...data, savings_frequency: text.toLowerCase() }
    };
  }

  if (session.current_step === "chat_save_target_start_date") {
    const payload = {
      ...data,
      target_start_date: text === "-" ? "" : text,
      flow_name: "save_towards_rent"
    };
    return {
      reply: "Beautiful ❤️ We’re creating your rent savings goal now.",
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      currentStep: "completed",
      sessionData: payload,
      fallbackFlowName: "save_towards_rent",
      fallbackPayload: payload,
      completeSession: true
    };
  }

  return { reply: WELCOME_MENU };
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
        currentStep: decision.currentStep || (decision.flowName ? "flow_launch_requested" : "choose_user_type")
      });
      const activeSession = await service.getActiveOnboardingSession(phoneNumber);
      if (activeSession && decision.sessionData) {
        await service.updateOnboardingSession({
          id: activeSession.id,
          currentStep: decision.currentStep || activeSession.current_step,
          data: decision.sessionData,
          selectedOption: decision.selectedOption,
          selectedUserType: decision.selectedUserType,
          status: decision.completeSession ? "completed" : "active"
        });
      }

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

async function handleFormSubmission({ req, res, flowName }) {
  try {
    const form = await readForm(req);
    console.log(`Incoming ${flowName} web form:`, form);
    const payload = Object.fromEntries(
      Object.entries(form).filter(([key]) => !["wa_id", "source"].includes(key))
    );
    const phoneNumber = payload.phone_number || payload.tenant_phone_number || form.phone || "";
    const result = await flowProcessor.process({
      flowName,
      source: "whatsapp_in_app_web_form",
      phoneNumber,
      payload
    });
    const confirmation = flowProcessor.confirmationMessage(flowName, payload);

    if (phoneNumber) {
      sendWhatsAppBodyInBackground({
        to: phoneNumber,
        body: confirmation
      });
    }

    sendText(res, 200, renderSuccessPage(confirmation), "text/html; charset=utf-8");
    console.log(`${flowName} web form processed:`, result.submissionId);
  } catch (error) {
    console.error("Web Form Error:", error);
    sendText(
      res,
      200,
      renderSuccessPage("We received your form, but could not complete setup yet. Please return to WhatsApp and send Hi so we can help you continue."),
      "text/html; charset=utf-8"
    );
  }
}

function renderTenantRegistrationForm({ phoneNumber, waId }) {
  return renderFormPage({
    title: "Tenant Registration",
    intro: "Create your PayRent tenant profile and rent goal.",
    action: "/forms/tenant-registration",
    hidden: { wa_id: waId },
    fields: [
      inputField("Full Name", "full_name", "text", "", true),
      inputField("Phone Number", "phone_number", "tel", phoneNumber, true),
      inputField("Email", "email", "email", "", false),
      selectField("Do you have an invitation code?", "has_invitation_code", [
        ["no", "No"],
        ["yes", "Yes"]
      ]),
      inputField("Invitation Code", "invitation_code", "text", "", false),
      inputField("Monthly Rent Amount", "monthly_rent_amount", "number", "", true),
      inputField("Rent Due Day", "rent_due_day", "number", "", true)
    ],
    submitLabel: "Create tenant profile"
  });
}

function renderSaveTowardsRentForm({ phoneNumber, waId }) {
  return renderFormPage({
    title: "Save Towards Rent",
    intro: "Create a rent savings goal that PayRent can help you track.",
    action: "/forms/save-towards-rent",
    hidden: { wa_id: waId },
    fields: [
      inputField("Full Name", "full_name", "text", "", true),
      inputField("Phone Number", "phone_number", "tel", phoneNumber, true),
      inputField("Monthly Rent Amount", "monthly_rent_amount", "number", "", true),
      inputField("Rent Due Day", "rent_due_day", "number", "", true),
      selectField("Savings Frequency", "savings_frequency", [
        ["daily", "Daily"],
        ["weekly", "Weekly"],
        ["monthly", "Monthly"]
      ]),
      inputField("Target Start Date", "target_start_date", "date", "", false)
    ],
    submitLabel: "Create savings goal"
  });
}

function renderFormPage({ title, intro, action, hidden, fields, submitLabel }) {
  const hiddenFields = Object.entries(hidden || {})
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | PayRent Kenya</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f4ef;
      color: #202124;
    }
    main {
      width: min(100%, 520px);
      margin: 0 auto;
      padding: 24px 18px 34px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.1;
    }
    p {
      margin: 0 0 20px;
      color: #5f6368;
      line-height: 1.45;
    }
    form {
      display: grid;
      gap: 14px;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 14px;
      font-weight: 700;
    }
    input, select {
      width: 100%;
      border: 1px solid #d6d0c7;
      border-radius: 8px;
      padding: 13px 12px;
      font-size: 16px;
      background: white;
      color: #202124;
    }
    button {
      margin-top: 8px;
      border: 0;
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 16px;
      font-weight: 800;
      background: #0f7b62;
      color: white;
    }
    .brand {
      font-weight: 800;
      color: #0f7b62;
      margin-bottom: 14px;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">PayRent Kenya</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(intro)}</p>
    <form method="post" action="${escapeHtml(action)}">
      ${hiddenFields}
      ${fields.join("\n")}
      <button type="submit">${escapeHtml(submitLabel)}</button>
    </form>
  </main>
</body>
</html>`;
}

function renderSuccessPage(message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PayRent Kenya</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f4ef;
      color: #202124;
    }
    main {
      width: min(100%, 520px);
      margin: 0 auto;
      padding: 36px 18px;
    }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { white-space: pre-line; line-height: 1.5; color: #3c4043; }
  </style>
</head>
<body>
  <main>
    <h1>Done ❤️</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

function inputField(label, name, type, value, required) {
  return `<label>${escapeHtml(label)}
    <input type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${required ? "required" : ""}>
  </label>`;
}

function selectField(label, name, options) {
  return `<label>${escapeHtml(label)}
    <select name="${escapeHtml(name)}" required>
      ${options.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join("")}
    </select>
  </label>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

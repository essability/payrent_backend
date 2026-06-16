import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AI_FALLBACK_REPLY, generatePayRentReply } from "./ai.js";
import { getConfig } from "./config.js";
import { extractTwilioFlowPayload, FlowProcessor } from "./flowProcessor.js";
import { readForm, readJson, requireApiSecret, sendJson, sendText } from "./http.js";
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

const TENANT_HOME_MENU = [
  "What would you like to do next?",
  "",
  "1. View my rent goal",
  "2. Save towards rent",
  "3. Set transaction PIN",
  "4. View payment history",
  "5. Ask PayRent AI",
  "6. Talk to support",
  "",
  "Reply with 1, 2, 3, 4, 5, or 6."
].join("\n");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "payrent-backend",
        aiConfigured: Boolean(config.openaiApiKey),
        openaiModel: config.openaiModel
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/whatsapp") {
      await handlePrimaryWhatsAppWebhook({ req, res });
      return;
    }

    if (req.method === "GET" && url.pathname === "/forms/tenant-registration") {
      const phoneNumber = url.searchParams.get("phone") || "";
      sendText(
        res,
        200,
        await renderRegistrationFormOrAlreadyRegistered({
          phoneNumber,
          formHtml: renderTenantRegistrationForm({
            phoneNumber,
            waId: url.searchParams.get("wa_id") || ""
          })
        }),
        "text/html; charset=utf-8"
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/forms/save-towards-rent") {
      const phoneNumber = url.searchParams.get("phone") || "";
      sendText(
        res,
        200,
        await renderRegistrationFormOrAlreadyRegistered({
          phoneNumber,
          formHtml: renderSaveTowardsRentForm({
            phoneNumber,
            waId: url.searchParams.get("wa_id") || ""
          })
        }),
        "text/html; charset=utf-8"
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/forms/landlord-registration") {
      const phoneNumber = url.searchParams.get("phone") || "";
      sendText(
        res,
        200,
        await renderRegistrationFormOrAlreadyRegistered({
          phoneNumber,
          formHtml: renderLandlordRegistrationForm({
            phoneNumber,
            waId: url.searchParams.get("wa_id") || ""
          })
        }),
        "text/html; charset=utf-8"
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/forms/property-manager-registration") {
      const phoneNumber = url.searchParams.get("phone") || "";
      sendText(
        res,
        200,
        await renderRegistrationFormOrAlreadyRegistered({
          phoneNumber,
          formHtml: renderPropertyManagerRegistrationForm({
            phoneNumber,
            waId: url.searchParams.get("wa_id") || ""
          })
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

    if (req.method === "POST" && url.pathname === "/forms/landlord-registration") {
      await handleFormSubmission({
        req,
        res,
        flowName: "landlord_registration"
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/forms/property-manager-registration") {
      await handleFormSubmission({
        req,
        res,
        flowName: "property_manager_registration"
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

      await handlePrimaryWhatsAppWebhook({ req, res, preloadedForm: form });
      return;
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/webhooks/twilio/whatsapp-flow" || url.pathname === "/webhook/whatsapp-flow")
    ) {
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
        const profileName = form.ProfileName || "WhatsApp User";
        const extracted = extractTwilioFlowPayload(form);
        const result = await flowProcessor.process({
          flowName: extracted.flowName,
          source: "twilio_whatsapp_flow",
          phoneNumber,
          profileName,
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

async function handlePrimaryWhatsAppWebhook({ req, res, preloadedForm }) {
  try {
    const form = preloadedForm || await readForm(req);
    const result = await handleIncomingWhatsAppMessage({
      payload: form,
      formBaseUrl: publicBaseUrlFromRequest(req)
    });

    sendText(res, 200, twiml(result.reply), "text/xml; charset=utf-8");

    handleWhatsAppPostReplyTasks(result);
  } catch (error) {
    console.error("Webhook Error:", error);
    sendText(res, 200, twiml(WELCOME_MENU), "text/xml; charset=utf-8");
  }
}

async function handleIncomingWhatsAppMessage({ payload, formBaseUrl }) {
  console.log("Incoming Twilio WhatsApp webhook:", payload);
  console.log("Incoming From", payload.From);
  console.log("Incoming WaId", payload.WaId);

  const phoneNumber = normalizeWhatsAppPhone(payload.From);
  const waId = payload.WaId || "";
  const externalUserId = resolveExternalUserId(payload);
  const profileName = payload.ProfileName || "there";
  const message = payload.Body || "";

  console.log("Resolved external_user_id", externalUserId);

  await safeSaveMessage({
    phoneNumber,
    direction: "user",
    body: message,
    channel: "whatsapp"
  });

  const activeSession = await getActiveSessionForDecision(externalUserId);
  console.log("Loaded session", activeSession);

  const decision = await decidePayRentWelcomeReply({
    message,
    phoneNumber,
    waId,
    externalUserId,
    profileName,
    formBaseUrl,
    activeSession
  });

  await safeSaveMessage({
    phoneNumber,
    direction: "assistant",
    body: decision.reply,
    channel: "whatsapp"
  });

  return {
    phoneNumber,
    waId,
    externalUserId,
    profileName,
    incomingMessage: message,
    outgoingMessage: decision.reply,
    reply: decision.reply,
    decision
  };
}

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

async function decidePayRentWelcomeReply({ message, phoneNumber, waId, externalUserId, profileName, formBaseUrl, activeSession }) {
  const text = String(message || "").trim();
  const normalized = text.toLowerCase();
  const tenantFormUrl = buildFormUrl(formBaseUrl, "/forms/tenant-registration", phoneNumber);
  const saveFormUrl = buildFormUrl(formBaseUrl, "/forms/save-towards-rent", phoneNumber);
  const landlordFormUrl = buildFormUrl(formBaseUrl, "/forms/landlord-registration", phoneNumber);
  const propertyManagerFormUrl = buildFormUrl(formBaseUrl, "/forms/property-manager-registration", phoneNumber);

  if (normalized === "cancel" && activeSession) {
    await service.cancelOnboardingFlow(activeSession);
    return {
      reply: `${WELCOME_MENU}`,
      selectedOption: null,
      selectedUserType: null,
      skipSessionUpdate: true
    };
  }

  if (normalized === "help") {
    return {
      reply: "PayRent helps you register, save towards rent, receive reminders, and manage rent from WhatsApp. Reply MENU to see options or CANCEL to stop the current flow.",
      selectedOption: null,
      selectedUserType: null,
      skipSessionUpdate: true
    };
  }

  if (normalized === "status") {
    if (activeSession) {
      const step = normalizeOnboardingStep(activeSession.data?.step || activeSession.current_step);
      return {
        reply: `You are currently on step: ${step}. Please answer the last question, or reply MENU to restart.`,
        selectedOption: null,
        selectedUserType: activeSession.flow_type || activeSession.data?.flow_type,
        skipSessionUpdate: true
      };
    }

    return {
      reply: "You do not have an active onboarding flow. Reply MENU to start.",
      selectedOption: null,
      selectedUserType: null,
      skipSessionUpdate: true
    };
  }

  if (normalized === "menu") {
    if (activeSession) await service.cancelOnboardingFlow(activeSession);
    const registeredUser = await getRegisteredUserForDecision(phoneNumber);
    if (registeredUser) {
      return {
        reply: buildTenantHomeMenu(registeredUser.full_name),
        selectedOption: null,
        selectedUserType: null,
        skipSessionUpdate: true
      };
    }

    return {
      reply: WELCOME_MENU,
      selectedOption: null,
      selectedUserType: null,
      skipSessionUpdate: true
    };
  }

  if (normalized === "home") {
    const knownUser = await getRegisteredUserForDecision(phoneNumber);
    return {
      reply: knownUser ? buildTenantHomeMenu(knownUser.full_name) : WELCOME_MENU,
      selectedOption: null,
      selectedUserType: null,
      skipSessionUpdate: true
    };
  }

  if (isRealActiveFlowSession(activeSession)) {
    return continueFlow(activeSession, text);
  }

  const knownUser = await getRegisteredUserForDecision(phoneNumber);

  if (isWelcomeTrigger(normalized)) {
    return {
      reply: knownUser ? buildTenantHomeMenu(knownUser.full_name) : WELCOME_MENU,
      selectedOption: null,
      selectedUserType: null,
      skipSessionUpdate: true
    };
  }

  if (normalized.startsWith("tenant:")) {
    return {
      reply: "Thank you ❤️ We’re creating your PayRent tenant profile now.",
      fallbackFlowName: "tenant_registration",
      fallbackPayload: parseColonCsvPayload(text, "tenant"),
      skipSessionUpdate: true
    };
  }

  if (normalized.startsWith("save:")) {
    return {
      reply: "Beautiful ❤️ We’re creating your rent savings goal now.",
      fallbackFlowName: "save_towards_rent",
      fallbackPayload: parseColonCsvPayload(text, "save"),
      skipSessionUpdate: true
    };
  }

  if (knownUser) {
    if (looksLikeRegisteredReturn(normalized) || looksLikeRegistrationRequest(normalized)) {
      return {
        reply: [
          `You are already registered on PayRent${knownUser.full_name && knownUser.full_name !== "Unknown" ? `, ${knownUser.full_name}` : ""} ❤️`,
          "",
          TENANT_HOME_MENU
        ].join("\n"),
        selectedOption: "registered_home",
        selectedUserType: "tenant",
        skipSessionUpdate: true
      };
    }

    const tenantHomeDecision = await handleTenantHomeAction({
      normalized,
      text,
      phoneNumber,
      waId,
      externalUserId,
      profileName,
      knownUser
    });
    if (tenantHomeDecision) return tenantHomeDecision;
  }

  if (normalized === "1") {
    return {
      reply: [
        "Beautiful choice ❤️",
        "",
        "Please complete your Tenant Registration using this secure PayRent link:",
        "",
        tenantFormUrl,
        "",
        "Once you submit, I’ll send your WhatsApp confirmation here."
      ].join("\n"),
      selectedOption: "1",
      selectedUserType: "tenant",
      skipSessionUpdate: true
    };
  }

  if (normalized === "4") {
    return {
      reply: [
        "Beautiful choice ❤️",
        "",
        "Please create your rent savings goal using this secure PayRent link:",
        "",
        saveFormUrl,
        "",
        "Once you submit, I’ll send your WhatsApp confirmation here."
      ].join("\n"),
      selectedOption: "4",
      selectedUserType: "save_towards_rent",
      skipSessionUpdate: true
    };
  }

  if (normalized === "2") {
    return {
      reply: [
        "Beautiful choice ❤️",
        "",
        "Please complete your Landlord Registration using this secure PayRent link:",
        "",
        landlordFormUrl,
        "",
        "Once you submit, I’ll send your WhatsApp confirmation here."
      ].join("\n"),
      selectedOption: "2",
      selectedUserType: "landlord",
      skipSessionUpdate: true
    };
  }

  if (normalized === "3") {
    return {
      reply: [
        "Beautiful choice ❤️",
        "",
        "Please complete your Property Manager Registration using this secure PayRent link:",
        "",
        propertyManagerFormUrl,
        "",
        "Once you submit, I’ll send your WhatsApp confirmation here."
      ].join("\n"),
      selectedOption: "3",
      selectedUserType: "property_manager",
      skipSessionUpdate: true
    };
  }

  if (looksLikeRegistrationRequest(normalized)) {
    return {
      reply: AI_FALLBACK_REPLY,
      selectedOption: null,
      selectedUserType: null,
      skipSessionUpdate: true
    };
  }

  if (looksLikePaymentRequest(normalized)) {
    return {
      reply: "Rent payment through M-PESA is coming soon ❤️ For now, PayRent can help you register, save towards rent, track your goal, and receive reminders. Reply 1 for Tenant or 4 to Save Towards Rent.",
      selectedOption: null,
      selectedUserType: null,
      skipSessionUpdate: true
    };
  }

  const aiReply = await generateAiReplyForWhatsApp({ phoneNumber, userMessage: text });
  return {
    reply: aiReply,
    selectedOption: null,
    selectedUserType: "ai_assistant",
    skipSessionUpdate: true
  };
}

async function getRegisteredUserForDecision(phoneNumber) {
  try {
    const context = await service.getAiUserContext(phoneNumber);
    const name = String(context?.name || "").trim();
    const roles = context?.roles || [];
    if (!context?.is_known_user) return null;
    if (name && name !== "Unknown") return { full_name: name, roles };
    if (roles.length > 0) return { full_name: name || "there", roles };
    return null;
  } catch (error) {
    console.error("Registered User Lookup Error:", error);
    return null;
  }
}

async function handleTenantHomeAction({ normalized, phoneNumber, waId, externalUserId, profileName, knownUser }) {
  if (normalized === "1" || normalized === "goal" || normalized === "rent goal" || normalized === "balance") {
    try {
      const balance = await service.getRentBalance({ tenantPhoneNumber: phoneNumber });
      return {
        reply: buildRentGoalSummary(balance, knownUser.full_name),
        selectedOption: "tenant_goal",
        selectedUserType: "tenant",
        skipSessionUpdate: true
      };
    } catch (error) {
      console.error("Rent Goal Summary Error:", error);
      return {
        reply: `I could not load your rent goal right now.\n\n${TENANT_HOME_MENU}`,
        selectedOption: "tenant_goal",
        selectedUserType: "tenant",
        skipSessionUpdate: true
      };
    }
  }

  if (normalized === "2" || normalized === "save" || normalized === "savings") {
    const session = await service.startOnboardingFlow({
      phoneNumber,
      waId,
      externalUserId,
      flowType: "savings_deposit",
      selectedOption: "tenant_save",
      step: "amount",
      data: {
        flow_type: "savings_deposit",
        step: "amount",
        profile_name: profileName,
        phone_number: phoneNumber
      }
    });
    console.log("Started session", session);
    return {
      reply: "How much do you want to save towards rent today? Example: 1000",
      selectedOption: "tenant_save",
      selectedUserType: "tenant",
      sessionId: session.id,
      skipSessionUpdate: true
    };
  }

  if (normalized === "3" || normalized === "pin" || normalized === "set pin") {
    const session = await service.startOnboardingFlow({
      phoneNumber,
      waId,
      externalUserId,
      flowType: "set_pin",
      selectedOption: "tenant_pin",
      step: "pin",
      data: {
        flow_type: "set_pin",
        step: "pin",
        profile_name: profileName,
        phone_number: phoneNumber
      }
    });
    console.log("Started session", session);
    return {
      reply: "Please set a 4 to 6 digit transaction PIN.",
      selectedOption: "tenant_pin",
      selectedUserType: "tenant",
      sessionId: session.id,
      skipSessionUpdate: true
    };
  }

  if (normalized === "4" || normalized === "history" || normalized === "payments") {
    try {
      const history = await service.getPaymentHistory({ tenantPhoneNumber: phoneNumber, limit: 5 });
      return {
        reply: buildPaymentHistory(history),
        selectedOption: "tenant_history",
        selectedUserType: "tenant",
        skipSessionUpdate: true
      };
    } catch (error) {
      console.error("Payment History Error:", error);
      return {
        reply: `I could not load your payment history right now.\n\n${TENANT_HOME_MENU}`,
        selectedOption: "tenant_history",
        selectedUserType: "tenant",
        skipSessionUpdate: true
      };
    }
  }

  if (normalized === "5" || normalized === "ai" || normalized === "ask ai") {
    const session = await service.startOnboardingFlow({
      phoneNumber,
      waId,
      externalUserId,
      flowType: "ai_question",
      selectedOption: "tenant_ai",
      step: "question",
      data: {
        flow_type: "ai_question",
        step: "question",
        profile_name: profileName,
        phone_number: phoneNumber
      }
    });
    console.log("Started session", session);
    return {
      reply: "Ask me anything about PayRent, rent savings, reminders, or your account.",
      selectedOption: "tenant_ai",
      selectedUserType: "tenant",
      sessionId: session.id,
      skipSessionUpdate: true
    };
  }

  if (normalized === "6" || normalized === "support" || normalized === "help me") {
    const session = await service.startOnboardingFlow({
      phoneNumber,
      waId,
      externalUserId,
      flowType: "support_request",
      selectedOption: "tenant_support",
      step: "message",
      data: {
        flow_type: "support_request",
        step: "message",
        profile_name: profileName,
        phone_number: phoneNumber
      }
    });
    console.log("Started session", session);
    return {
      reply: "Please tell us what you need help with. Ruth’s PayRent team will review it.",
      selectedOption: "tenant_support",
      selectedUserType: "tenant",
      sessionId: session.id,
      skipSessionUpdate: true
    };
  }

  return null;
}

function buildTenantHomeMenu(fullName) {
  const name = String(fullName || "").trim();
  return [
    name && name !== "Unknown" ? `Welcome back, ${name} ❤️` : "Welcome back to PayRent ❤️",
    "",
    TENANT_HOME_MENU
  ].join("\n");
}

function isWelcomeTrigger(normalized) {
  return ["", "hi", "hello", "start", "menu", "hey", "good morning", "good afternoon", "good evening"].includes(normalized);
}

function looksLikeRegistrationRequest(normalized) {
  return /\b(register|registration|sign up|signup|join|create account|open account)\b/.test(normalized);
}

function looksLikeRegisteredReturn(normalized) {
  return /\b(i have registered|i registered|registered on payrent|done registering|registration complete|i am registered)\b/.test(normalized);
}

function looksLikePaymentRequest(normalized) {
  return /\b(pay|payment|mpesa|m-pesa|paid|send money|till|paybill)\b/.test(normalized);
}

async function generateAiReplyForWhatsApp({ phoneNumber, userMessage }) {
  try {
    const [userProfile, recentMessages] = await Promise.all([
      service.getAiUserContext(phoneNumber),
      service.getRecentMessagesForPhone(phoneNumber, 8)
    ]);

    return generatePayRentReply({
      userMessage,
      userProfile,
      recentMessages,
      apiKey: config.openaiApiKey,
      model: config.openaiModel
    });
  } catch (error) {
    console.error("AI Context Error:", error);
    return AI_FALLBACK_REPLY;
  }
}

function buildFormUrl(baseUrl, pathname, phoneNumber) {
  const url = new URL(pathname, baseUrl);
  if (phoneNumber) {
    url.searchParams.set("phone", phoneNumber);
    url.searchParams.set("wa_id", phoneNumber);
  }
  return url.toString();
}

function resolveExternalUserId(payload) {
  const waId = String(payload?.WaId || "").trim();
  if (waId) return waId;
  return normalizeWhatsAppPhone(payload?.From);
}

async function safeSaveMessage({ phoneNumber, direction, body, channel }) {
  try {
    await service.saveMessage({ phoneNumber, direction, body, channel });
  } catch (error) {
    console.error("Message Save Error:", {
      direction,
      phoneNumber,
      body,
      error
    });
  }
}

async function getActiveSessionForDecision(externalUserId) {
  try {
    return await service.getActiveOnboardingSession(externalUserId);
  } catch (error) {
    console.error("Onboarding Session Lookup Error:", error);
    return null;
  }
}

async function continueFlow(session, message) {
  const data = session.data || {};
  const flowType = session.flow_type || data.flow_type;
  const step = normalizeOnboardingStep(data.step || session.current_step);

  console.log("Current flow_type", flowType);
  console.log("Current step", step);
  console.log("User answer", message);

  if (flowType === "tenant") {
    return continueTenantFlow(session, data, step, message);
  }

  if (flowType === "save_towards_rent") {
    return continueSaveTowardsRentFlow(session, data, step, message);
  }

  if (flowType === "landlord") {
    return continueLandlordFlow(session, data, step, message);
  }

  if (flowType === "property_manager") {
    return continuePropertyManagerFlow(session, data, step, message);
  }

  if (flowType === "set_pin") {
    return continueSetPinFlow(session, data, step, message);
  }

  if (flowType === "savings_deposit") {
    return continueSavingsDepositFlow(session, data, step, message);
  }

  if (flowType === "ai_question") {
    return continueAiQuestionFlow(session, data, step, message);
  }

  if (flowType === "support_request") {
    return continueSupportRequestFlow(session, data, step, message);
  }

  console.log("Next step", "choose_user_type");
  return { reply: WELCOME_MENU, skipSessionUpdate: true };
}

async function continueTenantFlow(session, data, step, message) {
  if (step === "full_name") {
    const nextData = { ...data, full_name: message, step: "id_number" };
    await service.advanceOnboardingFlow({ session, step: "id_number", data: nextData });
    console.log("Next step", "id_number");
    return { reply: "What is your ID number?", skipSessionUpdate: true };
  }

  if (step === "id_number") {
    const nextData = { ...data, id_number: message, national_id_number: message, step: "invitation_code_question" };
    await service.advanceOnboardingFlow({ session, step: "invitation_code_question", data: nextData });
    console.log("Next step", "invitation_code_question");
    return { reply: "Do you have an invitation code? Reply Yes or No.", skipSessionUpdate: true };
  }

  if (step === "invitation_code_question") {
    const hasInvitation = ["yes", "y"].includes(message.toLowerCase());
    const nextStep = hasInvitation ? "invitation_code" : "monthly_rent";
    const nextData = {
      ...data,
      has_invitation_code: hasInvitation ? "yes" : "no",
      step: nextStep
    };
    await service.advanceOnboardingFlow({ session, step: nextStep, data: nextData });
    console.log("Next step", nextStep);
    return {
      reply: hasInvitation ? "Please enter your invitation code." : "What is your monthly rent amount?",
      skipSessionUpdate: true
    };
  }

  if (step === "invitation_code") {
    const nextData = { ...data, invitation_code: message, step: "monthly_rent" };
    await service.advanceOnboardingFlow({ session, step: "monthly_rent", data: nextData });
    console.log("Next step", "monthly_rent");
    return { reply: "What is your monthly rent amount?", skipSessionUpdate: true };
  }

  if (step === "monthly_rent") {
    const nextData = { ...data, monthly_rent_amount: message, step: "due_day" };
    await service.advanceOnboardingFlow({ session, step: "due_day", data: nextData });
    console.log("Next step", "due_day");
    return { reply: "What day of the month is rent due?", skipSessionUpdate: true };
  }

  if (step === "due_day") {
    const payload = {
      ...data,
      rent_due_day: message,
      phone_number: data.phone_number || session.phone_number,
      full_name: data.full_name || data.profile_name || "WhatsApp User",
      flow_name: "tenant_registration"
    };
    try {
      await service.createTenantFromFlow({
        fullName: payload.full_name,
        phoneNumber: payload.phone_number,
        email: payload.email || null,
        nationalIdNumber: payload.national_id_number || payload.id_number || null,
        hasInvitationCode: payload.has_invitation_code,
        invitationCode: payload.invitation_code || null,
        monthlyRentAmount: parseMoneyAmount(payload.monthly_rent_amount),
        rentDueDay: Number.parseInt(payload.rent_due_day, 10),
        signupChannel: "whatsapp"
      });
    } catch (error) {
      console.error("Tenant Completion Save Error:", error);
      return {
        reply: "I received your details, but I could not complete registration right now. Please try again in a moment.",
        skipSessionUpdate: true
      };
    }
    await service.advanceOnboardingFlow({ session, step: "complete", data: { ...payload, step: "complete" }, status: "completed" });
    console.log("Next step", "complete");
    return {
      reply: [
        "Registration complete. Beautiful ❤️",
        "We’re creating your PayRent tenant profile now.",
        "",
        TENANT_HOME_MENU
      ].join("\n"),
      completeSession: true,
      skipSessionUpdate: true
    };
  }

  console.log("Next step", "unknown");
  return { reply: "Please reply MENU to restart or CANCEL to stop.", skipSessionUpdate: true };
}

async function continueSetPinFlow(session, data, step, message) {
  if (step === "pin") {
    if (!/^\d{4,6}$/.test(String(message || ""))) {
      return { reply: "Please enter a 4 to 6 digit PIN.", skipSessionUpdate: true };
    }

    const nextData = { ...data, pin: message, step: "confirm_pin" };
    await service.advanceOnboardingFlow({ session, step: "confirm_pin", data: nextData });
    return { reply: "Please confirm your transaction PIN.", skipSessionUpdate: true };
  }

  if (step === "confirm_pin") {
    if (message !== data.pin) {
      const nextData = { ...data, pin: null, step: "pin" };
      await service.advanceOnboardingFlow({ session, step: "pin", data: nextData });
      return { reply: "The PINs did not match. Please enter a new 4 to 6 digit PIN.", skipSessionUpdate: true };
    }

    try {
      await service.setTransactionPin({
        phoneNumber: data.phone_number || session.phone_number,
        pin: message
      });
      await service.advanceOnboardingFlow({
        session,
        step: "complete",
        data: { ...data, pin: null, step: "complete" },
        status: "completed"
      });

      return {
        reply: [
          "Your transaction PIN has been set securely ❤️",
          "",
          TENANT_HOME_MENU
        ].join("\n"),
        skipSessionUpdate: true
      };
    } catch (error) {
      console.error("Set PIN Error:", error);
      return { reply: "I could not set your PIN right now. Please reply 3 from the menu and try again.", skipSessionUpdate: true };
    }
  }

  return { reply: "Please reply MENU to restart or CANCEL to stop.", skipSessionUpdate: true };
}

async function continueSavingsDepositFlow(session, data, step, message) {
  if (step === "amount") {
    const amount = parseMoneyAmount(message);
    if (!amount) return { reply: "Please enter the amount as a number. Example: 1000", skipSessionUpdate: true };

    const nextData = { ...data, amount, step: "pin" };
    await service.advanceOnboardingFlow({ session, step: "pin", data: nextData });
    return { reply: "Please enter your transaction PIN to confirm this rent saving.", skipSessionUpdate: true };
  }

  if (step === "pin") {
    try {
      const result = await service.recordSavingsDeposit({
        tenantPhoneNumber: data.phone_number || session.phone_number,
        amount: Number(data.amount),
        method: "mpesa",
        providerReference: null,
        transactionPin: message,
        metadata: {
          source: "whatsapp_chat",
          type: "rent_savings"
        }
      });
      await service.advanceOnboardingFlow({
        session,
        step: "complete",
        data: { ...data, step: "complete" },
        status: "completed"
      });

      return {
        reply: [
          `Beautiful ❤️ You have saved KES ${formatKes(data.amount)} towards rent.`,
          "",
          buildRentGoalProgress(result.rentGoal),
          "",
          TENANT_HOME_MENU
        ].join("\n"),
        skipSessionUpdate: true
      };
    } catch (error) {
      console.error("Savings Deposit Error:", error);
      const messageText = /PIN/i.test(error.message || "")
        ? "That PIN could not be verified. Please reply 3 to set your PIN or try saving again."
        : "I could not record that saving right now. Please try again in a moment.";
      return { reply: `${messageText}\n\n${TENANT_HOME_MENU}`, skipSessionUpdate: true };
    }
  }

  return { reply: "Please reply MENU to restart or CANCEL to stop.", skipSessionUpdate: true };
}

async function continueAiQuestionFlow(session, data, step, message) {
  if (step === "question") {
    const phoneNumber = data.phone_number || session.phone_number;
    const reply = await generateAiReplyForWhatsApp({ phoneNumber, userMessage: message });
    await service.advanceOnboardingFlow({
      session,
      step: "complete",
      data: { ...data, question: message, step: "complete" },
      status: "completed"
    });
    return {
      reply: [
        reply,
        "",
        "Reply 5 to ask another question, or MENU for options."
      ].join("\n"),
      skipSessionUpdate: true
    };
  }

  return { reply: "Please reply MENU to restart or CANCEL to stop.", skipSessionUpdate: true };
}

async function continueSupportRequestFlow(session, data, step, message) {
  if (step === "message") {
    try {
      await service.createSupportRequest({
        phoneNumber: data.phone_number || session.phone_number,
        message
      });
      await service.advanceOnboardingFlow({
        session,
        step: "complete",
        data: { ...data, support_message: message, step: "complete" },
        status: "completed"
      });
      return {
        reply: [
          "Thank you ❤️ Your support request has been received.",
          "The PayRent team will review it and follow up.",
          "",
          TENANT_HOME_MENU
        ].join("\n"),
        skipSessionUpdate: true
      };
    } catch (error) {
      console.error("Support Request Error:", error);
      return { reply: `I could not save your support request right now.\n\n${TENANT_HOME_MENU}`, skipSessionUpdate: true };
    }
  }

  return { reply: "Please reply MENU to restart or CANCEL to stop.", skipSessionUpdate: true };
}

async function continueLandlordFlow(session, data, step, message) {
  if (step === "full_name") {
    const nextData = { ...data, full_name: message, step: "id_number" };
    await service.advanceOnboardingFlow({ session, step: "id_number", data: nextData });
    console.log("Next step", "id_number");
    return { reply: "What is your ID number?", skipSessionUpdate: true };
  }

  if (step === "id_number") {
    const nextData = { ...data, id_number: message, national_id_number: message, step: "property_name" };
    await service.advanceOnboardingFlow({ session, step: "property_name", data: nextData });
    console.log("Next step", "property_name");
    return { reply: "What is the name of your property?", skipSessionUpdate: true };
  }

  if (step === "property_name") {
    const nextData = { ...data, property_name: message, step: "county" };
    await service.advanceOnboardingFlow({ session, step: "county", data: nextData });
    console.log("Next step", "county");
    return { reply: "Which county is the property in?", skipSessionUpdate: true };
  }

  if (step === "county") {
    const nextData = { ...data, county: message, step: "units" };
    await service.advanceOnboardingFlow({ session, step: "units", data: nextData });
    console.log("Next step", "units");
    return { reply: "How many units do you manage at this property?", skipSessionUpdate: true };
  }

  if (step === "units") {
    const nextData = { ...data, units_count: message, step: "payment_method" };
    await service.advanceOnboardingFlow({ session, step: "payment_method", data: nextData });
    console.log("Next step", "payment_method");
    return { reply: "How do you currently receive rent? Reply M-PESA, Bank, or Cash.", skipSessionUpdate: true };
  }

  if (step === "payment_method") {
    const payload = {
      ...data,
      payment_method: message,
      phone_number: data.phone_number || session.phone_number,
      full_name: data.full_name || data.profile_name || "WhatsApp User",
      flow_name: "landlord_registration"
    };
    await service.advanceOnboardingFlow({ session, step: "complete", data: { ...payload, step: "complete" }, status: "completed" });
    try {
      await service.createLandlordFromChat(payload);
    } catch (error) {
      console.error("Landlord Flow Save Error:", error);
      return {
        reply: "Thank you ❤️ I received your landlord details, but I could not save them right now. Please reply MENU and try again in a moment.",
        skipSessionUpdate: true
      };
    }
    console.log("Next step", "complete");
    return {
      reply: [
        `Thank you ${payload.full_name} ❤️`,
        "",
        "Your PayRent landlord profile has been created.",
        "",
        "You can now create properties, invite tenants, and track rent collections as we open more tools for you."
      ].join("\n"),
      skipSessionUpdate: true
    };
  }

  console.log("Next step", "unknown");
  return { reply: "Please reply MENU to restart or CANCEL to stop.", skipSessionUpdate: true };
}

async function continuePropertyManagerFlow(session, data, step, message) {
  if (step === "full_name") {
    const nextData = { ...data, full_name: message, step: "id_number" };
    await service.advanceOnboardingFlow({ session, step: "id_number", data: nextData });
    console.log("Next step", "id_number");
    return { reply: "What is your ID number?", skipSessionUpdate: true };
  }

  if (step === "id_number") {
    const nextData = { ...data, id_number: message, national_id_number: message, step: "company_name" };
    await service.advanceOnboardingFlow({ session, step: "company_name", data: nextData });
    console.log("Next step", "company_name");
    return { reply: "What is your company name?", skipSessionUpdate: true };
  }

  if (step === "company_name") {
    const nextData = { ...data, company_name: message, step: "properties_count" };
    await service.advanceOnboardingFlow({ session, step: "properties_count", data: nextData });
    console.log("Next step", "properties_count");
    return { reply: "How many properties do you manage?", skipSessionUpdate: true };
  }

  if (step === "properties_count") {
    const nextData = { ...data, properties_count: message, step: "county" };
    await service.advanceOnboardingFlow({ session, step: "county", data: nextData });
    console.log("Next step", "county");
    return { reply: "Which county do you mainly operate in?", skipSessionUpdate: true };
  }

  if (step === "county") {
    const payload = {
      ...data,
      county: message,
      phone_number: data.phone_number || session.phone_number,
      full_name: data.full_name || data.profile_name || "WhatsApp User",
      flow_name: "property_manager_registration"
    };
    await service.advanceOnboardingFlow({ session, step: "complete", data: { ...payload, step: "complete" }, status: "completed" });
    try {
      await service.createPropertyManagerFromChat(payload);
    } catch (error) {
      console.error("Property Manager Flow Save Error:", error);
      return {
        reply: "Thank you ❤️ I received your property manager details, but I could not save them right now. Please reply MENU and try again in a moment.",
        skipSessionUpdate: true
      };
    }
    console.log("Next step", "complete");
    return {
      reply: [
        `Thank you ${payload.full_name} ❤️`,
        "",
        "Your PayRent property manager profile has been created.",
        "",
        "You can now manage landlords, properties, tenants, and collections as we open more tools for you."
      ].join("\n"),
      skipSessionUpdate: true
    };
  }

  console.log("Next step", "unknown");
  return { reply: "Please reply MENU to restart or CANCEL to stop.", skipSessionUpdate: true };
}

function isRealActiveFlowSession(session) {
  if (!session || session.status !== "active") return false;
  const data = session.data || {};
  const flowType = session.flow_type || data.flow_type;
  const step = normalizeOnboardingStep(data.step || session.current_step);

  return Boolean(
    flowType &&
    step &&
    !["choose_user_type", "flow_launch_requested", "complete", "completed", "cancelled"].includes(step)
  );
}

function normalizeOnboardingStep(step) {
  const normalized = String(step || "").trim();
  const aliases = {
    chat_tenant_full_name: "full_name",
    chat_save_full_name: "full_name",
    chat_tenant_id_number: "id_number",
    chat_save_id_number: "id_number",
    chat_tenant_monthly_rent: "monthly_rent",
    chat_save_monthly_rent: "monthly_rent",
    chat_tenant_due_day: "due_day",
    chat_save_due_day: "due_day"
  };
  return aliases[normalized] || normalized;
}

function buildRentGoalSummary(balance, fullName) {
  const goal = balance.activeGoal;
  if (!goal) {
    return [
      `Hi ${fullName || "there"} ❤️`,
      "",
      "I could not find an active rent goal yet.",
      "Reply 4 from the main menu to create a Save Towards Rent goal.",
      "",
      TENANT_HOME_MENU
    ].join("\n");
  }

  const rent = Number(goal.monthly_rent_amount || 0);
  const saved = Number(goal.amount_saved || 0);
  const remaining = Math.max(rent - saved, 0);
  return [
    `Hi ${fullName || "there"} ❤️`,
    "",
    "Here is your rent goal:",
    `Monthly rent: KES ${formatKes(rent)}`,
    `Saved so far: KES ${formatKes(saved)}`,
    `Remaining: KES ${formatKes(remaining)}`,
    `Rent due day: ${goal.rent_due_day || "Not set"}`,
    "",
    remaining === 0 ? "You have reached your rent goal. Beautiful work." : "Reply 2 to save towards rent.",
    "",
    TENANT_HOME_MENU
  ].join("\n");
}

function buildRentGoalProgress(goal) {
  if (!goal) return "Your saving has been recorded.";
  const rent = Number(goal.monthly_rent_amount || 0);
  const saved = Number(goal.amount_saved || 0);
  const remaining = Math.max(rent - saved, 0);
  return `Saved so far: KES ${formatKes(saved)}\nRemaining: KES ${formatKes(remaining)}`;
}

function buildPaymentHistory({ payments }) {
  if (!payments || payments.length === 0) {
    return [
      "You do not have any PayRent payments or savings yet.",
      "",
      "Reply 2 to save towards rent.",
      "",
      TENANT_HOME_MENU
    ].join("\n");
  }

  const lines = payments.slice(0, 5).map((payment, index) => {
    const date = payment.paid_at || payment.created_at || "";
    const shortDate = date ? new Date(date).toISOString().slice(0, 10) : "Pending date";
    return `${index + 1}. KES ${formatKes(payment.amount)} - ${payment.status || "recorded"} - ${shortDate}`;
  });

  return [
    "Your recent PayRent history:",
    "",
    ...lines,
    "",
    TENANT_HOME_MENU
  ].join("\n");
}

function parseMoneyAmount(value) {
  const amount = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseDueDay(value) {
  const day = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  return Number.isInteger(day) && day >= 1 && day <= 30 ? day : null;
}

function normalizeSavingsFrequency(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["daily", "weekly", "monthly"].includes(normalized)) return normalized;
  return null;
}

function formatKes(value) {
  return Number(value || 0).toLocaleString("en-KE", {
    maximumFractionDigits: 0
  });
}

async function continueSaveTowardsRentFlow(session, data, step, message) {
  if (step === "full_name") {
    const nextData = { ...data, full_name: message, step: "id_number" };
    await service.advanceOnboardingFlow({ session, step: "id_number", data: nextData });
    console.log("Next step", "id_number");
    return { reply: "What is your ID number?", skipSessionUpdate: true };
  }

  if (step === "id_number") {
    const nextData = { ...data, id_number: message, national_id_number: message, step: "monthly_rent" };
    await service.advanceOnboardingFlow({ session, step: "monthly_rent", data: nextData });
    console.log("Next step", "monthly_rent");
    return { reply: "What is your monthly rent amount?", skipSessionUpdate: true };
  }

  if (step === "monthly_rent") {
    const nextData = { ...data, monthly_rent_amount: message, step: "due_day" };
    await service.advanceOnboardingFlow({ session, step: "due_day", data: nextData });
    console.log("Next step", "due_day");
    return { reply: "What day of the month is rent due?", skipSessionUpdate: true };
  }

  if (step === "due_day") {
    const nextData = { ...data, rent_due_day: message, step: "savings_frequency" };
    await service.advanceOnboardingFlow({ session, step: "savings_frequency", data: nextData });
    console.log("Next step", "savings_frequency");
    return { reply: "How often do you want to save? Reply Daily, Weekly, or Monthly.", skipSessionUpdate: true };
  }

  if (step === "savings_frequency") {
    const savingsFrequency = normalizeSavingsFrequency(message);
    if (!savingsFrequency) {
      return {
        reply: "Please reply Daily, Weekly, or Monthly to finish your rent savings goal. You can also reply MENU to restart.",
        skipSessionUpdate: true
      };
    }

    const payload = {
      ...data,
      savings_frequency: savingsFrequency,
      phone_number: data.phone_number || session.phone_number,
      full_name: data.full_name || data.profile_name || "WhatsApp User",
      flow_name: "save_towards_rent"
    };
    try {
      await service.createSaveTowardsRentGoal({
        fullName: payload.full_name,
        phoneNumber: payload.phone_number,
        nationalIdNumber: payload.national_id_number || payload.id_number || null,
        monthlyRentAmount: parseMoneyAmount(payload.monthly_rent_amount),
        rentDueDay: Number.parseInt(payload.rent_due_day, 10),
        savingsFrequency: payload.savings_frequency,
        targetStartDate: payload.target_start_date || null,
        signupChannel: "whatsapp"
      });
    } catch (error) {
      console.error("Save Towards Rent Completion Error:", error);
      return {
        reply: "I received your details, but I could not create your rent savings goal right now. Please try again in a moment.",
        skipSessionUpdate: true
      };
    }
    await service.advanceOnboardingFlow({ session, step: "complete", data: { ...payload, step: "complete" }, status: "completed" });
    console.log("Next step", "complete");
    return {
      reply: [
        "Registration complete. Beautiful ❤️",
        "We’re creating your rent savings goal now.",
        "",
        TENANT_HOME_MENU
      ].join("\n"),
      completeSession: true,
      skipSessionUpdate: true
    };
  }

  console.log("Next step", "unknown");
  return { reply: "Please reply MENU to restart or CANCEL to stop.", skipSessionUpdate: true };
}

function handleWhatsAppPostReplyTasks({ phoneNumber, profileName, decision }) {
  setImmediate(async () => {
    try {
      console.log("WhatsApp post-reply tasks start");

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
          flowName: decision.flowName,
          profileName,
          phoneNumber,
          sessionId: decision.sessionId
        });
      }

      console.log("WhatsApp post-reply tasks complete");
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

async function launchWhatsAppFlowInBackground({ to, flowName, profileName, phoneNumber, sessionId }) {
  let contentSid = null;
  try {
    contentSid = config.twilioFlowContentSids[flowName] ||
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
      contentVariables: buildNativeFlowContentVariables({ flowName, profileName, phoneNumber })
    });
    await service.saveMessage({
      phoneNumber: to,
      direction: "assistant",
      body: `WhatsApp Flow launched: ${flowName}`,
      channel: "whatsapp"
    });
    if (sessionId) {
      const session = await service.getOnboardingSessionById(sessionId);
      await service.updateOnboardingSession({
        id: sessionId,
        currentStep: session?.current_step || "full_name",
        data: {
          ...(session?.data || {}),
          native_flow_name: flowName
        },
        selectedOption: flowName === "tenant_registration" ? "1" : "4",
        selectedUserType: flowName === "tenant_registration" ? "tenant" : "save_towards_rent",
        nativeFlowAttempted: true,
        nativeFlowContentSid: contentSid,
        fallbackChatActive: true
      });
    }
    console.log(`WhatsApp Flow launch requested for ${flowName}`);
  } catch (error) {
    console.error("Flow Launch Error:", error);
    if (sessionId) {
      try {
        const session = await service.getOnboardingSessionById(sessionId);
        const selectedUserType = flowName === "tenant_registration" ? "tenant" : "save_towards_rent";
        await service.updateOnboardingSession({
          id: sessionId,
          currentStep: session?.current_step || "full_name",
          data: {
            ...(session?.data || {}),
            flow_type: session?.data?.flow_type || selectedUserType,
            step: normalizeOnboardingStep(session?.data?.step || session?.current_step || "full_name"),
            native_flow_name: flowName,
            native_flow_error: error.message || String(error)
          },
          selectedOption: flowName === "tenant_registration" ? "1" : "4",
          selectedUserType,
          nativeFlowAttempted: true,
          nativeFlowContentSid: contentSid,
          fallbackChatActive: true
        });
      } catch (sessionError) {
        console.error("Flow Launch Session Error:", sessionError);
      }
    }
  }
}

function buildNativeFlowContentVariables({ flowName, profileName, phoneNumber }) {
  return {
    "1": profileName || "there",
    "2": JSON.stringify({
      flow_name: flowName,
      full_name: profileName || "WhatsApp User",
      phone_number: phoneNumber,
      mpesa_number: phoneNumber
    })
  };
}

function sendWhatsAppBodyInBackground({ to, body }) {
  setImmediate(async () => {
    try {
      await sendWhatsAppBody({ to, body });
      console.log("Outbound WhatsApp sent:", { to, body });
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
    await processWebRegistration({ flowName, payload, phoneNumber });
    const confirmation = webFormConfirmationMessage(flowName, payload);

    if (phoneNumber) {
      sendWhatsAppBodyInBackground({
        to: phoneNumber,
        body: confirmation
      });
    }

    sendText(res, 200, renderSuccessPage({
      message: confirmation,
      whatsappText: "I have registered on PayRent"
    }), "text/html; charset=utf-8");
    console.log(`${flowName} web form processed for:`, phoneNumber);
  } catch (error) {
    console.error("Web Form Error:", error);
    sendText(
      res,
      200,
      renderSuccessPage({
        title: "Almost there",
        message: [
          "We could not complete setup from this form yet.",
          "",
          `Reason: ${error.message || "Something went wrong while saving your details."}`,
          "",
          "Please check that your phone number, rent amount, and rent due day are filled correctly.",
          "",
          "Then try again, or return to WhatsApp and send: I need help registering."
        ].join("\n"),
        whatsappText: "I need help registering on PayRent"
      }),
      "text/html; charset=utf-8"
    );
  }
}

async function processWebRegistration({ flowName, payload, phoneNumber }) {
  assertRequired(payload.full_name, "Full name");
  assertRequired(phoneNumber, "Phone number");

  if (flowName === "tenant_registration") {
    const monthlyRentAmount = parseMoneyAmount(payload.monthly_rent_amount);
    const rentDueDay = parseDueDay(payload.rent_due_day);
    if (!monthlyRentAmount) throw new Error("Monthly rent amount is required.");
    if (!rentDueDay) throw new Error("Rent due day must be between 1 and 30.");

    return service.createTenantFromFlow({
      fullName: payload.full_name,
      phoneNumber,
      email: null,
      nationalIdNumber: payload.national_id_number || payload.id_number || null,
      hasInvitationCode: payload.has_invitation_code,
      invitationCode: payload.invitation_code || null,
      monthlyRentAmount,
      rentDueDay,
      signupChannel: "web"
    });
  }

  if (flowName === "save_towards_rent") {
    const monthlyRentAmount = parseMoneyAmount(payload.monthly_rent_amount);
    const rentDueDay = parseDueDay(payload.rent_due_day);
    if (!monthlyRentAmount) throw new Error("Monthly rent amount is required.");
    if (!rentDueDay) throw new Error("Rent due day must be between 1 and 30.");

    return service.createSaveTowardsRentGoal({
      fullName: payload.full_name,
      phoneNumber,
      nationalIdNumber: payload.national_id_number || payload.id_number || null,
      monthlyRentAmount,
      rentDueDay,
      savingsFrequency: normalizeSavingsFrequency(payload.savings_frequency) || "monthly",
      targetStartDate: payload.target_start_date || null,
      signupChannel: "web"
    });
  }

  if (flowName === "landlord_registration") {
    return service.createLandlordFromChat({
      ...payload,
      email: null,
      phone_number: phoneNumber,
      national_id_number: payload.national_id_number || payload.id_number || null
    });
  }

  if (flowName === "property_manager_registration") {
    return service.createPropertyManagerFromChat({
      ...payload,
      email: null,
      phone_number: phoneNumber,
      national_id_number: payload.national_id_number || payload.id_number || null
    });
  }

  throw new Error(`Unsupported web registration flow: ${flowName}`);
}

function assertRequired(value, label) {
  if (!String(value || "").trim()) {
    throw new Error(`${label} is required.`);
  }
}

function webFormConfirmationMessage(flowName, payload) {
  const name = payload.full_name || "there";
  if (flowName === "tenant_registration") {
    return [
      `Congratulations ${name} ❤️`,
      "",
      "Your PayRent tenant registration is complete.",
      "You can now track your rent goal, save towards rent, set your PIN, and ask PayRent AI for help.",
      "",
      "Reply MENU to continue."
    ].join("\n");
  }

  if (flowName === "save_towards_rent") {
    return [
      `Beautiful, ${name} ❤️`,
      "",
      "Your PayRent rent savings goal has been created.",
      "We’ll help you prepare for rent step by step.",
      "",
      "Reply MENU to continue."
    ].join("\n");
  }

  if (flowName === "landlord_registration") {
    return [
      `Congratulations ${name} ❤️`,
      "",
      "Your PayRent landlord profile has been created.",
      "You can now prepare to add properties, invite tenants, and track collections.",
      "",
      "Reply MENU to continue."
    ].join("\n");
  }

  if (flowName === "property_manager_registration") {
    return [
      `Congratulations ${name} ❤️`,
      "",
      "Your PayRent property manager profile has been created.",
      "You can now prepare to manage landlords, properties, tenants, and collections.",
      "",
      "Reply MENU to continue."
    ].join("\n");
  }

  return "Congratulations ❤️ Your PayRent registration is complete. Reply MENU to continue.";
}

async function renderRegistrationFormOrAlreadyRegistered({ phoneNumber, formHtml }) {
  if (!phoneNumber) return formHtml;

  const registeredUser = await getRegisteredUserForDecision(phoneNumber);
  if (!registeredUser) return formHtml;

  const name = registeredUser.full_name && registeredUser.full_name !== "Unknown"
    ? `, ${registeredUser.full_name}`
    : "";
  return renderSuccessPage({
    title: "Already registered",
    message: [
      `You are already registered on PayRent${name} ❤️`,
      "",
      "You do not need to fill this registration form again.",
      "",
      "Return to WhatsApp to continue managing your rent, savings, reminders, and PayRent account."
    ].join("\n"),
    whatsappText: "I have registered on PayRent"
  });
}

function renderTenantRegistrationForm({ phoneNumber, waId }) {
  return renderFormPage({
    title: "Tenant Registration",
    intro: "Create your PayRent tenant profile and rent goal.",
    action: "/forms/tenant-registration",
    hidden: { wa_id: waId },
    fields: [
      inputField("Full Name", "full_name", "text", "", true),
      lockedPhoneField(phoneNumber),
      inputField("Kenya ID Number", "national_id_number", "text", "", true),
      hiddenField("has_invitation_code", "no"),
      moneyField("Monthly Rent Amount", "monthly_rent_amount"),
      dueDayField("Rent Due Day", "rent_due_day")
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
      lockedPhoneField(phoneNumber),
      inputField("Kenya ID Number", "national_id_number", "text", "", true),
      moneyField("Monthly Rent Amount", "monthly_rent_amount"),
      dueDayField("Rent Due Day", "rent_due_day"),
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

function renderLandlordRegistrationForm({ phoneNumber, waId }) {
  return renderFormPage({
    title: "Landlord Registration",
    intro: "Create your PayRent landlord profile and first property record.",
    action: "/forms/landlord-registration",
    hidden: { wa_id: waId },
    fields: [
      inputField("Full Name", "full_name", "text", "", true),
      lockedPhoneField(phoneNumber),
      inputField("Kenya ID Number", "national_id_number", "text", "", true),
      selectField("Landlord Type", "landlord_type", [
        ["individual_landlord", "Individual Landlord"],
        ["company", "Company"],
        ["property_owner", "Property Owner"]
      ]),
      inputField("Company Name", "company_name", "text", "", false),
      inputField("Property Name", "property_name", "text", "", true),
      inputField("County", "county", "text", "", true),
      numberField("Number of Units", "units_count", "", false),
      selectField("Current Rent Collection Method", "payment_method", [
        ["mpesa", "M-PESA"],
        ["bank", "Bank"],
        ["cash", "Cash"]
      ])
    ],
    submitLabel: "Create landlord profile"
  });
}

function renderPropertyManagerRegistrationForm({ phoneNumber, waId }) {
  return renderFormPage({
    title: "Property Manager Registration",
    intro: "Create your PayRent property manager profile.",
    action: "/forms/property-manager-registration",
    hidden: { wa_id: waId },
    fields: [
      inputField("Full Name", "full_name", "text", "", true),
      lockedPhoneField(phoneNumber),
      inputField("Kenya ID Number", "national_id_number", "text", "", true),
      inputField("Company Name", "company_name", "text", "", true),
      numberField("Number of Properties Managed", "properties_count", "", false),
      inputField("Main County", "county", "text", "", true)
    ],
    submitLabel: "Create property manager profile"
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

function renderSuccessPage({ title = "Done ❤️", message, whatsappText = "I have registered on PayRent" }) {
  const whatsappUrl = buildReturnToWhatsAppUrl({
    text: whatsappText
  });
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
    a.button {
      display: block;
      margin-top: 22px;
      border-radius: 8px;
      padding: 14px 16px;
      background: #0f7b62;
      color: white;
      font-weight: 800;
      text-align: center;
      text-decoration: none;
    }
    .hint {
      margin-top: 12px;
      font-size: 13px;
      color: #5f6368;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a class="button" href="${escapeHtml(whatsappUrl)}">Return to WhatsApp</a>
    <p class="hint">Tap the button to return to PayRent on WhatsApp and continue.</p>
  </main>
</body>
</html>`;
}

function buildReturnToWhatsAppUrl({ text }) {
  const digits = normalizeWhatsAppPhone(config.twilioWhatsAppFrom || "").replace(/[^\d]/g, "");
  const encodedText = encodeURIComponent(text);
  if (!digits) return `https://wa.me/?text=${encodedText}`;
  return `https://wa.me/${digits}?text=${encodedText}`;
}

function inputField(label, name, type, value, required) {
  return `<label>${escapeHtml(label)}
    <input type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${required ? "required" : ""}>
  </label>`;
}

function hiddenField(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function lockedPhoneField(value) {
  return `<label>Phone Number
    <input type="tel" name="phone_number" value="${escapeHtml(value)}" readonly aria-readonly="true" required>
  </label>`;
}

function moneyField(label, name) {
  return `<label>${escapeHtml(label)}
    <input type="number" name="${escapeHtml(name)}" inputmode="decimal" min="1" step="1" required>
  </label>`;
}

function dueDayField(label, name) {
  return `<label>${escapeHtml(label)}
    <input type="number" name="${escapeHtml(name)}" inputmode="numeric" min="1" max="30" step="1" required>
  </label>`;
}

function numberField(label, name, value = "", required = false) {
  return `<label>${escapeHtml(label)}
    <input type="number" name="${escapeHtml(name)}" value="${escapeHtml(value)}" inputmode="numeric" min="0" step="1" ${required ? "required" : ""}>
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

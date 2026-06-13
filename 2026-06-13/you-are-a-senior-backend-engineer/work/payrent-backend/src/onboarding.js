const START_WORDS = new Set(["hi", "hello", "start", "menu"]);

function eq(value) {
  return `eq.${encodeURIComponent(value)}`;
}

export class OnboardingEngine {
  constructor(db, service) {
    this.db = db;
    this.service = service;
  }

  async handleWhatsAppMessage({ phoneNumber, body }) {
    const text = String(body || "").trim();
    const lower = text.toLowerCase();

    await this.service.saveMessage({ phoneNumber, direction: "user", body: text });

    let reply;

    if (lower === "cancel") {
      await this.cancelActiveSession(phoneNumber);
      reply = "Registration cancelled. Send Hi when you want to start again.";
      await this.service.saveMessage({ phoneNumber, direction: "assistant", body: reply });
      return reply;
    }

    let session = await this.getActiveSession(phoneNumber);

    if (!session) {
      if (lower.includes("join")) {
        session = await this.createSession(phoneNumber, "tenant_invitation", "ask_invitation_code");
        reply = "Welcome to PayRent. Please enter your invitation code.";
      } else if (START_WORDS.has(lower)) {
        session = await this.createSession(phoneNumber, "independent_tenant", "ask_full_name");
        reply = "Welcome to PayRent. Please enter your full name.";
      } else {
        reply = "Welcome to PayRent. Reply Hi to register as an independent tenant, or Join Property if you have an invitation code.";
      }

      await this.service.saveMessage({ phoneNumber, direction: "assistant", body: reply });
      return reply;
    }

    reply = await this.advanceSession(session, text);
    await this.service.saveMessage({ phoneNumber, direction: "assistant", body: reply });
    return reply;
  }

  async advanceSession(session, text) {
    if (session.flow === "tenant_invitation") {
      return this.advanceInvitationSession(session, text);
    }

    return this.advanceIndependentTenantSession(session, text);
  }

  async advanceIndependentTenantSession(session, text) {
    const data = session.data || {};

    if (session.current_step === "ask_full_name") {
      if (text.length < 2) return "Please enter your full name.";
      await this.updateSession(session.id, "ask_national_id_number", { ...data, fullName: text });
      return "Please enter your Kenyan ID number.";
    }

    if (session.current_step === "ask_national_id_number") {
      if (!/^\d{6,12}$/.test(text)) return "Please enter a valid Kenyan ID number using digits only.";
      await this.updateSession(session.id, "ask_monthly_rent_amount", { ...data, nationalIdNumber: text });
      return "How much is your monthly rent? Example: 15000";
    }

    if (session.current_step === "ask_monthly_rent_amount") {
      const amount = parseMoney(text);
      if (!amount) return "Please enter your rent amount as a number. Example: 15000";
      await this.updateSession(session.id, "ask_rent_due_day", { ...data, monthlyRentAmount: amount });
      return "Which day of the month is rent due? Example: 5";
    }

    if (session.current_step === "ask_rent_due_day") {
      const day = Number.parseInt(text, 10);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        return "Please enter a due day between 1 and 31.";
      }

      const completedData = { ...data, rentDueDay: day };
      await this.service.createIndependentTenant({
        fullName: completedData.fullName,
        phoneNumber: session.phone_number,
        nationalIdNumber: completedData.nationalIdNumber,
        monthlyRentAmount: completedData.monthlyRentAmount,
        rentDueDay: completedData.rentDueDay
      });

      await this.completeSession(session.id, completedData);
      return `You are registered. Your rent goal is KES ${formatKes(completedData.monthlyRentAmount)} due on day ${day} of every month.`;
    }

    return "Please reply Hi to start registration again.";
  }

  async advanceInvitationSession(session, text) {
    const data = session.data || {};

    if (session.current_step === "ask_invitation_code") {
      await this.updateSession(session.id, "ask_full_name", { ...data, code: text.toUpperCase() });
      return "Code received. Please enter your full name.";
    }

    if (session.current_step === "ask_full_name") {
      if (text.length < 2) return "Please enter your full name.";
      await this.updateSession(session.id, "ask_national_id_number", { ...data, fullName: text });
      return "Please enter your Kenyan ID number.";
    }

    if (session.current_step === "ask_national_id_number") {
      if (!/^\d{6,12}$/.test(text)) return "Please enter a valid Kenyan ID number using digits only.";

      const completedData = { ...data, nationalIdNumber: text };
      const result = await this.service.acceptTenantInvitation({
        code: completedData.code,
        fullName: completedData.fullName,
        phoneNumber: session.phone_number,
        nationalIdNumber: completedData.nationalIdNumber
      });

      await this.completeSession(session.id, completedData);
      return `You are registered and linked to your property. Your tenant assignment is active. Ref: ${result.assignment.id}`;
    }

    return "Please reply Join Property to start again.";
  }

  async getActiveSession(phoneNumber) {
    return this.db.select("onboarding_sessions", {
      query: `?phone_number=${eq(phoneNumber)}&status=eq.active&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*&order=created_at.desc&limit=1`,
      single: true
    });
  }

  async createSession(phoneNumber, flow, currentStep) {
    return this.db.insert("onboarding_sessions", {
      phone_number: phoneNumber,
      flow,
      current_step: currentStep
    });
  }

  async updateSession(id, currentStep, data) {
    return this.db.update("onboarding_sessions", {
      current_step: currentStep,
      data,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    }, `?id=${eq(id)}`);
  }

  async completeSession(id, data) {
    return this.db.update("onboarding_sessions", {
      status: "completed",
      data
    }, `?id=${eq(id)}`);
  }

  async cancelActiveSession(phoneNumber) {
    return this.db.update("onboarding_sessions", {
      status: "cancelled"
    }, `?phone_number=${eq(phoneNumber)}&status=eq.active`);
  }
}

function parseMoney(value) {
  const normalized = String(value).replace(/[^\d.]/g, "");
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function formatKes(value) {
  return Number(value).toLocaleString("en-KE", {
    maximumFractionDigits: 0
  });
}

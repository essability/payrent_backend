const FLOW_NAMES = new Set([
  "tenant_registration",
  "landlord_registration",
  "property_manager_registration",
  "property_creation",
  "unit_creation",
  "tenant_invitation",
  "set_transaction_pin",
  "savings_deposit",
  "rent_goal_update",
  "rent_payment",
  "rent_balance_check",
  "payment_history",
  "tenant_statement_request",
  "maintenance_issue"
]);

export class FlowProcessor {
  constructor(service) {
    this.service = service;
  }

  async process({ flowName, source = "whatsapp", phoneNumber, payload }) {
    const normalizedFlowName = String(flowName || payload?.flow_name || "").trim();
    if (!FLOW_NAMES.has(normalizedFlowName)) {
      throw new Error(`Unsupported flow_name: ${normalizedFlowName || "missing"}`);
    }

    const normalizedPayload = normalizePayload(payload);
    const submission = await this.service.createFlowSubmission({
      flowName: normalizedFlowName,
      source,
      phoneNumber: phoneNumber || normalizedPayload.phone_number || normalizedPayload.tenant_phone_number || normalizedPayload.owner_phone_number,
      payload: normalizedPayload
    });

    try {
      const result = await this.dispatch(normalizedFlowName, normalizedPayload);
      await this.service.markFlowSubmissionProcessed(submission.id, serializeResult(result));
      return { submissionId: submission.id, flowName: normalizedFlowName, result };
    } catch (error) {
      await this.service.markFlowSubmissionFailed(submission.id, error);
      throw error;
    }
  }

  async dispatch(flowName, payload) {
    if (flowName === "tenant_registration") {
      return this.service.createIndependentTenant({
        fullName: required(payload.full_name, "full_name"),
        phoneNumber: required(payload.phone_number, "phone_number"),
        nationalIdNumber: required(payload.national_id_number, "national_id_number"),
        monthlyRentAmount: positiveNumber(payload.monthly_rent_amount, "monthly_rent_amount"),
        rentDueDay: dueDay(payload.rent_due_day),
        signupChannel: "whatsapp"
      });
    }

    if (flowName === "landlord_registration") {
      return this.service.createLandlord({
        fullName: required(payload.full_name, "full_name"),
        phoneNumber: required(payload.phone_number, "phone_number"),
        email: required(payload.email, "email"),
        nationalIdNumber: required(payload.national_id_number, "national_id_number"),
        landlordType: payload.landlord_type || "individual_landlord",
        companyName: payload.company_name || null,
        signupChannel: "whatsapp"
      });
    }

    if (flowName === "property_manager_registration") {
      return this.service.createPropertyManager({
        fullName: required(payload.full_name, "full_name"),
        phoneNumber: required(payload.phone_number, "phone_number"),
        email: required(payload.email, "email"),
        nationalIdNumber: required(payload.national_id_number, "national_id_number"),
        companyName: required(payload.company_name, "company_name"),
        signupChannel: "whatsapp"
      });
    }

    if (flowName === "property_creation") {
      return this.service.createPropertyWithFirstUnit({
        ownerPhoneNumber: required(payload.owner_phone_number, "owner_phone_number"),
        propertyName: required(payload.property_name, "property_name"),
        address: payload.address || null,
        city: required(payload.city, "city"),
        county: required(payload.county, "county"),
        unitNumber: required(payload.unit_number, "unit_number"),
        monthlyRentAmount: positiveNumber(payload.monthly_rent_amount, "monthly_rent_amount"),
        rentDueDay: dueDay(payload.rent_due_day)
      });
    }

    if (flowName === "unit_creation") {
      return this.service.createUnit({
        ownerPhoneNumber: required(payload.owner_phone_number, "owner_phone_number"),
        propertyId: required(payload.property_id, "property_id"),
        unitNumber: required(payload.unit_number, "unit_number"),
        monthlyRentAmount: positiveNumber(payload.monthly_rent_amount, "monthly_rent_amount"),
        rentDueDay: dueDay(payload.rent_due_day)
      });
    }

    if (flowName === "tenant_invitation") {
      return this.service.inviteTenant({
        ownerPhoneNumber: required(payload.owner_phone_number, "owner_phone_number"),
        propertyId: required(payload.property_id, "property_id"),
        unitId: required(payload.unit_id, "unit_id"),
        tenantPhoneNumber: required(payload.tenant_phone_number, "tenant_phone_number"),
        code: payload.invitation_code || null,
        expiresInDays: payload.expires_in_days || 7
      });
    }

    if (flowName === "set_transaction_pin") {
      const pin = required(payload.pin, "pin");
      const confirmPin = required(payload.confirm_pin, "confirm_pin");
      if (pin !== confirmPin) throw new Error("PIN and confirmation PIN do not match.");
      return this.service.setTransactionPin({
        phoneNumber: required(payload.phone_number, "phone_number"),
        pin
      });
    }

    if (flowName === "savings_deposit") {
      return this.service.recordSavingsDeposit({
        tenantPhoneNumber: required(payload.tenant_phone_number, "tenant_phone_number"),
        amount: positiveNumber(payload.amount, "amount"),
        method: payload.method || "mpesa",
        providerReference: payload.provider_reference || null,
        transactionPin: required(payload.transaction_pin, "transaction_pin"),
        metadata: {
          source: "whatsapp_flow",
          flow_payload: payload
        }
      });
    }

    if (flowName === "rent_goal_update") {
      return this.service.updateRentGoal({
        tenantPhoneNumber: required(payload.tenant_phone_number, "tenant_phone_number"),
        monthlyRentAmount: positiveNumber(payload.monthly_rent_amount, "monthly_rent_amount"),
        rentDueDay: dueDay(payload.rent_due_day),
        transactionPin: required(payload.transaction_pin, "transaction_pin")
      });
    }

    if (flowName === "rent_payment") {
      return this.service.recordRentPayment({
        tenantPhoneNumber: required(payload.tenant_phone_number, "tenant_phone_number"),
        amount: positiveNumber(payload.amount, "amount"),
        method: payload.method || "mpesa",
        providerReference: payload.provider_reference || null,
        invoiceNumber: payload.invoice_number || null,
        transactionPin: required(payload.transaction_pin, "transaction_pin"),
        metadata: {
          source: "whatsapp_flow",
          flow_payload: payload
        }
      });
    }

    if (flowName === "rent_balance_check") {
      return this.service.getRentBalance({
        tenantPhoneNumber: required(payload.tenant_phone_number, "tenant_phone_number")
      });
    }

    if (flowName === "payment_history") {
      return this.service.getPaymentHistory({
        tenantPhoneNumber: required(payload.tenant_phone_number, "tenant_phone_number"),
        limit: payload.limit || 10
      });
    }

    if (flowName === "tenant_statement_request") {
      return this.service.requestTenantStatement({
        tenantPhoneNumber: required(payload.tenant_phone_number, "tenant_phone_number"),
        periodStart: payload.period_start || null,
        periodEnd: payload.period_end || null
      });
    }

    if (flowName === "maintenance_issue") {
      return this.service.reportMaintenanceIssue({
        tenantPhoneNumber: required(payload.tenant_phone_number, "tenant_phone_number"),
        propertyId: payload.property_id || null,
        unitId: payload.unit_id || null,
        title: required(payload.title, "title"),
        description: required(payload.description, "description"),
        priority: payload.priority || "normal"
      });
    }

    throw new Error(`Unsupported flow_name: ${flowName}`);
  }
}

export function extractTwilioFlowPayload(form) {
  const raw =
    form.FlowData ||
    form.FlowResponse ||
    form.FlowResponseData ||
    form.Body ||
    "{}";

  let parsed = {};
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = Object.fromEntries(new URLSearchParams(raw));
    }
  } else {
    parsed = raw || {};
  }

  const flowName =
    parsed.flow_name ||
    parsed.flowName ||
    form.FlowName ||
    form.flow_name ||
    parsed.screen ||
    parsed.name;

  return {
    flowName,
    payload: parsed
  };
}

function normalizePayload(payload) {
  const raw = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const normalized = {};

  for (const [key, value] of Object.entries(raw || {})) {
    normalized[toSnakeCase(key)] = typeof value === "string" ? value.trim() : value;
  }

  return normalized;
}

function toSnakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function required(value, field) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`Missing required field: ${field}`);
  }
  return String(value).trim();
}

function positiveNumber(value, field) {
  const amount = Number(String(value).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid amount for field: ${field}`);
  }
  return amount;
}

function dueDay(value) {
  const day = Number.parseInt(value, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error("rent_due_day must be between 1 and 31");
  }
  return day;
}

function serializeResult(result) {
  return JSON.parse(JSON.stringify(result));
}

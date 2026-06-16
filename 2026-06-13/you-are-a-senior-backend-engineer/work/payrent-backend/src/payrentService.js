import crypto from "node:crypto";

function eq(value) {
  return `eq.${encodeURIComponent(value)}`;
}

export class PayRentService {
  constructor(db) {
    this.db = db;
  }

  async getRole(name) {
    const role = await this.db.select("roles", {
      query: `?name=${eq(name)}&select=id,name`,
      single: true
    });

    if (!role) throw new Error(`Missing role: ${name}`);
    return role;
  }

  async findUserByPhone(phoneNumber, { required = true } = {}) {
    const user = await this.db.select("users", {
      query: `?phone_number=${eq(phoneNumber)}&select=*`,
      single: true
    });

    if (!user && required) throw new Error(`User not found for phone number: ${phoneNumber}`);
    return user;
  }

  async upsertUser({ fullName, phoneNumber, email, nationalIdNumber, signupChannel }) {
    return this.db.insert("users", {
      full_name: fullName,
      phone_number: phoneNumber,
      national_id_number: nationalIdNumber || null,
      signup_channel: signupChannel
    }, {
      onConflict: "phone_number",
      mergeDuplicates: true
    });
  }

  async assignRole(userId, roleName) {
    const role = await this.getRole(roleName);
    return this.db.insert("user_roles", {
      user_id: userId,
      role_id: role.id
    }, {
      onConflict: "user_id,role_id",
      mergeDuplicates: true
    });
  }

  async ensureTenantProfile(userId) {
    return this.db.insert("tenant_profiles", {
      user_id: userId,
      preferred_payment_method: "mpesa"
    }, {
      onConflict: "user_id",
      mergeDuplicates: true
    });
  }

  async createIndependentTenant({ fullName, phoneNumber, nationalIdNumber, monthlyRentAmount, rentDueDay, signupChannel = "whatsapp" }) {
    const user = await this.upsertUser({
      fullName,
      phoneNumber,
      nationalIdNumber,
      signupChannel
    });

    await this.assignRole(user.id, "tenant");
    await this.ensureTenantProfile(user.id);

    const targetMonth = new Date();
    targetMonth.setUTCDate(1);

    const rentGoal = await this.db.insert("rent_goals", {
      tenant_user_id: user.id,
      monthly_rent_amount: monthlyRentAmount,
      rent_due_day: rentDueDay,
      target_month: targetMonth.toISOString().slice(0, 10),
      amount_saved: 0
    });

    return { user, rentGoal };
  }

  async createTenantFromFlow({
    fullName,
    phoneNumber,
    email,
    nationalIdNumber,
    hasInvitationCode,
    invitationCode,
    monthlyRentAmount,
    rentDueDay,
    signupChannel = "whatsapp"
  }) {
    const user = await this.upsertUser({
      fullName,
      phoneNumber,
      email,
      nationalIdNumber,
      signupChannel
    });

    await this.assignRole(user.id, "tenant");
    await this.ensureTenantProfile(user.id);

    const shouldUseInvitation = isYes(hasInvitationCode) && invitationCode;
    if (shouldUseInvitation) {
      try {
        const invitationResult = await this.acceptTenantInvitation({
          code: invitationCode,
          fullName,
          phoneNumber,
          nationalIdNumber,
          signupChannel
        });

        return {
          user,
          linkedByInvitation: true,
          invitation: invitationResult.invitation,
          assignment: invitationResult.assignment
        };
      } catch (error) {
        return {
          user,
          linkedByInvitation: false,
          invitationError: error.message,
          rentGoal: await this.createRentGoalForUser({
            userId: user.id,
            monthlyRentAmount,
            rentDueDay,
            metadata: {
              source: "tenant_registration_flow",
              invitation_code_attempted: invitationCode,
              invitation_error: error.message
            }
          })
        };
      }
    }

    const rentGoal = await this.createRentGoalForUser({
      userId: user.id,
      monthlyRentAmount,
      rentDueDay,
      metadata: {
        source: "tenant_registration_flow"
      }
    });

    return { user, linkedByInvitation: false, rentGoal };
  }

  async createSaveTowardsRentGoal({
    fullName,
    phoneNumber,
    nationalIdNumber,
    monthlyRentAmount,
    rentDueDay,
    savingsFrequency,
    targetStartDate,
    signupChannel = "whatsapp"
  }) {
    const user = await this.upsertUser({
      fullName,
      phoneNumber,
      email: null,
      nationalIdNumber,
      signupChannel
    });

    await this.assignRole(user.id, "tenant");
    await this.ensureTenantProfile(user.id);

    const rentGoal = await this.createRentGoalForUser({
      userId: user.id,
      monthlyRentAmount,
      rentDueDay,
      savingsFrequency,
      targetStartDate,
      metadata: {
        source: "save_towards_rent_flow"
      }
    });

    let savingsPreference = null;
    try {
      savingsPreference = await this.db.insert("savings_preferences", {
        user_id: user.id,
        rent_goal_id: rentGoal.id,
        frequency: savingsFrequency,
        target_start_date: targetStartDate || null,
        channel: "whatsapp",
        is_active: true
      });
    } catch (error) {
      console.error("Savings preference insert failed; rent goal was still created:", error);
    }

    return { user, rentGoal, savingsPreference };
  }

  async createRentGoalForUser({ userId, monthlyRentAmount, rentDueDay, savingsFrequency, targetStartDate, metadata = {} }) {
    const targetMonth = new Date();
    targetMonth.setUTCDate(1);

    const fullPayload = {
      tenant_user_id: userId,
      monthly_rent_amount: monthlyRentAmount,
      rent_due_day: rentDueDay,
      target_month: targetMonth.toISOString().slice(0, 10),
      amount_saved: 0,
      savings_frequency: savingsFrequency || null,
      target_start_date: targetStartDate || null,
      metadata
    };

    try {
      return await this.db.insert("rent_goals", fullPayload);
    } catch (error) {
      console.error("Full rent goal insert failed; retrying with core columns only:", error);
      return this.db.insert("rent_goals", {
        tenant_user_id: userId,
        monthly_rent_amount: monthlyRentAmount,
        rent_due_day: rentDueDay,
        target_month: targetMonth.toISOString().slice(0, 10),
        amount_saved: 0
      });
    }
  }

  async createLandlord({ fullName, phoneNumber, email, nationalIdNumber, landlordType, companyName, signupChannel = "web" }) {
    const user = await this.upsertUser({
      fullName,
      phoneNumber,
      email,
      nationalIdNumber,
      signupChannel
    });

    await this.assignRole(user.id, "landlord");

    const profile = await this.db.insert("landlord_profiles", {
      user_id: user.id,
      landlord_type: landlordType,
      company_name: companyName || null
    }, {
      onConflict: "user_id",
      mergeDuplicates: true
    });

    return { user, profile };
  }

  async createLandlordFromChat(payload) {
    const result = await this.createLandlord({
      fullName: payload.full_name,
      phoneNumber: payload.phone_number,
      email: payload.email || null,
      nationalIdNumber: payload.national_id_number || payload.id_number || null,
      landlordType: payload.landlord_type || "individual_landlord",
      companyName: payload.company_name || null,
      signupChannel: "whatsapp"
    });

    let property = null;
    if (payload.property_name) {
      try {
        property = await this.db.insert("properties", {
          landlord_user_id: result.user.id,
          property_manager_user_id: null,
          name: payload.property_name,
          address: null,
          city: payload.county || "Unknown",
          county: payload.county || "Unknown",
          country: "Kenya"
        });
      } catch (error) {
        console.error("Landlord property insert failed; profile was still created:", error);
      }
    }

    let submission = null;
    try {
      submission = await this.db.insert("flow_submissions", {
        flow_name: "landlord_registration",
        source: "whatsapp_chat_fallback",
        phone_number: payload.phone_number,
        user_id: result.user.id,
        payload,
        result: {
          user_id: result.user.id,
          profile_id: result.profile.id,
          property_id: property?.id || null
        },
        status: "processed",
        submission_summary: {
          full_name: payload.full_name,
          property_name: payload.property_name || null,
          county: payload.county || null,
          units_count: payload.units_count || null,
          payment_method: payload.payment_method || null
        }
      });
    } catch (error) {
      console.error("Landlord flow submission logging failed; profile was still created:", error);
    }

    return { ...result, property, submission };
  }

  async createPropertyManager({ fullName, phoneNumber, email, nationalIdNumber, companyName, signupChannel = "web" }) {
    const user = await this.upsertUser({
      fullName,
      phoneNumber,
      email,
      nationalIdNumber,
      signupChannel
    });

    await this.assignRole(user.id, "property_manager");

    const profile = await this.db.insert("property_manager_profiles", {
      user_id: user.id,
      company_name: companyName
    }, {
      onConflict: "user_id",
      mergeDuplicates: true
    });

    return { user, profile };
  }

  async createPropertyManagerFromChat(payload) {
    const result = await this.createPropertyManager({
      fullName: payload.full_name,
      phoneNumber: payload.phone_number,
      email: payload.email || null,
      nationalIdNumber: payload.national_id_number || payload.id_number || null,
      companyName: payload.company_name || "Independent Property Manager",
      signupChannel: "whatsapp"
    });

    let submission = null;
    try {
      submission = await this.db.insert("flow_submissions", {
        flow_name: "property_manager_registration",
        source: "whatsapp_chat_fallback",
        phone_number: payload.phone_number,
        user_id: result.user.id,
        payload,
        result: {
          user_id: result.user.id,
          profile_id: result.profile.id
        },
        status: "processed",
        submission_summary: {
          full_name: payload.full_name,
          company_name: payload.company_name || null,
          properties_count: payload.properties_count || null,
          county: payload.county || null
        }
      });
    } catch (error) {
      console.error("Property manager flow submission logging failed; profile was still created:", error);
    }

    return { ...result, submission };
  }

  async createPropertyWithFirstUnit({
    ownerPhoneNumber,
    propertyName,
    address,
    city,
    county,
    unitNumber,
    monthlyRentAmount,
    rentDueDay
  }) {
    const owner = await this.db.select("users", {
      query: `?phone_number=${eq(ownerPhoneNumber)}&select=id,phone_number`,
      single: true
    });

    if (!owner) {
      throw new Error("Owner phone number was not found. Register the landlord or property manager first.");
    }

    const roles = await this.db.select("user_roles", {
      query: `?user_id=${eq(owner.id)}&select=roles(name)`
    });

    const roleNames = roles.map((row) => row.roles?.name).filter(Boolean);
    const isPropertyManager = roleNames.includes("property_manager");

    const property = await this.db.insert("properties", {
      landlord_user_id: isPropertyManager ? null : owner.id,
      property_manager_user_id: isPropertyManager ? owner.id : null,
      name: propertyName,
      address: address || null,
      city,
      county,
      country: "Kenya"
    });

    const unit = await this.db.insert("units", {
      property_id: property.id,
      unit_number: unitNumber,
      monthly_rent_amount: monthlyRentAmount,
      rent_due_day: rentDueDay
    });

    return { property, unit };
  }

  async createUnit({ ownerPhoneNumber, propertyId, unitNumber, monthlyRentAmount, rentDueDay }) {
    const owner = await this.findUserByPhone(ownerPhoneNumber);
    const property = await this.db.select("properties", {
      query: `?id=${eq(propertyId)}&select=*`,
      single: true
    });

    if (!property) throw new Error("Property was not found.");
    if (property.landlord_user_id !== owner.id && property.property_manager_user_id !== owner.id) {
      throw new Error("Owner phone number is not allowed to add units to this property.");
    }

    const unit = await this.db.insert("units", {
      property_id: propertyId,
      unit_number: unitNumber,
      monthly_rent_amount: monthlyRentAmount,
      rent_due_day: rentDueDay
    });

    return { property, unit };
  }

  async inviteTenant({ ownerPhoneNumber, propertyId, unitId, tenantPhoneNumber, code, expiresInDays = 7 }) {
    const owner = await this.findUserByPhone(ownerPhoneNumber);
    const property = await this.db.select("properties", {
      query: `?id=${eq(propertyId)}&select=*`,
      single: true
    });

    if (!property) throw new Error("Property was not found.");
    if (property.landlord_user_id !== owner.id && property.property_manager_user_id !== owner.id) {
      throw new Error("Owner phone number is not allowed to invite tenants to this property.");
    }

    const unit = await this.db.select("units", {
      query: `?id=${eq(unitId)}&property_id=${eq(propertyId)}&select=*`,
      single: true
    });
    if (!unit) throw new Error("Unit was not found for this property.");

    const invitationCode = code || generateInvitationCode(unit.unit_number);
    const expiresAt = new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000).toISOString();

    const invitation = await this.db.insert("invitations", {
      code: invitationCode,
      invited_phone_number: tenantPhoneNumber,
      invited_by_user_id: owner.id,
      property_id: propertyId,
      unit_id: unitId,
      role_name: "tenant",
      expires_at: expiresAt
    });

    return { invitation, property, unit };
  }

  async setTransactionPin({ phoneNumber, pin }) {
    const user = await this.findUserByPhone(phoneNumber);
    validatePin(pin);

    const salt = crypto.randomBytes(16).toString("hex");
    const pinHash = hashPin(pin, salt);

    const securityPin = await this.db.insert("user_transaction_pins", {
      user_id: user.id,
      pin_hash: pinHash,
      pin_salt: salt,
      failed_attempts: 0,
      locked_until: null
    }, {
      onConflict: "user_id",
      mergeDuplicates: true
    });

    return { user, securityPin: { id: securityPin.id, user_id: securityPin.user_id } };
  }

  async verifyTransactionPin({ phoneNumber, pin }) {
    const user = await this.findUserByPhone(phoneNumber);
    const securityPin = await this.db.select("user_transaction_pins", {
      query: `?user_id=${eq(user.id)}&select=*`,
      single: true
    });

    if (!securityPin) throw new Error("Transaction PIN is not set.");
    if (securityPin.locked_until && new Date(securityPin.locked_until).getTime() > Date.now()) {
      throw new Error("Transaction PIN is temporarily locked. Try again later.");
    }

    const isValid = crypto.timingSafeEqual(
      Buffer.from(hashPin(pin, securityPin.pin_salt)),
      Buffer.from(securityPin.pin_hash)
    );

    if (!isValid) {
      const failedAttempts = Number(securityPin.failed_attempts || 0) + 1;
      await this.db.update("user_transaction_pins", {
        failed_attempts: failedAttempts,
        locked_until: failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null
      }, `?id=${eq(securityPin.id)}`);
      throw new Error("Invalid transaction PIN.");
    }

    await this.db.update("user_transaction_pins", {
      failed_attempts: 0,
      locked_until: null
    }, `?id=${eq(securityPin.id)}`);

    return user;
  }

  async recordSavingsDeposit({ tenantPhoneNumber, amount, method, providerReference, transactionPin, metadata = {} }) {
    const tenant = await this.verifyTransactionPin({ phoneNumber: tenantPhoneNumber, pin: transactionPin });
    const activeGoal = await this.db.select("rent_goals", {
      query: `?tenant_user_id=${eq(tenant.id)}&is_active=eq.true&select=*&order=created_at.desc&limit=1`,
      single: true
    });

    if (!activeGoal) throw new Error("No active rent goal found for this tenant.");

    const payment = await this.db.insert("payments", {
      tenant_user_id: tenant.id,
      rent_goal_id: activeGoal.id,
      amount,
      currency: "KES",
      method: method || "mpesa",
      status: "successful",
      provider_reference: providerReference || null,
      paid_at: new Date().toISOString(),
      metadata: { ...metadata, payment_type: "rent_savings" }
    });

    const rentGoal = await this.db.update("rent_goals", {
      amount_saved: Number(activeGoal.amount_saved || 0) + Number(amount)
    }, `?id=${eq(activeGoal.id)}`);

    return { tenant, payment, rentGoal };
  }

  async updateRentGoal({ tenantPhoneNumber, monthlyRentAmount, rentDueDay, transactionPin }) {
    const tenant = await this.verifyTransactionPin({ phoneNumber: tenantPhoneNumber, pin: transactionPin });
    const activeGoal = await this.db.select("rent_goals", {
      query: `?tenant_user_id=${eq(tenant.id)}&is_active=eq.true&select=*&order=created_at.desc&limit=1`,
      single: true
    });

    if (!activeGoal) throw new Error("No active rent goal found for this tenant.");

    const rentGoal = await this.db.update("rent_goals", {
      monthly_rent_amount: monthlyRentAmount,
      rent_due_day: rentDueDay
    }, `?id=${eq(activeGoal.id)}`);

    return { tenant, rentGoal };
  }

  async recordRentPayment({ tenantPhoneNumber, amount, method, providerReference, invoiceNumber, transactionPin, metadata = {} }) {
    const tenant = transactionPin
      ? await this.verifyTransactionPin({ phoneNumber: tenantPhoneNumber, pin: transactionPin })
      : await this.findUserByPhone(tenantPhoneNumber);

    let invoice = null;
    if (invoiceNumber) {
      invoice = await this.db.select("invoices", {
        query: `?invoice_number=${eq(invoiceNumber)}&select=*`,
        single: true
      });
      if (!invoice) throw new Error("Invoice number was not found.");
    }

    const activeGoal = await this.db.select("rent_goals", {
      query: `?tenant_user_id=${eq(tenant.id)}&is_active=eq.true&select=*&order=created_at.desc&limit=1`,
      single: true
    });

    const payment = await this.db.insert("payments", {
      tenant_user_id: tenant.id,
      invoice_id: invoice?.id || null,
      rent_goal_id: activeGoal?.id || null,
      amount,
      currency: "KES",
      method: method || "mpesa",
      status: "successful",
      provider_reference: providerReference || null,
      paid_at: new Date().toISOString(),
      metadata
    });

    if (activeGoal) {
      await this.db.update("rent_goals", {
        amount_saved: Number(activeGoal.amount_saved || 0) + Number(amount)
      }, `?id=${eq(activeGoal.id)}`);
    }

    if (invoice) {
      const amountPaid = Number(invoice.amount_paid || 0) + Number(amount);
      const amountDue = Number(invoice.amount_due || 0);
      await this.db.update("invoices", {
        amount_paid: amountPaid,
        status: amountPaid >= amountDue ? "paid" : "partially_paid",
        paid_at: amountPaid >= amountDue ? new Date().toISOString() : invoice.paid_at
      }, `?id=${eq(invoice.id)}`);
    }

    return { tenant, payment, invoice, rentGoal: activeGoal };
  }

  async getRentBalance({ tenantPhoneNumber }) {
    const tenant = await this.findUserByPhone(tenantPhoneNumber);
    const activeGoal = await this.db.select("rent_goals", {
      query: `?tenant_user_id=${eq(tenant.id)}&is_active=eq.true&select=*&order=created_at.desc&limit=1`,
      single: true
    });
    const latestInvoice = await this.db.select("invoices", {
      query: `?tenant_user_id=${eq(tenant.id)}&status=in.(issued,partially_paid,overdue)&select=*&order=due_date.asc&limit=1`,
      single: true
    });

    const goalBalance = activeGoal
      ? Math.max(Number(activeGoal.monthly_rent_amount || 0) - Number(activeGoal.amount_saved || 0), 0)
      : null;
    const invoiceBalance = latestInvoice
      ? Math.max(Number(latestInvoice.amount_due || 0) - Number(latestInvoice.amount_paid || 0), 0)
      : null;

    return { tenant, activeGoal, latestInvoice, goalBalance, invoiceBalance };
  }

  async getPaymentHistory({ tenantPhoneNumber, limit = 10 }) {
    const tenant = await this.findUserByPhone(tenantPhoneNumber);
    const payments = await this.db.select("payments", {
      query: `?tenant_user_id=${eq(tenant.id)}&select=*&order=created_at.desc&limit=${Number(limit) || 10}`
    });

    return { tenant, payments };
  }

  async requestTenantStatement({ tenantPhoneNumber, periodStart, periodEnd }) {
    const tenant = await this.findUserByPhone(tenantPhoneNumber);
    const notification = await this.db.insert("notifications", {
      user_id: tenant.id,
      channel: "whatsapp",
      status: "pending",
      title: "Tenant statement requested",
      body: `Statement requested from ${periodStart || "start"} to ${periodEnd || "today"}`,
      metadata: {
        type: "tenant_statement_request",
        period_start: periodStart || null,
        period_end: periodEnd || null
      }
    });

    return { tenant, notification };
  }

  async createSupportRequest({ phoneNumber, message }) {
    const user = await this.findUserByPhone(phoneNumber);
    const notification = await this.db.insert("notifications", {
      user_id: user.id,
      channel: "whatsapp",
      status: "pending",
      title: "WhatsApp support request",
      body: message,
      metadata: {
        type: "support_request",
        source: "whatsapp_chat"
      }
    });

    return { user, notification };
  }

  async reportMaintenanceIssue({ tenantPhoneNumber, propertyId, unitId, title, description, priority }) {
    const tenant = await this.findUserByPhone(tenantPhoneNumber);
    const issue = await this.db.insert("maintenance_issues", {
      reported_by_user_id: tenant.id,
      tenant_user_id: tenant.id,
      property_id: propertyId || null,
      unit_id: unitId || null,
      title,
      description,
      priority: priority || "normal",
      status: "open"
    });

    return { tenant, issue };
  }

  async createFlowSubmission({ flowName, source, phoneNumber, payload }) {
    let user = null;
    if (phoneNumber) {
      user = await this.db.select("users", {
        query: `?phone_number=${eq(phoneNumber)}&select=id`,
        single: true
      });
    }

    const submission = await this.db.insert("flow_submissions", {
      flow_name: flowName,
      source,
      phone_number: phoneNumber || null,
      user_id: user?.id || null,
      payload,
      status: "received"
    });

    return submission;
  }

  async markFlowSubmissionProcessed(id, result, submissionSummary = {}) {
    return this.db.update("flow_submissions", {
      status: "processed",
      result,
      submission_summary: submissionSummary
    }, `?id=${eq(id)}`);
  }

  async markFlowSubmissionFailed(id, error) {
    return this.db.update("flow_submissions", {
      status: "failed",
      error_message: error.message || String(error)
    }, `?id=${eq(id)}`);
  }

  async acceptTenantInvitation({ code, fullName, phoneNumber, nationalIdNumber, signupChannel = "whatsapp" }) {
    const invitation = await this.db.select("invitations", {
      query: `?code=${eq(code)}&status=eq.pending&select=*`,
      single: true
    });

    if (!invitation) throw new Error("Invitation code is invalid or already used.");
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      throw new Error("Invitation code has expired.");
    }

    const user = await this.upsertUser({
      fullName,
      phoneNumber: phoneNumber || invitation.invited_phone_number,
      nationalIdNumber,
      signupChannel
    });

    await this.assignRole(user.id, "tenant");
    await this.ensureTenantProfile(user.id);

    const unit = await this.db.select("units", {
      query: `?id=${eq(invitation.unit_id)}&select=*`,
      single: true
    });

    if (!unit) throw new Error("Invitation unit was not found.");

    const assignment = await this.db.insert("tenant_assignments", {
      tenant_user_id: user.id,
      property_id: invitation.property_id,
      unit_id: invitation.unit_id,
      monthly_rent_amount: unit.monthly_rent_amount,
      rent_due_day: unit.rent_due_day,
      status: "active"
    });

    await this.db.update("units", {
      is_occupied: true
    }, `?id=${eq(invitation.unit_id)}`);

    await this.db.update("invitations", {
      status: "accepted",
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: user.id
    }, `?id=${eq(invitation.id)}`);

    return { user, invitation, assignment };
  }

  async saveMessage({ phoneNumber, direction, body = "", channel = "whatsapp" }) {
    const messageBody = body == null ? "" : String(body);

    let user = await this.db.select("users", {
      query: `?phone_number=${eq(phoneNumber)}&select=id`,
      single: true
    });

    if (!user) {
      user = await this.db.insert("users", {
        full_name: "Unknown",
        phone_number: phoneNumber,
        signup_channel: channel
      }, {
        onConflict: "phone_number",
        mergeDuplicates: true
      });
    }

    let conversation = await this.db.select("conversations", {
      query: `?user_id=${eq(user.id)}&channel=${eq(channel)}&select=id&order=created_at.desc&limit=1`,
      single: true
    });

    if (!conversation) {
      conversation = await this.db.insert("conversations", {
        user_id: user.id,
        channel
      });
    }

    await this.db.insert("messages", {
      conversation_id: conversation.id,
      sender: direction,
      message: messageBody
    });
  }

  async createOrUpdateMenuSession({ phoneNumber, waId, externalUserId, selectedOption, selectedUserType, currentStep = "choose_user_type", data }) {
    const sessionExternalUserId = externalUserId || waId || phoneNumber;
    const existing = await this.db.select("onboarding_sessions", {
      query: `?external_user_id=${eq(sessionExternalUserId)}&status=eq.active&select=*&order=created_at.desc&limit=1`,
      single: true
    });

    const sessionData = data || {
      selected_option: selectedOption || null,
      selected_user_type: selectedUserType || null
    };

    if (existing) {
      return this.db.update("onboarding_sessions", {
        external_user_id: sessionExternalUserId,
        flow_type: selectedUserType || existing.flow_type || existing.data?.flow_type || null,
        current_step: currentStep,
        data: data || existing.data || sessionData,
        status: "active",
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      }, `?id=${eq(existing.id)}`);
    }

    return this.db.insert("onboarding_sessions", {
      external_user_id: sessionExternalUserId,
      phone_number: phoneNumber,
      flow: "independent_tenant",
      flow_type: selectedUserType || null,
      status: "active",
      current_step: currentStep,
      data: sessionData
    });
  }

  async getActiveOnboardingSession(externalUserId) {
    return this.db.select("onboarding_sessions", {
      query: `?external_user_id=${eq(externalUserId)}&status=eq.active&select=*&order=created_at.desc&limit=1`,
      single: true
    });
  }

  async getOnboardingSessionById(id) {
    return this.db.select("onboarding_sessions", {
      query: `?id=${eq(id)}&select=*`,
      single: true
    });
  }

  async startOnboardingFlow({ phoneNumber, waId, externalUserId, flowType, selectedOption, step = "full_name", data = {} }) {
    const sessionExternalUserId = externalUserId || waId || phoneNumber;
    const existing = await this.getActiveOnboardingSession(sessionExternalUserId);
    const sessionData = {
      ...data,
      flow_type: flowType,
      step
    };
    const payload = {
      external_user_id: sessionExternalUserId,
      flow: onboardingFlowForType(flowType),
      flow_type: flowType,
      current_step: step,
      data: sessionData,
      status: "active",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    if (existing) {
      return this.updateOnboardingRow({
        id: existing.id,
        payload
      });
    }

    return this.insertOnboardingRow({
      payload: {
        ...payload,
        phone_number: phoneNumber
      }
    });
  }

  async advanceOnboardingFlow({ session, step, data, status = "active" }) {
    const flowType = data?.flow_type || session.flow_type || session.data?.flow_type || null;
    const payload = {
      flow_type: flowType,
      current_step: step,
      data: {
        ...(data || {}),
        flow_type: flowType,
        step
      },
      status,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    console.log("Updated data", payload.data);
    console.log("Next step", step);

    return this.updateOnboardingRow({
      id: session.id,
      payload
    });
  }

  async cancelOnboardingFlow(session) {
    return this.db.update("onboarding_sessions", {
      status: "cancelled",
      current_step: "cancelled"
    }, `?id=${eq(session.id)}`);
  }

  async getRecentMessagesForPhone(phoneNumber, limit = 8) {
    const user = await this.findUserByPhone(phoneNumber, { required: false });
    if (!user) return [];

    const conversation = await this.db.select("conversations", {
      query: `?user_id=${eq(user.id)}&channel=eq.whatsapp&select=id&order=created_at.desc&limit=1`,
      single: true
    });

    if (!conversation) return [];

    const messages = await this.db.select("messages", {
      query: `?conversation_id=${eq(conversation.id)}&select=sender,message,created_at&order=created_at.desc&limit=${Number(limit) || 8}`
    });

    return messages.reverse();
  }

  async getAiUserContext(phoneNumber) {
    const user = await this.findUserByPhone(phoneNumber, { required: false });
    if (!user) {
      return {
        phone_number: phoneNumber,
        is_known_user: false
      };
    }

    const userRoles = await this.db.select("user_roles", {
      query: `?user_id=${eq(user.id)}&select=roles(name)`
    });
    const roles = userRoles.map((row) => row.roles?.name).filter(Boolean);

    const rentGoal = await this.db.select("rent_goals", {
      query: `?tenant_user_id=${eq(user.id)}&is_active=eq.true&select=monthly_rent_amount,rent_due_day,amount_saved,target_month,savings_frequency,target_start_date&order=created_at.desc&limit=1`,
      single: true
    });

    const outstandingBalance = rentGoal
      ? Math.max(Number(rentGoal.monthly_rent_amount || 0) - Number(rentGoal.amount_saved || 0), 0)
      : null;

    return {
      is_known_user: true,
      name: user.full_name,
      phone_number: user.phone_number,
      roles,
      rent_goal: rentGoal,
      due_day: rentGoal?.rent_due_day || null,
      outstanding_balance: outstandingBalance
    };
  }

  async updateOnboardingSession({ id, currentStep, data, selectedOption, selectedUserType, status = "active", nativeFlowAttempted, nativeFlowContentSid, fallbackChatActive }) {
    const flowType = data?.flow_type || selectedUserType || null;
    const payload = {
      current_step: currentStep,
      flow_type: flowType,
      data: {
        ...(data || {}),
        ...(flowType ? { flow_type: flowType } : {})
      },
      status,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    };

    return this.updateOnboardingRow({ id, payload });
  }

  async insertOnboardingRow({ payload }) {
    try {
      return await this.db.insert("onboarding_sessions", payload);
    } catch (error) {
      console.error("Supabase onboarding insert failed:", {
        payload,
        error
      });
      throw error;
    }
  }

  async updateOnboardingRow({ id, payload }) {
    try {
      return await this.db.update("onboarding_sessions", payload, `?id=${eq(id)}`);
    } catch (error) {
      console.error("Supabase onboarding update failed:", {
        id,
        payload,
        error
      });
      throw error;
    }
  }
}

function isYes(value) {
  return ["yes", "y", "true", "1"].includes(String(value || "").trim().toLowerCase());
}

function onboardingFlowForType(flowType) {
  if (flowType === "landlord") return "landlord";
  if (flowType === "property_manager") return "property_manager";
  if (flowType === "tenant_invitation") return "tenant_invitation";
  return "independent_tenant";
}

function validatePin(pin) {
  if (!/^\d{4,6}$/.test(String(pin || ""))) {
    throw new Error("Transaction PIN must be 4 to 6 digits.");
  }
}

function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(String(pin), salt, 120000, 32, "sha256").toString("hex");
}

function generateInvitationCode(unitNumber) {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  const unit = String(unitNumber || "UNIT").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6);
  return `JOIN-${unit}-${suffix}`;
}

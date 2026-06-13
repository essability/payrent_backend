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

  async upsertUser({ fullName, phoneNumber, email, nationalIdNumber, signupChannel }) {
    return this.db.insert("users", {
      full_name: fullName,
      phone_number: phoneNumber,
      email: email || null,
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

  async saveMessage({ phoneNumber, direction, body, channel = "whatsapp" }) {
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
      message: body
    });
  }
}

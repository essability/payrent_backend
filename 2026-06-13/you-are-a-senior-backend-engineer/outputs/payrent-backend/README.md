# PayRent Backend

Small Node.js backend for PayRent registration through WhatsApp, web, and invitation codes.

## What it supports

- Twilio WhatsApp webhook: `POST /webhooks/twilio/whatsapp`
- Primary Twilio WhatsApp onboarding webhook: `POST /webhook/whatsapp`
- Twilio WhatsApp Flow submission webhook: `POST /webhooks/twilio/whatsapp-flow`
- Independent tenant registration from WhatsApp
- Tenant registration from invitation code
- Web/API independent tenant registration
- Web/API landlord registration
- WhatsApp Flow JSON definitions for tenant, landlord, property manager, property creation, and rent payment
- Operational WhatsApp forms for PIN setup, savings, balance checks, payment history, statements, tenant invitations, unit creation, and maintenance issues
- Warm PayRent WhatsApp welcome menu before launching form-style flows
- Conversation and message saving
- Supabase PostgreSQL through the Supabase REST API

## 1. Run the database migration

You already created the main tables. Run this additional SQL in Supabase SQL Editor:

```sql
-- See migrations/002_onboarding_sessions.sql
-- See migrations/003_whatsapp_flows.sql
-- See migrations/004_payrent_operational_flows.sql
-- See migrations/005_payrent_whatsapp_onboarding.sql
```

## 2. Configure environment

Create a `.env` file using `.env.example`:

```bash
PORT=3000
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
API_SECRET=change-me
PUBLIC_BASE_URL=https://your-railway-domain.up.railway.app
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_FLOW_CONTENT_SIDS={"tenant_registration":"HX...","save_towards_rent":"HX...","set_transaction_pin":"HX...","savings_deposit":"HX...","rent_payment":"HX..."}
```

For local testing, load the env vars before starting:

```bash
set -a
source .env
set +a
npm run dev
```

## 3. Twilio WhatsApp setup

In Twilio WhatsApp Sandbox or your WhatsApp Sender settings, set:

```text
When a message comes in:
https://your-public-domain.com/webhook/whatsapp
```

For local development, expose your server with a tunnel such as ngrok:

```bash
ngrok http 3000
```

Then use the HTTPS forwarding URL in Twilio.

## 3b. WhatsApp Flow setup

Flow definitions are in:

```text
flows/tenant_registration.json
flows/save_towards_rent.json
flows/landlord_registration.json
flows/property_manager_registration.json
flows/property_creation.json
flows/unit_creation.json
flows/tenant_invitation.json
flows/set_transaction_pin.json
flows/savings_deposit.json
flows/rent_goal_update.json
flows/rent_payment.json
flows/rent_balance_check.json
flows/payment_history.json
flows/tenant_statement_request.json
flows/maintenance_issue.json
flows/twilio_content_templates.json
```

Twilio outbound Content template definitions are in:

```text
twilio/content-templates.json
```

These templates are the messages Twilio sends to open or trigger each PayRent action from WhatsApp.

To test the template payloads without calling Twilio:

```bash
npm run twilio:content:dry-run
```

To create the templates in Twilio:

```bash
export TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export TWILIO_AUTH_TOKEN=your_twilio_auth_token
npm run twilio:content:push
```

To create the templates and submit them for WhatsApp approval:

```bash
export TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export TWILIO_AUTH_TOKEN=your_twilio_auth_token
npm run twilio:content:push-and-submit
```

After the script runs, it writes:

```text
twilio/generated/twilio-flow-content-sids.json
twilio/generated/railway-env.txt
```

Copy the `TWILIO_FLOW_CONTENT_SIDS=...` value from `twilio/generated/railway-env.txt` into Railway Variables.

To list templates already created in Twilio:

```bash
export TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export TWILIO_AUTH_TOKEN=your_twilio_auth_token
npm run twilio:content:list
```

Configure the Flow data/submission endpoint to:

```text
https://your-public-domain.com/webhooks/twilio/whatsapp-flow
```

For authenticated direct submissions from a web app or admin dashboard:

```text
POST /api/flows/:flowName/submissions
```

Example:

```bash
curl -X POST http://localhost:3000/api/flows/tenant_registration/submissions \
  -H "authorization: Bearer change-me" \
  -H "content-type: application/json" \
  -d '{
    "source": "web",
    "payload": {
      "full_name": "Jane Wambui",
      "phone_number": "+254711111111",
      "national_id_number": "11223344",
      "monthly_rent_amount": 18000,
      "rent_due_day": 5
    }
  }'
```

To fetch a Flow JSON definition:

```bash
curl http://localhost:3000/api/flows/tenant_registration \
  -H "authorization: Bearer change-me"
```

To send an approved Twilio Content template/Flow message:

```bash
curl -X POST http://localhost:3000/api/twilio/send-flow \
  -H "authorization: Bearer change-me" \
  -H "content-type: application/json" \
  -d '{
    "to": "+254711111111",
    "flowName": "savings_deposit",
    "contentVariables": {
      "1": "PayRent"
    }
  }'
```

`/api/twilio/send-flow` accepts either a direct `contentSid` or a `flowName` that maps to `TWILIO_FLOW_CONTENT_SIDS`.

The backend currently supports these Flow submissions:

```text
tenant_registration
save_towards_rent
landlord_registration
property_manager_registration
property_creation
unit_creation
tenant_invitation
set_transaction_pin
savings_deposit
rent_goal_update
rent_payment
rent_balance_check
payment_history
tenant_statement_request
maintenance_issue
```

## 3c. First 50% WhatsApp onboarding test

Set Twilio **When a message comes in** to:

```text
https://your-railway-domain/webhook/whatsapp
```

Then send any first message:

```text
Hi
```

Expected response:

```text
🏠 Welcome to PayRent Kenya 🇰🇪

We’re so happy to have you here.

PayRent helps you manage rent, save towards rent, receive reminders, and make rent payments directly from WhatsApp — simple, safe, and stress-free.

Please choose how you want to continue:

1️⃣ I am a Tenant
2️⃣ I am a Landlord
3️⃣ I am a Property Manager
4️⃣ I just want to Save Towards Rent

With love,
Ruth ❤️
CEO, PayRent Kenya

Reply with 1, 2, 3, or 4.
```

Reply:

```text
1
```

The backend will request the `tenant_registration` WhatsApp Flow using the `TWILIO_FLOW_CONTENT_SIDS.tenant_registration` value.

Reply:

```text
4
```

The backend will request the `save_towards_rent` WhatsApp Flow using the `TWILIO_FLOW_CONTENT_SIDS.save_towards_rent` value.

If the Twilio Sandbox cannot launch WhatsApp Flows yet, use the in-app browser forms or chat fallback.

The WhatsApp menu includes web form links that open in WhatsApp's in-app browser:

```text
https://your-railway-domain/forms/tenant-registration
https://your-railway-domain/forms/save-towards-rent
```

These forms are hosted by the same Railway backend and submit directly to Supabase through the existing Flow processor.

Tenant fallback:

```text
TENANT: Jane Wambui, +254711111111, jane@example.com, NO, 18000, 5
```

Tenant with invitation fallback:

```text
TENANT: Jane Wambui, +254711111111, jane@example.com, JOIN-A1-2026, 18000, 5
```

Save Toward Rent fallback:

```text
SAVE: Jane Wambui, +254711111111, 18000, 5, weekly, 2026-07-01
```

Landlord and property manager are intentionally held for the next build phase:

```text
2
3
```

## 4. WhatsApp registration flow

Independent tenant:

```text
User: Hi
Bot: Welcome to PayRent. Please enter your full name.
Bot asks Kenyan ID number
Bot asks monthly rent
Bot asks due day
Bot creates users, user_roles, tenant_profiles, rent_goals
```

Invitation tenant:

```text
User: Join Property
Bot asks invitation code
Bot asks full name
Bot asks Kenyan ID number
Bot creates/updates user and tenant assignment
```

## 5. Web/API examples

Independent tenant:

```bash
curl -X POST http://localhost:3000/api/register/tenant-independent \
  -H "authorization: Bearer change-me" \
  -H "content-type: application/json" \
  -d '{
    "fullName": "John Doe",
    "phoneNumber": "+254712345678",
    "nationalIdNumber": "12345678",
    "monthlyRentAmount": 15000,
    "rentDueDay": 5,
    "signupChannel": "web"
  }'
```

Tenant via invitation:

```bash
curl -X POST http://localhost:3000/api/register/invitation \
  -H "authorization: Bearer change-me" \
  -H "content-type: application/json" \
  -d '{
    "code": "JOIN-A1-2026",
    "fullName": "Peter Mwangi",
    "phoneNumber": "+254733333333",
    "nationalIdNumber": "34567890",
    "signupChannel": "web"
  }'
```

Landlord:

```bash
curl -X POST http://localhost:3000/api/register/landlord \
  -H "authorization: Bearer change-me" \
  -H "content-type: application/json" \
  -d '{
    "fullName": "Mary Wanjiku",
    "phoneNumber": "+254722222222",
    "email": "mary@example.com",
    "nationalIdNumber": "23456789",
    "landlordType": "individual_landlord",
    "signupChannel": "web"
  }'
```

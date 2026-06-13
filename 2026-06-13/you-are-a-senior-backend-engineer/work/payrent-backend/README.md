# PayRent Backend

Small Node.js backend for PayRent registration through WhatsApp, web, and invitation codes.

## What it supports

- Twilio WhatsApp webhook: `POST /webhooks/twilio/whatsapp`
- Independent tenant registration from WhatsApp
- Tenant registration from invitation code
- Web/API independent tenant registration
- Web/API landlord registration
- Conversation and message saving
- Supabase PostgreSQL through the Supabase REST API

## 1. Run the database migration

You already created the main tables. Run this additional SQL in Supabase SQL Editor:

```sql
-- See migrations/002_onboarding_sessions.sql
```

## 2. Configure environment

Create a `.env` file using `.env.example`:

```bash
PORT=3000
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
API_SECRET=change-me
TWILIO_AUTH_TOKEN=your-twilio-auth-token
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
https://your-public-domain.com/webhooks/twilio/whatsapp
```

For local development, expose your server with a tunnel such as ngrok:

```bash
ngrok http 3000
```

Then use the HTTPS forwarding URL in Twilio.

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

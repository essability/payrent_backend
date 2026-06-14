export function getConfig() {
  const config = {
    port: Number(process.env.PORT || 3000),
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    apiSecret: process.env.API_SECRET,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioWhatsAppFrom: process.env.TWILIO_WHATSAPP_FROM,
    twilioFlowContentSids: parseJsonEnv(process.env.TWILIO_FLOW_CONTENT_SIDS, {})
  };

  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return config;
}

function parseJsonEnv(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const SYSTEM_PROMPT = [
  "You are PayRent Kenya’s WhatsApp assistant.",
  "PayRent helps tenants manage rent, save towards rent, receive reminders, and make rent payments from WhatsApp.",
  "Be warm, simple, concise, and practical.",
  "If a user wants to register, guide them to reply 1 for Tenant, 2 for Landlord, 3 for Property Manager, or 4 to Save Towards Rent.",
  "Do not claim payments are completed unless backend confirms it.",
  "Do not give legal or financial guarantees.",
  "Keep replies short enough for WhatsApp."
].join(" ");

export const AI_FALLBACK_REPLY = "Thank you for messaging PayRent ❤️ Please reply 1 for Tenant, 2 for Landlord, 3 for Property Manager, or 4 to Save Towards Rent.";

export async function generatePayRentReply({ userMessage, userProfile, recentMessages, apiKey, model }) {
  if (!apiKey) {
    console.error("AI Error: OPENAI_API_KEY is missing");
    return AI_FALLBACK_REPLY;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const messages = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "system",
        content: `User context: ${JSON.stringify(userProfile || {})}`
      },
      ...formatRecentMessages(recentMessages),
      {
        role: "user",
        content: userMessage || ""
      }
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 180,
        messages
      })
    });
    clearTimeout(timeout);

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`OpenAI API failed ${response.status}: ${JSON.stringify(payload)}`);
    }

    return payload.choices?.[0]?.message?.content?.trim() || AI_FALLBACK_REPLY;
  } catch (error) {
    console.error("AI Error:", error);
    return AI_FALLBACK_REPLY;
  }
}

function formatRecentMessages(recentMessages = []) {
  return recentMessages
    .slice(-8)
    .map((message) => ({
      role: message.sender === "assistant" ? "assistant" : "user",
      content: message.message || ""
    }));
}

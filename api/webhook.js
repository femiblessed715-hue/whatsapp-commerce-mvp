const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const { waitUntil } = require("@vercel/functions");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const OPENAI_API_URL =
  "https://api.openai.com/v1/chat/completions";

const OPENAI_MODEL = "gpt-4o-mini";

function extractWhatsAppMessage(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  const phoneNumberId = value?.metadata?.phone_number_id;
  const message = value?.messages?.[0];

  if (!phoneNumberId || !message) {
    return null;
  }

  if (message.type !== "text") {
    return null;
  }

  const customerPhone = message.from;
  const text = message.text?.body?.trim();

  if (!customerPhone || !text) {
    return null;
  }

  return {
    phoneNumberId,
    customerPhone,
    text,
    messageId: message.id
  };
}

async function getMerchant(phoneNumberId) {
  const { data, error } = await supabase
    .from("merchants")
    .select(
      "id, business_name, whatsapp_phone_id, meta_access_token, currency"
    )
    .eq("whatsapp_phone_id", phoneNumberId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Merchant lookup failed: ${error.message}`
    );
  }

  if (!data) {
    throw new Error(
      "No merchant found for this WhatsApp number."
    );
  }

  return data;
}

async function getProducts(merchantId) {
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, name, description, price, stock_quantity"
    )
    .eq("merchant_id", merchantId)
    .order("name", { ascending: true });

  if (error) {
    throw new Error(
      `Product lookup failed: ${error.message}`
    );
  }

  return data || [];
}

function buildProductContext(products, currency) {
  if (!products.length) {
    return "No products are currently available.";
  }

  return products
    .map(
      (product) =>
        `Name: ${product.name} | ` +
        `Description: ${product.description} | ` +
        `Price: ${Number(product.price).toFixed(2)} ${currency} | ` +
        `Stock: ${product.stock_quantity}`
    )
    .join("\n");
}

async function generateReply(
  customerMessage,
  products,
  currency
) {
  const productContext = buildProductContext(
    products,
    currency
  );

  const systemPrompt = `
You are a smart, conversational retail sales assistant for a WhatsApp storefront.

Look at the provided database context.

If the user asks for stock, availability, or prices of products, answer directly based on real database numbers.

Never invent product names, prices, stock quantities, discounts, payment links, or order confirmations.

Keep replies under 3 sentences, sounding friendly.

Offer to generate a payment link if they express intent to purchase.

DATABASE CONTEXT:
${productContext}
`;

  const response = await axios.post(
    OPENAI_API_URL,
    {
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: customerMessage
        }
      ],
      temperature: 0.2,
      max_tokens: 180
    },
    {
      headers: {
        Authorization:
          `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 8000
    }
  );

  const reply =
    response.data?.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    throw new Error(
      "OpenAI returned an empty response."
    );
  }

  return reply;
}

async function sendWhatsAppMessage({
  phoneNumberId,
  accessToken,
  customerPhone,
  text
}) {
  const version =
    process.env.WHATSAPP_GRAPH_API_VERSION || "v23.0";

  const url =
    `https://graph.facebook.com/${version}/` +
    `${phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: customerPhone,
      type: "text",
      text: {
        preview_url: false,
        body: text
      }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 8000
    }
  );
}

async function processMessage(message) {
  try {
    const merchant = await getMerchant(
      message.phoneNumberId
    );

    const products = await getProducts(
      merchant.id
    );

    const reply = await generateReply(
      message.text,
      products,
      merchant.currency
    );

    await sendWhatsAppMessage({
      phoneNumberId:
        merchant.whatsapp_phone_id,
      accessToken:
        merchant.meta_access_token,
      customerPhone:
        message.customerPhone,
      text: reply
    });

    console.log(
      JSON.stringify({
        event: "message_processed",
        merchantId: merchant.id,
        messageId: message.messageId
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "message_processing_failed",
        messageId: message.messageId,
        error: error.message
      })
    );
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const verifyToken =
      req.query?.["hub.verify_token"];

    const challenge =
      req.query?.["hub.challenge"];

    if (
      verifyToken ===
        process.env.WHATSAPP_VERIFY_TOKEN &&
      challenge
    ) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    const message =
      extractWhatsAppMessage(req.body);

    if (message) {
      waitUntil(
        processMessage(message)
      );
    }

    return res.status(200).json({
      ok: true
    });
  }

  res.setHeader(
    "Allow",
    "GET, POST"
  );

  return res.status(405).json({
    error: "Method not allowed"
  });
};

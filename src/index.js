// Fujin LINE AI v1
// LINE Webhook -> Cloudflare Worker -> Google Sheets
// Required Cloudflare variables/secrets:
// - GOOGLE_SERVICE_ACCOUNT  (JSON from Google Service Account)
// - SHEET_ID                (Google Sheet ID)
// - LINE_CHANNEL_SECRET     (LINE Channel secret)
// - LINE_CHANNEL_ACCESS_TOKEN (LINE Messaging API access token, optional for reply)

const DEFAULT_SHEET_NAME = "派工紀錄";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "Fujin LINE AI",
        version: "v1",
        message: "Webhook is running"
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const bodyText = await request.text();

    try {
      // LINE signature verification
      const signature = request.headers.get("x-line-signature") || "";
      if (env.LINE_CHANNEL_SECRET) {
        const valid = await verifyLineSignature(bodyText, env.LINE_CHANNEL_SECRET, signature);
        if (!valid) {
          await appendErrorLog(env, "LINE_SIGNATURE_INVALID", bodyText);
          return new Response("Unauthorized", { status: 401 });
        }
      }

      const payload = JSON.parse(bodyText || "{}");
      const events = Array.isArray(payload.events) ? payload.events : [];

      if (events.length === 0) {
        await appendRows(env, [[
          nowTaiwan(),
          "verify",
          "",
          "",
          "",
          "",
          "",
          bodyText
        ]]);
        return new Response("OK", { status: 200 });
      }

      const rows = [];

      for (const event of events) {
        const source = event.source || {};
        const message = event.message || {};
        const text = message.type === "text" ? message.text : `[${message.type || event.type}]`;

        rows.push([
          nowTaiwan(),
          source.type || "",
          source.groupId || "",
          source.roomId || "",
          source.userId || "",
          event.type || "",
          text || "",
          JSON.stringify(event)
        ]);

        // Optional simple reply for direct/group testing
        if (event.replyToken && message.type === "text" && shouldReply(text)) {
          ctx.waitUntil(replyLine(env, event.replyToken, "已收到，已寫入福進環保派工紀錄。"));
        }
      }

      if (rows.length > 0) {
        await appendRows(env, rows);
      }

      return new Response("OK", { status: 200 });
   } catch (err) {
  const msg = String(err && err.stack ? err.stack : err).slice(0, 800);
  console.log("WEBHOOK_ERROR", msg);

  try {
    const payload = JSON.parse(bodyText || "{}");
    const event = payload.events && payload.events[0];
    if (event && event.replyToken) {
      await replyLine(env, event.replyToken, "寫入 Google Sheet 失敗：\n" + msg);
    }
  } catch (_) {}

  return new Response("OK", { status: 200 });
}
  }
};

function shouldReply(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  return t === "test" || t === "測試" || t === "測試123" || t.includes("測試");
}

function nowTaiwan() {
  return new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function verifyLineSignature(bodyText, channelSecret, signature) {
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(bodyText)
  );

  const expected = arrayBufferToBase64(sig);
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function appendRows(env, rows) {
  if (!env.SHEET_ID) {
    throw new Error("Missing SHEET_ID variable in Cloudflare Worker settings.");
  }
  if (!env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT secret.");
  }

  const sheetName = env.SHEET_NAME || DEFAULT_SHEET_NAME;
  const accessToken = await getGoogleAccessToken(env);
  const range = encodeURIComponent(`${sheetName}!A:H`);

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ values: rows })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Sheets append failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function appendErrorLog(env, code, detail) {
  try {
    if (!env.SHEET_ID || !env.GOOGLE_SERVICE_ACCOUNT) return;
    await appendRows(env, [[
      nowTaiwan(),
      "error",
      "",
      "",
      "",
      code,
      String(detail || "").slice(0, 45000),
      ""
    ]]);
  } catch (_) {
    // Avoid recursive failures.
  }
}

async function getGoogleAccessToken(env) {
  const serviceAccount = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT"
  };

  const claim = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const unsignedJwt = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const signature = await signRs256(unsignedJwt, serviceAccount.private_key);
  const jwt = `${unsignedJwt}.${signature}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    throw new Error(`Google token error: ${tokenRes.status} ${JSON.stringify(tokenData)}`);
  }

  return tokenData.access_token;
}

function parseServiceAccount(raw) {
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT is empty.");
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data.client_email || !data.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT JSON must include client_email and private_key.");
  }
  return data;
}

function base64UrlJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function base64UrlEncode(input) {
  let bytes;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = new TextEncoder().encode(String(input));
  }

  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signRs256(data, privateKeyPem) {
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(data)
  );
  return base64UrlEncode(signature);
}

async function importPrivateKey(pem) {
  const cleanPem = pem
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(cleanPem), c => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
}

async function replyLine(env, replyToken, text) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !replyToken) return;

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
}

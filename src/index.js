

// Fujin LINE AI v3.0
// LINE → Cloudflare Worker → OpenAI → Google Sheets

const SHEET_AI = "AI派工";
const SHEET_DISPATCH = "01_派工紀錄";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "Fujin LINE AI",
        version: "v3.0",
        message: "Webhook is running"
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const bodyText = await request.text();

    try {
      const signature = request.headers.get("x-line-signature") || "";

      if (env.LINE_CHANNEL_SECRET) {
        const valid = await verifyLineSignature(bodyText, env.LINE_CHANNEL_SECRET, signature);
        if (!valid) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      const payload = JSON.parse(bodyText || "{}");
      const events = Array.isArray(payload.events) ? payload.events : [];

      for (const event of events) {
        if (event.type !== "message") continue;
        if (!event.message || event.message.type !== "text") continue;

        const text = event.message.text || "";
        const source = event.source || {};

        const ai = await parseDispatchWithAI(text, env);

        if (!ai.is_dispatch) {
          await replyLine(env, event.replyToken, "已收到，但判斷不是派工訊息。");
          continue;
        }

        const now = nowTaiwan();
        const dispatchId = makeDispatchId();

        await appendRows(env, SHEET_AI, [[
          now,
          ai.customer || "",
          ai.scheduled_date || "",
          ai.address || "",
          ai.waste_type || "",
          ai.vehicle || "",
          ai.estimated_quantity || "",
          ai.unit_price || "",
          "待派工",
          text
        ]]);

   
        await appendRows(env, SHEET_DISPATCH, [[
          dispatchId,
          now,
          ai.scheduled_date || "",
          ai.customer || "",
          ai.waste_type || "",
          ai.address || "",
          ai.vehicle || "",
          ai.estimated_quantity || "",
          ai.unit || "",
          "待派工",
          ai.note || "",
          source.type || "",
          source.userId || "",
          source.groupId || ""
        ]]);

        await replyLine(env, event.replyToken,
`✅ 已建立派工

編號：${dispatchId}
客戶：${ai.customer || "未判斷"}
日期：${ai.scheduled_date || "未填"}
種類：${ai.waste_type || "未填"}
位置：${ai.address || "未填"}
車輛：${ai.vehicle || "未填"}
預估：${ai.estimated_quantity || "未填"}
單價：${ai.unit_price || "未填"}`
        );
      }

      return new Response("OK", { status: 200 });

    } catch (err) {
  console.log(err);
  return new Response(String(err), { status: 500 });
}
}
};

async function parseDispatchWithAI(message, env) {
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const today = nowTaiwan();

  const systemPrompt = `
你是福進環保有限公司的派工AI。

請判斷 LINE 訊息是否為叫車、清運、派工相關訊息。

只回傳 JSON，不要加任何說明。

JSON 格式：
{
  "is_dispatch": true,
  "customer": "",
  "scheduled_date": "",
  "address": "",
  "waste_type": "",
  "vehicle": "",
  "estimated_quantity": "",
  "unit": "",
  "unit_price": "",
  "note": ""
}

規則：
- 今天時間：${today}
- 派工階段只記錄預估，不是實際重量。
- 垃圾預設單價：9
- 木材預設單價：5
- 3.5噸、9260、舉斗車 → vehicle 填 ARX-9260
- 7.5噸、2628、夾子車 → vehicle 填 KEL-2628
- 17噸夾子車若未給車號，vehicle 填 17噸夾子車
- 壓縮車以垃圾子車桶數記錄
- 垃圾、一般垃圾 → waste_type 填 垃圾
- 木材、板模、廢木 → waste_type 填 木材
- 混合物 → waste_type 填 混合物
- 不確定欄位填空字串
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error("OpenAI error: " + JSON.stringify(data));
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI response empty");

  return JSON.parse(content);
}

async function appendRows(env, sheetName, rows) {
  if (!env.SHEET_ID) throw new Error("Missing SHEET_ID");
  if (!env.GOOGLE_SERVICE_ACCOUNT) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT");

  const token = await getGoogleAccessToken(env);
  const range = encodeURIComponent(`${sheetName}!A:Z`);

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: rows })
    }
  );

if (!res.ok) {
  const text = await res.text();

  console.log("========== GOOGLE ERROR ==========");
  console.log("Sheet:", sheetName);
  console.log("Status:", res.status);
  console.log(text);

  throw new Error(text);
}
}

async function getGoogleAccessToken(env) {
  const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };

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

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error("Google token error: " + JSON.stringify(data));
  }

  return data.access_token;
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

  return arrayBufferToBase64(sig) === signature;
}

async function replyLine(env, replyToken, text) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !replyToken) return;

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
}

function nowTaiwan() {
  return new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false
  });
}

function makeDispatchId() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const r = Math.floor(Math.random() * 900 + 100);
  return `FJ-${y}${m}${day}-${r}`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
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

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function signRs256(data, privateKeyPem) {
  const cleanPem = privateKeyPem
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(cleanPem), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(data)
  );

  return base64UrlEncode(signature);
}

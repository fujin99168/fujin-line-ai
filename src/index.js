const SHEET_AI = "AI派工";
const SHEET_DISPATCH = "01_派工紀錄";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return jsonResponse({ ok: true, service: "Fujin LINE AI", version: "v2" });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const bodyText = await request.text();

    try {
      const signature = request.headers.get("x-line-signature") || "";
      const valid = await verifyLineSignature(bodyText, env.LINE_CHANNEL_SECRET, signature);
      if (!valid) return new Response("Unauthorized", { status: 401 });

      const payload = JSON.parse(bodyText || "{}");
      const events = payload.events || [];

      for (const event of events) {
        if (event.type !== "message") continue;
        if (!event.message || event.message.type !== "text") continue;

        const text = event.message.text || "";
        const source = event.source || {};

        const ai = await parseDispatchWithAI(text, env);

        if (!ai.is_dispatch) {
          if (event.replyToken) {
            await replyLine(env, event.replyToken, "已收到，但我判斷這不是派工訊息。");
          }
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

        if (event.replyToken) {
          await replyLine(env, event.replyToken,
`已建立派工：
編號：${dispatchId}
客戶：${ai.customer || "未判斷"}
日期：${ai.scheduled_date || "未填"}
種類：${ai.waste_type || "未填"}
位置：${ai.address || "未填"}
車輛：${ai.vehicle || "未填"}
預估：${ai.estimated_quantity || "未填"}`
          );
        }
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.log("ERROR", err.stack || err);
      return new Response("OK", { status: 200 });
    }
  }
};

async function parseDispatchWithAI(message, env) {
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const today = nowTaiwan();

  const systemPrompt = `
你是福進環保有限公司的派工AI。
請判斷 LINE 訊息是否為「叫車、清運、派工」相關訊息。

請只回傳 JSON，不要加說明。

欄位：
{
  "is_dispatch": true 或 false,
  "customer": "客戶名稱",
  "scheduled_date": "預計清運日期或時間",
  "address": "位置或地址",
  "waste_type": "垃圾/木材/混合物/其他",
  "vehicle": "車輛",
  "estimated_quantity": "預估數量",
  "unit": "噸/kg/桶/車/米/其他",
  "unit_price": "單價",
  "note": "備註"
}

規則：
- 今天時間：${today}
- 垃圾預設單價：9元/kg
- 木材預設單價：5元/kg
- 3.5噸舉斗車 = ARX-9260
- 7.5噸夾子車 = KEL-2628
- 壓縮車以垃圾子車桶數記錄
- 派工階段只能填預估數量，不要當作實際重量
- 不確定的欄位填空字串
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

  return JSON.parse(data.choices[0].message.content);
}

async function appendRows(env, sheetName, rows) {
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
    throw new Error(await res.text());
  }
}

async function getGoogleAccessToken(env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const sig = await signRs256(unsigned, sa.private_key);
  const jwt = `${unsigned}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.access_token;
}

async function verifyLineSignature(bodyText, secret, signature) {
  if (!secret || !signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
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
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;

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

function jsonResponse(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function base64UrlJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function signRs256(data, privateKeyPem) {
  const clean = privateKeyPem
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binary = Uint8Array.from(atob(clean), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binary.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(data)
  );

  return base64UrlEncode(sig);
}

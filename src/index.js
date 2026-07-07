// Fujin LINE AI Sheet v4.1
// LINE -> Cloudflare Worker -> Google Sheets, with optional OpenAI parsing.
//
// Phase 1 goal: never miss LINE intake records.
// Default behavior writes directly to AI派工, matching the current sheet layout.

const SHEET_INBOX = "00_LINE收件箱";
const SHEET_AI = "AI派工";
const SHEET_DISPATCH = "01_派工紀錄";

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "Fujin LINE AI Sheet",
        version: "v4.1",
        message: "Webhook is running"
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const bodyText = await request.text();

    try {
      const signatureOk = await verifyRequestLineSignature(request, env, bodyText);
      if (!signatureOk) {
        return new Response("Unauthorized", { status: 401 });
      }

      const payload = JSON.parse(bodyText || "{}");
      const events = Array.isArray(payload.events) ? payload.events : [];
      const now = nowTaiwanIso();

      for (const event of events) {
        const normalized = normalizeLineEvent(event, now);

        if (!normalized.shouldRecord) {
          continue;
        }

        if (env.RECORD_RAW_INBOX === "true") {
          await appendRows(env, SHEET_INBOX, [inboxRow(normalized)]);
        }

        if (normalized.messageType === "text") {
          await maybeParseAndCreateDispatch(env, event, normalized);
        } else {
          await appendRows(env, SHEET_AI, [aiPendingRow(normalized, "待人工確認")]);
        }
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      const msg = String(err && err.stack ? err.stack : err).slice(0, 1200);
      console.log("ERROR", msg);
      await tryReplyFirstEvent(env, bodyText, "系統錯誤，原始訊息可能未完成寫入：\n" + msg);
      return new Response("OK", { status: 200 });
    }
  }
};

async function maybeParseAndCreateDispatch(env, event, normalized) {
  if (env.ENABLE_AI !== "true") {
    await appendRows(env, SHEET_AI, [aiPendingRow(normalized, "待判讀")]);
    return;
  }

  let ai;
  try {
    ai = await parseDispatchWithAI(normalized.text, env);
  } catch (err) {
    console.log("OPENAI_PARSE_ERROR", String(err && err.stack ? err.stack : err));
    await appendRows(env, SHEET_AI, [aiPendingRow(normalized, "AI判讀失敗")]);
    return;
  }

  await appendRows(env, SHEET_AI, [aiDispatchRow(normalized, ai)]);

  if (!ai.is_dispatch) {
    return;
  }

  if (env.CREATE_DISPATCH_ON_AI !== "true") {
    await replyLine(env, event.replyToken, buildAiReceivedReply(ai, null));
    return;
  }

  const dispatchId = makeDispatchId(normalized);
  await appendRows(env, SHEET_DISPATCH, [[
    dispatchId,
    normalized.receivedAt,
    ai.scheduled_date || "",
    ai.customer || "",
    ai.waste_type || "",
    ai.address || "",
    ai.vehicle || "",
    ai.estimated_quantity || "",
    ai.unit || "",
    "待派工",
    ai.note || "",
    normalized.sourceType || "",
    normalized.userId || "",
    normalized.groupId || "",
    normalized.messageId || ""
  ]]);

  await replyLine(env, event.replyToken, buildAiReceivedReply(ai, dispatchId));
}

function normalizeLineEvent(event, receivedAt) {
  const source = event.source || {};
  const message = event.message || {};
  const messageType = message.type || "";

  return {
    shouldRecord: event.type === "message",
    receivedAt,
    eventType: event.type || "",
    webhookEventId: event.webhookEventId || "",
    replyToken: event.replyToken || "",
    lineTimestamp: event.timestamp || "",
    sourceType: source.type || "",
    groupId: source.groupId || "",
    roomId: source.roomId || "",
    userId: source.userId || "",
    messageType,
    messageId: message.id || "",
    text: messageType === "text" ? message.text || "" : "",
    fileName: message.fileName || "",
    fileSize: message.fileSize || "",
    dispatchIdHint: findDispatchId(message.text || ""),
    raw: event
  };
}

function inboxRow(item) {
  return [
    item.receivedAt,
    item.eventType,
    item.messageType,
    item.text,
    item.dispatchIdHint,
    item.fileName,
    item.fileSize,
    item.messageId,
    item.webhookEventId,
    item.sourceType,
    item.groupId,
    item.roomId,
    item.userId,
    "received",
    "",
    JSON.stringify(item.raw)
  ];
}

function aiPendingRow(item, status) {
  return [
    item.receivedAt,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    status,
    originalMessageText(item)
  ];
}

function aiDispatchRow(item, ai) {
  return [
    item.receivedAt,
    ai.customer || "",
    ai.scheduled_date || "",
    ai.address || "",
    ai.waste_type || "",
    ai.vehicle || "",
    ai.estimated_quantity || "",
    ai.unit_price || "",
    ai.is_dispatch ? "待派工" : "非叫車",
    item.text || ""
  ];
}

function originalMessageText(item) {
  if (item.messageType === "text") {
    return item.text || "";
  }

  const parts = [`[${item.messageType || "message"}]`];
  if (item.fileName) parts.push(item.fileName);
  if (item.messageId) parts.push(`message_id=${item.messageId}`);
  if (item.groupId) parts.push(`group_id=${item.groupId}`);
  return parts.join(" ");
}

async function parseDispatchWithAI(message, env) {
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const today = nowTaiwanIso();
  const schema = {
    name: "dispatch_intake",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        is_dispatch: { type: "boolean" },
        customer: { type: "string" },
        scheduled_date: { type: "string" },
        address: { type: "string" },
        waste_type: { type: "string" },
        vehicle: { type: "string" },
        estimated_quantity: { type: "string" },
        unit: { type: "string" },
        unit_price: { type: "string" },
        note: { type: "string" },
        missing_fields: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: [
        "is_dispatch",
        "customer",
        "scheduled_date",
        "address",
        "waste_type",
        "vehicle",
        "estimated_quantity",
        "unit",
        "unit_price",
        "note",
        "missing_fields"
      ]
    }
  };

  const prompt = `
你是福進環保有限公司的辦公室派工助理。

請判斷 LINE 訊息是否為叫車、清運、派工相關訊息，並整理成固定欄位。

規則：
- 今天時間：${today}
- 第一階段以避免漏單為主；只要可能是叫車或清運需求，is_dispatch 就填 true。
- 派工階段只記錄預估，不是實際重量。
- 垃圾預設單價：9
- 木材預設單價：5
- 3.5噸、9260、舉斗車 -> vehicle 填 ARX-9260
- 7.5噸、2628、夾子車 -> vehicle 填 KEL-2628
- 17噸夾子車若未給車號，vehicle 填 17噸夾子車
- 壓縮車以垃圾子車桶數記錄
- 垃圾、一般垃圾 -> waste_type 填 垃圾
- 木材、板模、廢木 -> waste_type 填 木材
- 混合物 -> waste_type 填 混合物
- 不確定欄位填空字串，並把欄位名稱放入 missing_fields
`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.5-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: prompt }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: message }]
        }
      ],
      text: { format: schema }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error("OpenAI error: " + JSON.stringify(data));
  }

  const content = data.output_text || extractResponseText(data);
  if (!content) throw new Error("OpenAI response empty");
  return JSON.parse(content);
}

function extractResponseText(data) {
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part.type === "output_text" && part.text) return part.text;
    }
  }
  return "";
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
    console.log("GOOGLE_ERROR", sheetName, res.status, text);
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

async function verifyRequestLineSignature(request, env, bodyText) {
  if (!env.LINE_CHANNEL_SECRET) {
    return true;
  }

  const signature = request.headers.get("x-line-signature") || "";
  return verifyLineSignature(bodyText, env.LINE_CHANNEL_SECRET, signature);
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
  if (env.REPLY_MODE === "silent") return;

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

async function tryReplyFirstEvent(env, bodyText, text) {
  try {
    const payload = JSON.parse(bodyText || "{}");
    const event = payload.events && payload.events[0];
    if (event && event.replyToken) {
      await replyLine(env, event.replyToken, text);
    }
  } catch (_) {
  }
}

function buildAiReceivedReply(ai, dispatchId) {
  return `✅ 已收到叫車資料

${dispatchId ? `派工編號：${dispatchId}\n` : ""}客戶：${ai.customer || "未判斷"}
日期：${ai.scheduled_date || "未填"}
種類：${ai.waste_type || "未填"}
位置：${ai.address || "未填"}
車輛：${ai.vehicle || "未填"}
預估：${ai.estimated_quantity || "未填"}
單價：${ai.unit_price || "未填"}`;
}

function findDispatchId(text) {
  const match = String(text || "").match(/\b(?:FJ|D)\d{8}[-\w]*\b/i);
  return match ? match[0].toUpperCase() : "";
}

function makeDispatchId(item) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const source = item.messageId || item.webhookEventId || String(Date.now());
  const suffix = source.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase().padStart(6, "0");
  return `D${y}${m}${day}-${suffix}`;
}

function nowTaiwanIso() {
  const text = new Date().toLocaleString("sv-SE", {
    timeZone: "Asia/Taipei",
    hour12: false
  });
  return text.replace(" ", "T") + "+08:00";
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
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

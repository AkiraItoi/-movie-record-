/* 映画鑑賞記録 — Notion API 中継（Vercel Serverless Function）
 *
 * 役割：ブラウザ（PWA）から直接呼べない Notion API へのリクエストを中継する。
 * 受け口はこの1つだけ（POST /api/notion）。リクエストJSONの action で振り分ける。
 *
 *   { action: "create", token, payload: { database_id, properties } }
 *       … Notion にページを作成する
 *   { action: "update", token, pageId, payload: { properties } }
 *       … 既存ページを更新する（投稿状態の反映など）
 *   { action: "test",   token, payload: { database_id } }
 *       … 接続テスト（データベース情報を取得する）
 *
 * - ユーザーの Notion 連携トークンは、リクエストごとに受け取って
 *   Notion へ転送するだけ。Vercel 側には一切保存しない。
 * - 保存する秘密情報はゼロ。環境変数・DB・ストレージは使わない。
 */

const NOTION_VERSION = "2022-06-28";
const NOTION_API_BASE = "https://api.notion.com/v1";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, obj) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

/* Vercel は通常 req.body をパース済みで渡すが、環境によっては
   文字列や未パースの場合があるため、両対応にする。 */
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
    }
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { return {}; }
}

async function notionRequest(token, method, path, body) {
  const res = await fetch(NOTION_API_BASE + path, {
    method,
    headers: {
      "Authorization": "Bearer " + token,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { message: text }; }
  return { status: res.status, data };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "POSTで送信してください" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    sendJson(res, 400, { message: "リクエストの読み取りに失敗しました" });
    return;
  }

  const action = body.action;
  const token = body.token;
  const payload = body.payload || {};

  if (!token) {
    sendJson(res, 401, { message: "Notion連携トークンが送られていません（PWAの設定を確認してください）" });
    return;
  }

  try {
    // ページ作成
    if (action === "create") {
      if (!payload.database_id) {
        sendJson(res, 400, { message: "database_id がありません" });
        return;
      }
      const result = await notionRequest(token, "POST", "/pages", {
        parent: { database_id: payload.database_id },
        properties: payload.properties || {}
      });
      sendJson(res, result.status, result.data);
      return;
    }

    // ページ更新（投稿状態など）
    if (action === "update") {
      const pageId = body.pageId;
      if (!pageId || !/^[0-9a-fA-F-]{32,36}$/.test(pageId)) {
        sendJson(res, 400, { message: "pageId が正しくありません" });
        return;
      }
      const result = await notionRequest(token, "PATCH", "/pages/" + pageId, {
        properties: payload.properties || {}
      });
      sendJson(res, result.status, result.data);
      return;
    }

    // 接続テスト
    if (action === "test") {
      if (!payload.database_id) {
        sendJson(res, 400, { message: "database_id がありません" });
        return;
      }
      const result = await notionRequest(token, "GET", "/databases/" + payload.database_id, null);
      sendJson(res, result.status, result.data);
      return;
    }

    sendJson(res, 400, { message: "不明な action です: " + String(action || "") });
  } catch (e) {
    sendJson(res, 500, { message: "中継側でエラーが発生しました: " + (e && e.message ? e.message : String(e)) });
  }
};

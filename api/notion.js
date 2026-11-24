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
 *   { action: "list",   token, payload: { database_id } }
 *       … 記録の一覧を取得する（Notion → アプリの読み込み・端末間同期用）
 *
 * - ユーザーの Notion 連携トークンは、リクエストごとに受け取って
 *   Notion へ転送するだけ。Vercel 側には一切保存しない。
 * - 保存する秘密情報はゼロ。環境変数・DB・ストレージは使わない。
 */

const NOTION_VERSION = "2025-09-03";
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

/* Notion のページ（行）を、アプリの記録データ形式に変換する */
function richTextToString(v) {
  return (Array.isArray(v) ? v : []).map((t) => (t && t.plain_text) || "").join("");
}
function pageToRecord(page) {
  const p = (page && page.properties) || {};
  const num = (v) => (typeof v === "number" ? v : null);
  const data = {
    category: ((p["カテゴリ"] || {}).select || {}).name || "映画",
    tmdbId: num((p["TMDB ID"] || {}).number),
    title: richTextToString((p["作品名"] || {}).title),
    originalTitle: richTextToString((p["原題"] || {}).rich_text),
    director: richTextToString((p["監督"] || {}).rich_text),
    year: num((p["公開年"] || {}).number) != null ? String(num((p["公開年"] || {}).number)) : "",
    castText: richTextToString((p["出演者"] || {}).rich_text),
    genres: (((p["ジャンル"] || {}).multi_select) || []).map((g) => g.name).filter(Boolean),
    theme: richTextToString((p["一般的なテーマ"] || {}).rich_text),
    letterboxdUrl: (p["Letterboxd URL"] || {}).url || "",
    posterUrl: (p["ポスター画像URL"] || {}).url || "",
    watchDate: ((p["鑑賞日"] || {}).date || {}).start || "",
    rating: num((p["評価"] || {}).number) != null ? String(num((p["評価"] || {}).number)) : "",
    myTheme: richTextToString((p["私が感じた一言テーマ"] || {}).rich_text),
    scene: richTextToString((p["印象に残った場面"] || {}).rich_text),
    deep: richTextToString((p["深掘り感想・キーワード"] || {}).rich_text),
    connection: richTextToString((p["仕事・人生との接点"] || {}).rich_text),
    rewatch: ((p["再鑑賞したいか"] || {}).select || {}).name || ""
  };
  return {
    notionPageId: page.id,
    savedAt: page.created_time || "",
    postState: ((p["投稿状態"] || {}).select || {}).name || "未承認",
    data
  };
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

  /* 新方式のデータベースは「データソース」を持つため、ページ作成時は
     database_id からデータソースIDを解決して parent に使う。
     （database_id を直接 parent にすると validation error になる） */
  async function resolveDataSourceId(databaseId) {
    const db = await notionRequest(token, "GET", "/databases/" + databaseId, null);
    if (db.status !== 200) return { error: db };
    const sources = (db.data && db.data.data_sources) || [];
    if (!sources.length || !sources[0].id) {
      return { error: { status: 502, data: { message: "データベースからデータソースを取得できませんでした" } } };
    }
    return { dataSourceId: sources[0].id };
  }

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
      const resolved = await resolveDataSourceId(payload.database_id);
      if (resolved.error) {
        sendJson(res, resolved.error.status, resolved.error.data);
        return;
      }
      const result = await notionRequest(token, "POST", "/pages", {
        parent: { data_source_id: resolved.dataSourceId },
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

    // 記録一覧の取得（新しい順に最大100件）
    if (action === "list") {
      if (!payload.database_id) {
        sendJson(res, 400, { message: "database_id がありません" });
        return;
      }
      const resolved = await resolveDataSourceId(payload.database_id);
      if (resolved.error) {
        sendJson(res, resolved.error.status, resolved.error.data);
        return;
      }
      const result = await notionRequest(token, "POST", "/data_sources/" + resolved.dataSourceId + "/query", {
        page_size: 100,
        sorts: [{ timestamp: "created_time", direction: "descending" }]
      });
      if (result.status !== 200) {
        sendJson(res, result.status, result.data);
        return;
      }
      const rows = ((result.data && result.data.results) || [])
        .filter((pg) => pg && pg.object === "page" && !pg.in_trash)
        .map(pageToRecord);
      sendJson(res, 200, { results: rows });
      return;
    }

    sendJson(res, 400, { message: "不明な action です: " + String(action || "") });
  } catch (e) {
    sendJson(res, 500, { message: "中継側でエラーが発生しました: " + (e && e.message ? e.message : String(e)) });
  }
};

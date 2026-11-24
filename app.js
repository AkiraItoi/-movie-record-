"use strict";
/* 映画鑑賞記録（独立PWA版）
   - キー類はこの端末の localStorage にのみ保存し、画面に再表示しない。
   - 下書きは入力のたびに localStorage へ自動保存する。保存キーは版数に依存させない
     （アプリを更新しても下書きが消えないようにするため）。 */

const SETTINGS_KEY = "movieRecord.settings";
const DRAFT_KEY = "movieRecord.draft";
const RECORDS_KEY = "movieRecord.records";
const DEFAULT_NOTION_DB_ID = "421900d8-e82c-8145-a27b-e9be1ee60b32";
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

const ALL_GENRES = ["アクション","アドベンチャー","アニメーション","コメディ","犯罪","ドキュメンタリー","ドラマ","ファミリー","ファンタジー","歴史","ホラー","音楽","ミステリー","ロマンス","SF","スリラー","戦争","西部劇"];
const REWATCH_OPTIONS = ["ぜひ再鑑賞したい", "機会があれば", "再鑑賞はしない"];
const POST_STATES = ["未承認", "投稿済み", "一部投稿済み", "投稿失敗"];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 容量超過などは無視 */ }
}
function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ===== 設定 ===== */
let settings = Object.assign(
  { tmdbKey: "", geminiKey: "", notionToken: "", notionDbId: DEFAULT_NOTION_DB_ID, relayUrl: "" },
  loadJSON(SETTINGS_KEY, {})
);
// 旧構成（Cloudflare Worker）の設定が残っていたら、中継URLとして引き継ぐ
if (!settings.relayUrl && settings.workerUrl) settings.relayUrl = settings.workerUrl;
delete settings.workerUrl;
function persistSettings() { saveJSON(SETTINGS_KEY, settings); }

/* ===== 記録キャッシュ（端末内） ===== */
let records = loadJSON(RECORDS_KEY, []);
function persistRecords() { saveJSON(RECORDS_KEY, records); }

/* 同じ映画の記録が複数できていたら、内容の多い方に寄せて1件にまとめる */
function recordRichness(r) {
  const d = (r && r.data) || {};
  return ["watchDate", "rating", "myTheme", "scene", "deep", "short", "connection", "theme"].filter((k) => (d[k] || "") !== "").length;
}
function dedupeRecords() {
  const byKey = new Map();
  let changed = false;
  for (const r of records) {
    const d = r.data || {};
    const key = d.tmdbId ? "tmdb:" + d.tmdbId : "title:" + (d.title || "") + "|" + (d.year || "");
    if (!key || key === "title:|") continue;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, r); continue; }
    changed = true;
    const keep = recordRichness(r) > recordRichness(prev) ? r : prev;
    const drop = keep === r ? prev : r;
    if (!keep.notionPageId && drop.notionPageId) keep.notionPageId = drop.notionPageId;
    byKey.set(key, keep);
  }
  if (changed) {
    records = Array.from(byKey.values());
    persistRecords();
  }
}
dedupeRecords();

/* ===== 画面遷移 ===== */
const VIEWS = ["list", "search", "form", "confirm", "post", "detail", "settings"];
function showView(name) {
  VIEWS.forEach((v) => { $("#view-" + v).hidden = v !== name; });
  if (name === "list") renderList();
  if (name === "settings") renderSettings();
  window.scrollTo(0, 0);
}
$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.nav));
});

/* ===== フォーム状態 ===== */
function emptyForm() {
  return {
    mode: "auto",           // "auto" | "manual"
    tmdbId: null,
    title: "", originalTitle: "", director: "", year: "",
    castText: "", genres: [], theme: "", letterboxdUrl: "", posterUrl: "",
    overview: "",
    watchDate: "", rating: "", myTheme: "", scene: "",
    deep: "", short: "", connection: "", rewatch: ""
  };
}
let form = emptyForm();
let draftRestored = false;

function collectFormFromDOM() {
  form.title = $("#f-title").value.trim();
  form.originalTitle = $("#f-original-title").value.trim();
  form.director = $("#f-director").value.trim();
  form.year = $("#f-year").value.trim();
  form.castText = $("#f-cast").value;
  form.theme = $("#f-theme").value;
  form.letterboxdUrl = $("#f-letterboxd").value.trim();
  form.posterUrl = $("#f-poster-url").value.trim();
  form.watchDate = $("#f-watch-date").value;
  form.rating = $("#f-rating").value;
  form.myTheme = $("#f-my-theme").value;
  form.scene = $("#f-scene").value;
  form.deep = $("#f-deep").value;
  form.short = $("#f-short").value;
  form.connection = $("#f-connection").value;
  const rw = document.querySelector('input[name="rewatch"]:checked');
  form.rewatch = rw ? rw.value : "";
  return form;
}

function applyFormToDOM() {
  $("#f-title").value = form.title || "";
  $("#f-original-title").value = form.originalTitle || "";
  $("#f-director").value = form.director || "";
  $("#f-year").value = form.year || "";
  $("#f-cast").value = form.castText || "";
  $("#f-theme").value = form.theme || "";
  $("#f-letterboxd").value = form.letterboxdUrl || "";
  $("#f-poster-url").value = form.posterUrl || "";
  $("#f-watch-date").value = form.watchDate || "";
  $("#f-rating").value = form.rating || "";
  $("#f-my-theme").value = form.myTheme || "";
  $("#f-scene").value = form.scene || "";
  $("#f-deep").value = form.deep || "";
  $("#f-short").value = form.short || "";
  $("#f-connection").value = form.connection || "";
  $$('input[name="rewatch"]').forEach((r) => { r.checked = r.value === form.rewatch; });
  renderGenreChips();
  updatePosterPreview();
  updateSummarizeButton();
}

function renderGenreChips() {
  const wrap = $("#f-genres");
  wrap.innerHTML = "";
  ALL_GENRES.forEach((g) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (form.genres.includes(g) ? " on" : "");
    b.textContent = g;
    b.addEventListener("click", () => {
      if (form.genres.includes(g)) form.genres = form.genres.filter((x) => x !== g);
      else form.genres.push(g);
      renderGenreChips();
      saveDraft();
    });
    wrap.appendChild(b);
  });
}

function updatePosterPreview() {
  const img = $("#f-poster");
  if (form.posterUrl) { img.src = form.posterUrl; img.hidden = false; }
  else { img.hidden = true; img.removeAttribute("src"); }
}

/* ===== 下書き保存（最重要） ===== */
function saveDraft() {
  collectFormFromDOM();
  // データ消失防止：感想が入った下書きを、同じ作品の「感想が空の画面」で上書きしない。
  // 空の画面が表示されても、感想だけは前回の下書きから引き継いで保持する。
  const prev = loadJSON(DRAFT_KEY, null);
  if (prev && prev.form) {
    const imp = ["myTheme", "scene", "deep", "short", "connection"];
    const prevHas = imp.some((k) => (prev.form[k] || "").trim() !== "");
    const nowHas = imp.some((k) => (form[k] || "").trim() !== "");
    const sameFilm = (prev.form.tmdbId && form.tmdbId && prev.form.tmdbId === form.tmdbId) ||
      (prev.form.title && form.title && prev.form.title === form.title);
    if (prevHas && !nowHas && sameFilm) {
      imp.forEach((k) => { form[k] = prev.form[k]; });
    }
  }
  saveJSON(DRAFT_KEY, { form: form, savedAt: Date.now() });
}
function loadDraft() {
  const d = loadJSON(DRAFT_KEY, null);
  if (!d || !d.form) return false;
  const f = d.form;
  const hasContent = ["title","director","myTheme","scene","deep","short","connection"].some((k) => (f[k] || "").trim() !== "");
  if (!hasContent) return false;
  form = Object.assign(emptyForm(), f);
  return true;
}
function clearDraft() { localStorage.removeItem(DRAFT_KEY); }

$("#view-form").addEventListener("input", saveDraft);
$("#view-form").addEventListener("change", saveDraft);
$("#f-poster-url").addEventListener("input", () => { form.posterUrl = $("#f-poster-url").value.trim(); updatePosterPreview(); });

$("#btn-discard-draft").addEventListener("click", () => {
  clearDraft();
  form = emptyForm();
  draftRestored = false;
  $("#draft-banner").hidden = true;
  applyFormToDOM();
  $("#form-status").textContent = "下書きを破棄しました。";
});

/* ===== 一覧・詳細 ===== */
function renderList() {
  const wrap = $("#record-list");
  wrap.innerHTML = "";
  $("#list-empty").hidden = records.length > 0;
  records.slice().reverse().forEach((rec) => {
    const d = rec.data;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "record-card";
    b.innerHTML =
      (d.posterUrl ? `<img src="${esc(d.posterUrl)}" alt="">` : `<img alt="">`) +
      `<span><span class="rec-title">${esc(d.title) || "（無題）"}</span>` +
      `<span class="rec-meta">　${esc(d.year || "")}年／${esc(d.director || "")}</span><br>` +
      `<span class="rec-meta">鑑賞日：${esc(d.watchDate || "未入力")}　評価：${esc(d.rating || "未入力")}</span><br>` +
      `<span class="rec-state">投稿状態：${esc(rec.postState || "未承認")}</span></span>`;
    b.addEventListener("click", () => openDetail(rec.id));
    wrap.appendChild(b);
  });
}

let currentRecordId = null;
function getCurrentRecord() { return records.find((r) => r.id === currentRecordId) || null; }

function openDetail(id) {
  currentRecordId = id;
  const rec = getCurrentRecord();
  if (!rec) { showView("list"); return; }
  const d = rec.data;
  const rows = [
    ["作品名", d.title], ["原題", d.originalTitle], ["監督", d.director], ["公開年", d.year],
    ["出演者", d.castText], ["ジャンル", (d.genres || []).join("・")], ["一般的なテーマ", d.theme],
    ["Letterboxd URL", d.letterboxdUrl], ["鑑賞日", d.watchDate], ["評価", d.rating],
    ["私が感じた一言テーマ", d.myTheme], ["印象に残った場面", d.scene],
    ["短い感想", d.short], ["深掘り感想・キーワード", d.deep],
    ["仕事・人生との接点", d.connection], ["再鑑賞したいか", d.rewatch],
    ["投稿状態", rec.postState || "未承認"],
    ["Notion", rec.notionPageId ? "保存済み" : "未保存"]
  ];
  $("#detail-body").innerHTML =
    (d.posterUrl ? `<p><img src="${esc(d.posterUrl)}" alt="ポスター" style="width:110px;border-radius:8px"></p>` : "") +
    "<dl>" + rows.filter((r) => r[1]).map((r) => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join("") + "</dl>";
  showView("detail");
}
$("#btn-detail-back").addEventListener("click", () => showView("list"));
$("#btn-detail-post").addEventListener("click", () => {
  const rec = getCurrentRecord();
  if (rec) openPostView(rec);
});
$("#btn-detail-delete").addEventListener("click", () => {
  records = records.filter((r) => r.id !== currentRecordId);
  persistRecords();
  currentRecordId = null;
  showView("list");
});

/* ===== TMDB ===== */
async function tmdbFetch(path) {
  if (!settings.tmdbKey) throw new Error("TMDB APIキーが設定されていません。設定画面で保存してください。");
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.themoviedb.org/3${path}${sep}api_key=${encodeURIComponent(settings.tmdbKey)}`);
  if (res.status === 401) throw new Error("TMDB APIキーが無効です。設定画面で確認してください。");
  if (!res.ok) throw new Error(`TMDBへの問い合わせに失敗しました（${res.status}）`);
  return res.json();
}

let searchResults = [];
let selectedMovieId = null;

$("#search-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = $("#search-input").value.trim();
  const status = $("#search-status");
  const list = $("#candidate-list");
  list.innerHTML = "";
  $("#search-actions").hidden = true;
  selectedMovieId = null;
  if (!q) { status.textContent = "作品名を入力してください。"; return; }
  status.textContent = "検索中…";
  status.classList.remove("error");
  try {
    const data = await tmdbFetch(`/search/movie?query=${encodeURIComponent(q)}&language=ja-JP&include_adult=false`);
    searchResults = (data.results || []).filter((r) => r.title || r.original_title);
    if (searchResults.length === 0) {
      status.textContent = "見つかりませんでした。表記を変えて試すか、手入力で記録できます。";
      return;
    }
    status.textContent = `${searchResults.length}件見つかりました。作品を選んでください。`;
    searchResults.forEach((r) => {
      const year = (r.release_date || "").slice(0, 4);
      const poster = r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : "";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "candidate";
      b.dataset.id = r.id;
      b.innerHTML =
        (poster ? `<img src="${esc(poster)}" alt="">` : `<img alt="">`) +
        `<span><span class="cand-title">${esc(r.title || r.original_title)}</span><br>` +
        `<span class="cand-meta">${esc(year)}年／原題：${esc(r.original_title || "")}</span></span>` +
        `<span class="cand-badge" hidden>選択中</span>`;
      b.addEventListener("click", () => selectCandidate(r.id));
      list.appendChild(b);
    });
  } catch (e) {
    status.textContent = e.message;
    status.classList.add("error");
  }
});

function selectCandidate(id) {
  selectedMovieId = id;
  $$("#candidate-list .candidate").forEach((el) => {
    const on = Number(el.dataset.id) === id;
    el.classList.toggle("selected", on);
    el.querySelector(".cand-badge").hidden = !on;
  });
  $("#search-actions").hidden = false;
  $("#btn-use-selected").disabled = false;
}

$("#btn-use-selected").addEventListener("click", async () => {
  if (!selectedMovieId) return;
  const status = $("#search-status");
  status.classList.remove("error");
  status.textContent = "作品情報を取得中…";
  try {
    await loadDetailsIntoForm(selectedMovieId);
    status.textContent = "";
    showView("form");
  } catch (e) {
    status.textContent = e.message;
    status.classList.add("error");
  }
});

$("#btn-manual").addEventListener("click", () => {
  // 感想の下書きが残っている場合は引き継ぎ、作品情報だけ空にする
  const kept = { deep: form.deep, short: form.short, myTheme: form.myTheme, scene: form.scene, connection: form.connection, watchDate: form.watchDate, rating: form.rating, rewatch: form.rewatch };
  form = Object.assign(emptyForm(), kept, { mode: "manual" });
  draftRestored = false;
  $("#draft-banner").hidden = true;
  applyFormToDOM();
  saveDraft();
  showView("form");
});
$("#btn-form-back").addEventListener("click", () => showView("search"));

function letterboxdSlug(originalTitle) {
  const s = (originalTitle || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s ? `https://letterboxd.com/film/${s}/` : "";
}

async function loadDetailsIntoForm(tmdbId) {
  const d = await tmdbFetch(`/movie/${tmdbId}?language=ja-JP&append_to_response=credits`);
  const kept = { deep: form.deep, short: form.short, myTheme: form.myTheme, scene: form.scene, connection: form.connection, watchDate: form.watchDate, rating: form.rating, rewatch: form.rewatch };
  const director = ((d.credits && d.credits.crew) || []).filter((c) => c.job === "Director").map((c) => c.name).join("、");
  const castRaw = ((d.credits && d.credits.cast) || []).slice(0, 6).map((c) => ({ name: c.name, character: c.character || "" }));
  const genres = (d.genres || []).map((g) => g.name).filter((g) => ALL_GENRES.includes(g));

  form = Object.assign(emptyForm(), kept, {
    mode: "auto",
    tmdbId: d.id,
    title: d.title || "",
    originalTitle: d.original_title || "",
    director: director,
    year: (d.release_date || "").slice(0, 4),
    genres: genres,
    posterUrl: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : "",
    letterboxdUrl: letterboxdSlug(d.original_title || d.title),
    overview: d.overview || ""
  });

  // 出演者（氏名（役名））。日本映画はTMDBが役名をローマ字で返すため、Geminiで日本語化する。
  const isJapanese = d.original_language === "ja";
  if (isJapanese && settings.geminiKey && castRaw.some((c) => c.character)) {
    try {
      const converted = await convertCastCharacters(form.title, castRaw);
      form.castText = castRaw.map((c, i) => `${c.name}（${converted[i] || c.character}）`).join("\n");
    } catch (e) {
      // 変換に失敗した場合はローマ字のまま出さず、役名は空欄にする
      form.castText = castRaw.map((c) => `${c.name}（）`).join("\n");
    }
  } else if (isJapanese) {
    // AIキーが無い場合はローマ字のまま出さず、役名は空欄にして手入力を促す
    form.castText = castRaw.map((c) => `${c.name}（）`).join("\n");
  } else {
    form.castText = castRaw.map((c) => (c.character ? `${c.name}（${c.character}）` : c.name)).join("\n");
  }

  // 一般的なテーマ（AI生成）
  if (settings.geminiKey) {
    try { form.theme = await generateTheme(form); } catch (e) { form.theme = ""; }
  }

  draftRestored = false;
  $("#draft-banner").hidden = true;
  applyFormToDOM();
  saveDraft();
}

/* ===== Gemini ===== */
async function callGemini(prompt) {
  if (!settings.geminiKey) throw new Error("Gemini APIキーが設定されていません。");
  // モデルが廃止されている場合（404）は次の候補モデルで再試行する
  let lastStatus = 0;
  for (const model of GEMINI_MODELS) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": settings.geminiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (res.ok) {
      const data = await res.json();
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      return parts.map((p) => p.text || "").join("").trim();
    }
    lastStatus = res.status;
    if (res.status !== 404) break;
  }
  throw new Error(`AIへの問い合わせに失敗しました（${lastStatus}）`);
}

async function convertCastCharacters(title, castRaw) {
  const list = castRaw.map((c, i) => `${i + 1}. ${c.name} … ${c.character}`).join("\n");
  const prompt =
    `映画『${title}』の出演者と、その役名（英語・ローマ字表記）です。\n${list}\n\n` +
    "各役名を日本語表記に直してください。実在の人物・役名として漢字が特定できる場合は漢字で、特定できない場合はカタカナの読みで書いてください。\n" +
    "出力はJSON配列だけにしてください。例：[\"敷島浩一\",\"大石典子\"] のように、役名だけを同じ順番で並べた配列です。説明文は一切付けないでください。";
  const text = await callGemini(prompt);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("parse");
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error("parse");
  return arr.map((x) => String(x || ""));
}

async function generateTheme(f) {
  const prompt =
    `映画『${f.title}』（原題：${f.originalTitle}、${f.year}年、ジャンル：${(f.genres || []).join("・")}）について、一般的に語られるテーマや見どころを、日本語で2文以内で簡潔に書いてください。あらすじ：${f.overview || "（情報なし）"}\n` +
    "特定の個人の感想ではなく、その作品一般のテーマとして書いてください。見出しや箇条書きは付けず、本文だけを返してください。";
  return callGemini(prompt);
}

async function summarizeDeep(deepText) {
  const prompt =
    "以下は、ある映画を観た本人が書いた感想メモです。この内容だけをもとに、約120字の短い感想文に要約してください。書かれていない内容は創作しないでください。本人の言い回しや大事にしている点はなるべく残してください。要約文だけを返してください。\n\n" +
    deepText;
  return callGemini(prompt);
}

function updateSummarizeButton() {
  const btn = $("#btn-summarize");
  const hasDeep = ($("#f-deep").value || "").trim().length > 0;
  btn.disabled = !hasDeep;
  btn.textContent = ($("#f-short").value || "").trim() ? "AIで要約し直す" : "AIで要約する";
}
$("#f-deep").addEventListener("input", updateSummarizeButton);
$("#f-short").addEventListener("input", updateSummarizeButton);

$("#btn-summarize").addEventListener("click", async () => {
  const status = $("#summarize-status");
  const deep = $("#f-deep").value.trim();
  if (!deep) { status.textContent = "先に深掘り用感想・キーワードを書いてください。"; return; }
  if (!settings.geminiKey) { status.textContent = "AI要約にはGemini APIキーが必要です（設定画面）。短い感想は手入力でも使えます。"; return; }
  status.textContent = "要約中…";
  try {
    const summary = await summarizeDeep(deep);
    $("#f-short").value = summary;
    form.short = summary;
    saveDraft();
    updateSummarizeButton();
    status.textContent = "要約しました。手直しもできます。";
  } catch (e) {
    status.textContent = "要約に失敗しました：" + e.message;
  }
});

$("#btn-regen-theme").addEventListener("click", async () => {
  const status = $("#form-status");
  if (!settings.geminiKey) { status.textContent = "テーマのAI生成にはGemini APIキーが必要です（設定画面）。手入力でも使えます。"; return; }
  status.textContent = "テーマを生成中…";
  try {
    collectFormFromDOM();
    form.theme = await generateTheme(form);
    $("#f-theme").value = form.theme;
    saveDraft();
    status.textContent = "テーマを作り直しました。";
  } catch (e) {
    status.textContent = "テーマ生成に失敗しました：" + e.message;
  }
});

/* ===== 保存確認・Notion保存 ===== */
function formToRecordData() {
collectFormFromDOM();
return {
tmdbId: form.tmdbId, title: form.title, originalTitle: form.originalTitle,
director: form.director, year: form.year, castText: form.castText,
genres: form.genres.slice(), theme: form.theme, letterboxdUrl: form.letterboxdUrl,
posterUrl: form.posterUrl, watchDate: form.watchDate, rating: form.rating,
myTheme: form.myTheme, scene: form.scene, deep: form.deep, short: form.short,
connection: form.connection, rewatch: form.rewatch
};
}

$("#btn-to-confirm").addEventListener("click", async () => {
const status = $("#form-status");
collectFormFromDOM();
// テーマが空でAIキーがある場合は、確認画面に進む前に自動生成する
// （作品選択時にキーが未設定だったケースの救済）
if (!form.theme && settings.geminiKey && form.title) {
status.textContent = "テーマを生成中…"; status.classList.remove("error");
try {
form.theme = await generateTheme(form);
$("#f-theme").value = form.theme;
saveDraft();
} catch (e) { /* 生成できなくても保存フローは止めない */ }
}
const d = formToRecordData();
if (!d.title) { status.textContent = "作品名が空です。"; status.classList.add("error"); return;}
status.textContent = ""; status.classList.remove("error");
const rows = [
["作品名", d.title], ["原題", d.originalTitle], ["監督", d.director], ["公開年", d.year],
["出演者", d.castText], ["ジャンル", d.genres.join("・")], ["一般的なテーマ", d.theme],
["Letterboxd URL", d.letterboxdUrl], ["鑑賞日", d.watchDate], ["評価", d.rating],
["私が感じた一言テーマ", d.myTheme], ["印象に残った場面", d.scene],
["短い感想", d.short], ["深掘り感想・キーワード", d.deep],
["仕事・人生との接点", d.connection], ["再鑑賞したいか", d.rewatch]
];
$("#confirm-body").innerHTML = "<dl>" + rows.map((r) => `<dt>${esc(r[0])}</dt><dd>${esc(r[1] || "（未入力）")}</dd>`).join("") + "</dl>";
$("#confirm-status").textContent = "";
showView("confirm");
});
$("#btn-confirm-back").addEventListener("click", () => showView("form"));

function richText(content) {
const s = String(content || "");
if (!s) return [];
const chunks = [];
for (let i = 0; i < s.length; i += 2000) chunks.push(s.slice(i, i + 2000));
return chunks.map((c) => ({ type: "text", text: { content: c}}));
}

function buildNotionProperties(d, postState) {
const props = {};
props["作品名"] = { title: [{ type: "text", text: { content: d.title || "（無題）"}}]};
if (d.originalTitle) props["原題"] = { rich_text: richText(d.originalTitle)};
if (d.director) props["監督"] = { rich_text: richText(d.director)};
if (d.year &&!isNaN(Number(d.year))) props["公開年"] = { number: Number(d.year)};
if (d.castText) props["出演者"] = { rich_text: richText(d.castText)};
if (d.genres && d.genres.length) props["ジャンル"] = { multi_select: d.genres.map((g) => ({ name: g}))};
if (d.theme) props["一般的なテーマ"] = { rich_text: richText(d.theme)};
if (d.letterboxdUrl) props["Letterboxd URL"] = { url: d.letterboxdUrl};
if (d.posterUrl) props["ポスター画像URL"] = { url: d.posterUrl};
if (d.tmdbId) props["TMDB ID"] = { number: Number(d.tmdbId)};
props["記載日"] = { date: { start: todayStr()}};
if (d.watchDate) props["鑑賞日"] = { date: { start: d.watchDate}};
if (d.rating) props["評価"] = { number: Number(d.rating)};
if (d.myTheme) props["私が感じた一言テーマ"] = { rich_text: richText(d.myTheme)};
if (d.scene) props["印象に残った場面"] = { rich_text: richText(d.scene)};
if (d.short) props["短い感想"] = { rich_text: richText(d.short)};
if (d.deep) props["深掘り感想・キーワード"] = { rich_text: richText(d.deep)};
if (d.connection) props["仕事・人生との接点"] = { rich_text: richText(d.connection)};
if (d.rewatch && REWATCH_OPTIONS.includes(d.rewatch)) props["再鑑賞したいか"] = { select: { name: d.rewatch}};
props["投稿状態"] = { select: { name: POST_STATES.includes(postState)? postState: "未承認"}};
return props;
}

/* Notion中継（Vercel）へのリクエスト。受け口は1つで、actionで振り分ける。
   トークンはリクエストごとに送るだけで、中継側には保存されない。 */
async function relayRequest(action, payload, pageId) {
if (!settings.relayUrl) throw new Error("中継URL（Vercel）が設定されていません。設定画面で保存してください。");
if (!settings.notionToken) throw new Error("Notion連携トークンが設定されていません。設定画面で保存してください。");
const body = { action: action, token: settings.notionToken, payload: payload || {}};
if (pageId) body.pageId = pageId;
let res;
try {
res = await fetch(settings.relayUrl, {
method: "POST",
headers: { "Content-Type": "application/json"},
body: JSON.stringify(body)
});
} catch (e) {
throw new Error("中継（Vercel）に接続できませんでした。中継URLが正しいか確認してください。");
}
const data = await res.json().catch(() => ({}));
if (!res.ok) {
const msg = (data && data.message) || `Notionへの保存に失敗しました（${res.status}）`;
throw new Error(msg);
}
return data;
}

$("#btn-save-notion").addEventListener("click", async () => {
const status = $("#confirm-status");
const btn = $("#btn-save-notion");
const d = formToRecordData();
status.classList.remove("error");
status.textContent = "Notionに保存中…";
btn.disabled = true;
try {
// 同じ映画の記録が既にある場合は、新規作成せずその記録を更新する（二重登録防止）
const existing = d.tmdbId ? records.find((r) => r.data && r.data.tmdbId === d.tmdbId) : null;
let rec;
if (existing && existing.notionPageId) {
await relayRequest("update", { properties: buildNotionProperties(d, existing.postState || "未承認") }, existing.notionPageId);
existing.data = d;
existing.postText = buildPostText(d);
rec = existing;
} else {
const payload = { database_id: settings.notionDbId || DEFAULT_NOTION_DB_ID, properties: buildNotionProperties(d, "未承認")};
const page = await relayRequest("create", payload);
rec = {
id: "rec-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
notionPageId: page.id || "",
savedAt: new Date().toISOString(),
data: d,
postState: "未承認",
postText: ""
};
rec.postText = buildPostText(d);
if (existing) records = records.map((r) => (r === existing ? rec : r));
else records.push(rec);
}
persistRecords();
clearDraft();
form = emptyForm();
draftRestored = false;
$("#draft-banner").hidden = true;
status.textContent = "保存しました。";
openPostView(rec);
} catch (e) {
status.textContent = "保存に失敗しました：" + e.message + "（入力は下書きに残っています。そのまま再送できます）";
status.classList.add("error");
} finally {
btn.disabled = false;
}
});

/* ===== SNS投稿（半自動） ===== */
function buildPostText(d) {
const lines = [];
lines.push(`『${d.title}』${d.year? `（${d.year}）`: ""}`);
if (d.director) lines.push(`監督：${d.director}`);
if (d.myTheme) lines.push("", d.myTheme);
if (d.scene) lines.push("", "", d.scene);
if (d.connection) lines.push("", "", d.connection);
if (d.short) lines.push("", d.short);
const tags = (d.genres || []).map((g) => "#" + g.replace(/\s+/g, ""));
tags.push("#映画鑑賞記録");
lines.push("", tags.join(" "));
return lines.join("\n");
}

function xCharCount(text) {
const noUrl = text.replace(/https?:\/\/\S+/g, "U".repeat(23));
let count = 0;
for (const ch of noUrl) {
const cp = ch.codePointAt(0);
const wide = (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
(cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
(cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
(cp >= 0x20000 && cp <= 0x2fffd);
count += wide? 2: 1;
}
return count;
}

function updatePostCount() {
const n = xCharCount($("#post-text").value);
$("#post-count").textContent = n;
$("#post-warn").hidden = n <= 280;
}

function openPostView(rec) {
currentRecordId = rec.id;
if (!rec.postText) rec.postText = buildPostText(rec.data);
$("#post-text").value = rec.postText;
$("#post-state-select").value = rec.postState || "未承認";
$("#post-status").textContent = "";
updatePostCount();
showView("post");
}
$("#post-text").addEventListener("input", () => {
updatePostCount();
const rec = getCurrentRecord();
if (rec) { rec.postText = $("#post-text").value; persistRecords();}
});

$("#btn-share").addEventListener("click", async () => {
const status = $("#post-status");
const rec = getCurrentRecord();
const text = $("#post-text").value;
status.textContent = "";
try {
if (navigator.share) {
let files = [];
if (rec && rec.data.posterUrl && navigator.canShare) {
try {
const r = await fetch(rec.data.posterUrl);
const blob = await r.blob();
const file = new File([blob], "poster.jpg", { type: blob.type || "image/jpeg"});
if (navigator.canShare({ files: [file]})) files = [file];
} catch (e) { /* ポスターなしで共有する */}
}
await navigator.share(files.length? { files: files, text: text}: { text: text});
status.textContent = "共有しました。投稿できたら下の投稿状態を記録してください。";
} else {
status.textContent = "この端末では共有機能が使えません。「投稿文をコピー」か「Xで投稿する」を使ってください。";
}
} catch (e) {
if (e && e.name!== "AbortError") status.textContent = "共有に失敗しました：" + e.message;
}
});
$("#btn-post-x").addEventListener("click", () => {
const text = encodeURIComponent($("#post-text").value);
window.open(`https://twitter.com/intent/tweet?text=${text}`, "_blank", "noopener");
$("#post-status").textContent = "Xの投稿画面を開きました。投稿できたら下の投稿状態を記録してください。";
});
$("#btn-copy-post").addEventListener("click", async () => {
const status = $("#post-status");
try {
await navigator.clipboard.writeText($("#post-text").value);
status.textContent = "投稿文をコピーしました。";
} catch (e) {
$("#post-text").select();
status.textContent = "コピーできませんでした。テキストを選択しましたので、手動でコピーしてください。";
}
});
$("#btn-save-post-state").addEventListener("click", async () => {
const rec = getCurrentRecord();
const status = $("#post-status");
if (!rec) return;
rec.postState = $("#post-state-select").value;
persistRecords();
if (!rec.notionPageId) { status.textContent = "この端末に記録しました（Notion未保存の記録です）。"; return;}
status.textContent = "Notionに反映中…";
try {
await relayRequest("update", {
properties: { "投稿状態": { select: { name: rec.postState}}}
}, rec.notionPageId);
status.textContent = "投稿状態をNotionに反映しました。";
} catch (e) {
status.textContent = "Notionへの反映に失敗しました：" + e.message + "（この端末には記録済みです）";
}
});
$("#btn-post-done").addEventListener("click", () => showView("list"));

/* ===== 設定画面 ===== */
function secretState(el, has) {
el.textContent = has? "保存済み（画面には表示されません）": "未保存";
}
function renderSettings() {
const tmdb = $("#s-tmdb"), gemini = $("#s-gemini"), token = $("#s-notion-token");
tmdb.value = ""; gemini.value = ""; token.value = "";
tmdb.placeholder = settings.tmdbKey? "保存済み（変更する場合のみ入力）": "TMDB APIキーを入力";
gemini.placeholder = settings.geminiKey? "保存済み（変更する場合のみ入力）": "Gemini APIキーを入力";
token.placeholder = settings.notionToken? "保存済み（変更する場合のみ入力）": "Notion連携トークンを入力";
secretState($("#s-tmdb-state"),!!settings.tmdbKey);
secretState($("#s-gemini-state"),!!settings.geminiKey);
secretState($("#s-notion-token-state"),!!settings.notionToken);
$("#s-relay").value = settings.relayUrl || "";
$("#s-relay-state").textContent = settings.relayUrl? "保存済み": "未保存";
$("#s-notion-db").value = settings.notionDbId || DEFAULT_NOTION_DB_ID;
$("#s-notion-db-state").textContent = "保存先データベースのIDです";
$("#settings-status").textContent = "";
$("#notion-test-status").textContent = "";
}

$("#btn-save-settings").addEventListener("click", () => {
const tmdb = $("#s-tmdb").value.trim();
const gemini = $("#s-gemini").value.trim();
const token = $("#s-notion-token").value.trim();
if (tmdb) settings.tmdbKey = tmdb;
if (gemini) settings.geminiKey = gemini;
if (token) settings.notionToken = token;
settings.relayUrl = $("#s-relay").value.trim().replace(/\/+$/, "");
settings.notionDbId = $("#s-notion-db").value.trim() || DEFAULT_NOTION_DB_ID;
persistSettings();
renderSettings();
$("#settings-status").textContent = "設定を保存しました。";
});

$$("[data-delete-key]").forEach((btn) => {
btn.addEventListener("click", () => {
settings[btn.dataset.deleteKey] = "";
persistSettings();
renderSettings();
$("#settings-status").textContent = "削除しました。";
});
});

$("#btn-notion-test").addEventListener("click", async () => {
const status = $("#notion-test-status");
status.classList.remove("error");
status.textContent = "接続テスト中…";
try {
const db = await relayRequest("test", { database_id: settings.notionDbId || DEFAULT_NOTION_DB_ID});
status.textContent = "接続できました（データベース：" + ((db.title && db.title[0] && db.title[0].plain_text) || "映画鑑賞記録") + "）";
} catch (e) {
status.textContent = "接続できませんでした：" + e.message;
status.classList.add("error");
}
});

/* ===== 初期化 ===== */
function init() {
if ("serviceWorker" in navigator) {
navigator.serviceWorker.register("sw.js").catch(() => {});
}
if (loadDraft()) {
draftRestored = true;
applyFormToDOM();
$("#draft-banner").hidden = false;
showView("form");
} else {
applyFormToDOM();
showView("list");
}
}
init();

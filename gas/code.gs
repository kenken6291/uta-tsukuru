/**
 * うたつくる（uta-tsukuru）バックエンド  code.gs  v1.0.0
 * ------------------------------------------------------------
 * GitHub Pages のフロントエンドから POST（本文JSON、Content-Type: text/plain）で呼び出します。
 *
 * 【最初にやること】
 *  1. スクリプトプロパティに GEMINI_API_KEY を登録
 *  2. エディタで setup() を1回実行（シート・ドライブフォルダ・PEPPERを自動作成し、権限を承認）
 *  3. デプロイ → 新しいデプロイ → ウェブアプリ（実行ユーザー：自分／アクセス：全員）
 *  ※ コードを変更したら「デプロイを管理 → 編集 → バージョン：新バージョン」で更新が必要です。
 *
 * 【スクリプトプロパティ】
 *  GEMINI_API_KEY          必須
 *  GEMINI_TEXT_MODEL       任意  既定: gemini-2.5-flash
 *  GEMINI_TTS_MODEL        任意  既定: gemini-2.5-flash-preview-tts
 *  GEMINI_THINKING_BUDGET  任意  例: 0（2.5 Flash で思考を止めて高速化。対応しないモデルでは空欄に）
 *  DAILY_GEN_LIMIT         任意  既定: 120（作詞・作曲・演出のリクエスト合計／人・日。1曲で5〜8回程度）
 *  DAILY_TTS_LIMIT         任意  既定: 300（読み上げ音声の生成回数／人・日）
 *  APP_URL                 任意  メール本文に載せる公開URL
 *  SPREADSHEET_ID / ROOT_FOLDER_ID / PEPPER  … setup() が自動作成
 */

const APP_VERSION = '1.0.0';
const SESSION_TTL = 21600; // 6時間（CacheServiceの上限）
const MAX_FAIL = 5;
const LOCK_MIN = 15;
const MEDIA_MAX = 20 * 1024 * 1024;
const IMAGE_MAX = 8 * 1024 * 1024;
const AUDIO_MAX = 25 * 1024 * 1024;

const USERS = 'Users';
const SONGS = 'Songs';
const USER_COLS = ['userId', 'nickname', 'email', 'passHash', 'salt', 'mustChange', 'status', 'failCount', 'lockUntil', 'createdAt', 'lastLogin', 'agreedAt', 'usageDate', 'genCount', 'ttsCount'];
const SONG_COLS = ['songId', 'userId', 'title', 'genre', 'theme', 'folderId', 'jsonFileId', 'audioFileId', 'createdAt', 'updatedAt'];

const STYLE_KEYS = {
  rock: 'ロック', salsa: 'サルサ', bachata: 'バチャータ', showa: '昭和歌謡', reiwa: '令和ミュージック', swing: 'スウィング',
  country: 'カントリーウエスタン', jazz: 'ジャズ', rockabilly: 'ロカビリー', game: 'ゲーム音楽', bgm: 'BGM', jive: 'ジャイブ',
  samba: 'サンバ', chachacha: 'チャチャチャ', rumba: 'ルンバ', tango: 'タンゴ', waltz: 'ワルツ',
};
// フロントの VOICES と同じ並び
const VOICES = ['Kore', 'Aoede', 'Leda', 'Callirrhoe', 'Sulafat', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus', 'Iapetus', 'Gacrux', 'Achird', 'Enceladus', 'Algieba'];
const VOICE_DESC = 'Kore=芯のある女性的な声, Aoede=明るく軽やかな女性的な声, Leda=若々しい女性的な声, Callirrhoe=おだやかな女性的な声, Sulafat=あたたかい女性的な声, Zephyr=はつらつとした女性的な声, Puck=陽気な男性的な声, Charon=落ち着いた男性的な語り口, Fenrir=力強い男性的な声, Orus=低めでしっかりした男性的な声, Iapetus=くっきりした男性的な声, Gacrux=大人びた声, Achird=親しみやすい声, Enceladus=息づかいのある声, Algieba=なめらかな声';

class AppError extends Error {
  constructor(message, code) { super(message); this.code = code || ''; }
}

/* ============ 入口 ============ */
function doGet() {
  return out_({ ok: true, app: 'uta-tsukuru', version: APP_VERSION });
}

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out_({ ok: false, error: 'リクエストの形式が正しくありません' }); }
  const routes = {
    register: act_register_, login: act_login_, logout: act_logout_, me: act_me_,
    changePassword: act_changePassword_, forgotPassword: act_forgotPassword_,
    genLyrics: act_genLyrics_, genMusic: act_genMusic_, genVisual: act_genVisual_, tts: act_tts_,
    saveSong: act_saveSong_, listSongs: act_listSongs_, loadSong: act_loadSong_, deleteSong: act_deleteSong_,
    saveAudio: act_saveAudio_, listMedia: act_listMedia_, getMedia: act_getMedia_, uploadImage: act_uploadImage_,
  };
  try {
    const fn = routes[req.action];
    if (!fn) throw new AppError('不明な操作です: ' + req.action);
    return out_(Object.assign({ ok: true }, fn(req) || {}));
  } catch (err) {
    if (!(err instanceof AppError)) console.error(err && err.stack ? err.stack : err);
    return out_({ ok: false, error: err.message || String(err), code: err.code || '' });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ============ 初期設定（エディタから1回実行） ============ */
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  let ss = null;
  const id = p.getProperty('SPREADSHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create('うたつくる_データ');
    p.setProperty('SPREADSHEET_ID', ss.getId());
  }
  ensureSheet_(ss, USERS, USER_COLS);
  ensureSheet_(ss, SONGS, SONG_COLS);
  if (!p.getProperty('ROOT_FOLDER_ID')) {
    const f = DriveApp.createFolder('うたつくる_データ');
    p.setProperty('ROOT_FOLDER_ID', f.getId());
  }
  Logger.log('メール残り送信数: ' + MailApp.getRemainingDailyQuota());
  Logger.log('スプレッドシート: ' + ss.getUrl());
  Logger.log('GEMINI_API_KEY: ' + (p.getProperty('GEMINI_API_KEY') ? '設定済み' : '未設定（スクリプトプロパティに登録してください）'));
  // UrlFetch の権限承認用（モデル一覧の取得を試すだけ）
  if (p.getProperty('GEMINI_API_KEY')) {
    const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': p.getProperty('GEMINI_API_KEY') }, muteHttpExceptions: true });
    Logger.log('Gemini API 接続確認: HTTP ' + r.getResponseCode());
  }
}

function ensureSheet_(ss, name, cols) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@'); // 自動変換（日付化など）を防ぐ
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/* ============ 共通 ============ */
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function ss_() {
  const id = prop_('SPREADSHEET_ID');
  if (!id) throw new AppError('サーバーの初期設定が済んでいません（setup() を実行してください）');
  return SpreadsheetApp.openById(id);
}
function sheet_(name) { return ss_().getSheetByName(name); }
function readAll_(name, cols) {
  const sh = sheet_(name), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = r[j] === null || r[j] === undefined ? '' : String(r[j]); });
    return o;
  });
}
function rowValues_(cols, o) { return cols.map(c => (o[c] === undefined || o[c] === null ? '' : String(o[c]))); }
function writeRow_(name, cols, o) { sheet_(name).getRange(o._row, 1, 1, cols.length).setValues([rowValues_(cols, o)]); }
function appendRow_(name, cols, o) {
  const sh = sheet_(name), row = sh.getLastRow() + 1;
  const rg = sh.getRange(row, 1, 1, cols.length);
  rg.setNumberFormat('@');
  rg.setValues([rowValues_(cols, o)]);
}
function now_() { return Date.now(); }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd'); }
function str_(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function hex_(bytes) { return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ============ パスワード ============ */
function hash_(pw, salt) {
  const pepper = prop_('PEPPER');
  let h = salt + ':' + pw + ':' + pepper;
  for (let i = 0; i < 200; i++) {
    h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + ':' + salt, Utilities.Charset.UTF_8));
  }
  return h;
}
function randomChars_(len, chars) {
  let s = '';
  while (s.length < len) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + now_() + Math.random());
    for (let i = 0; i < bytes.length && s.length < len; i++) s += chars[(bytes[i] & 0xff) % chars.length];
  }
  return s;
}
function tempPassword_() {
  let p;
  do { p = randomChars_(10, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'); }
  while (!/[A-Za-z]/.test(p) || !/\d/.test(p));
  return p;
}
function setPassword_(u, pw) {
  u.salt = randomChars_(24, 'abcdefghijklmnopqrstuvwxyz0123456789');
  u.passHash = hash_(pw, u.salt);
}
function validEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120; }
function findUserByEmail_(email) {
  const e = String(email || '').trim().toLowerCase();
  return readAll_(USERS, USER_COLS).find(u => u.email.toLowerCase() === e) || null;
}
function publicUser_(u) { return { nickname: u.nickname, email: u.email, mustChange: u.mustChange === '1' }; }
function appUrl_() { return prop_('APP_URL') || 'https://kenken6291.github.io/uta-tsukuru/'; }

/* ============ セッション ============ */
function auth_(req, ready) {
  const token = String(req.token || '');
  if (!token) throw new AppError('ログインしてください', 'AUTH');
  const c = CacheService.getScriptCache();
  const uid = c.get('s_' + token);
  if (!uid) throw new AppError('ログインの有効期限が切れました。もう一度ログインしてください', 'AUTH');
  c.put('s_' + token, uid, SESSION_TTL);
  const u = readAll_(USERS, USER_COLS).find(x => x.userId === uid);
  if (!u || u.status !== 'active') throw new AppError('このアカウントは利用できません', 'AUTH');
  if (ready && u.mustChange === '1') throw new AppError('先にパスワードを変更してください', 'MUST_CHANGE');
  return u;
}
function useQuota_(u, kind) {
  const day = today_();
  if (u.usageDate !== day) { u.usageDate = day; u.genCount = '0'; u.ttsCount = '0'; }
  const key = kind === 'tts' ? 'ttsCount' : 'genCount';
  const limit = Number(prop_(kind === 'tts' ? 'DAILY_TTS_LIMIT' : 'DAILY_GEN_LIMIT')) || (kind === 'tts' ? 300 : 120);
  const n = Number(u[key]) || 0;
  if (n >= limit) throw new AppError('本日の利用上限に達しました。明日またお試しください', 'LIMIT');
  u[key] = String(n + 1);
  writeRow_(USERS, USER_COLS, u);
}

/* ============ 会員機能 ============ */
function act_register_(req) {
  const nickname = str_(req.nickname, 20);
  const email = str_(req.email, 120).toLowerCase();
  if (req.agreed !== true) throw new AppError('注意事項・免責事項への同意が必要です');
  if (!nickname) throw new AppError('ニックネームを入力してください');
  if (!validEmail_(email)) throw new AppError('メールアドレスの形式が正しくありません');
  return withLock_(() => {
    if (findUserByEmail_(email)) throw new AppError('このメールアドレスはすでに登録されています。パスワードを忘れた場合は再発行してください');
    const pw = tempPassword_();
    const u = { userId: 'u_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), nickname, email, mustChange: '1', status: 'active', failCount: '0', lockUntil: '0', createdAt: String(now_()), lastLogin: '', agreedAt: String(now_()), usageDate: '', genCount: '0', ttsCount: '0' };
    setPassword_(u, pw);
    try {
      MailApp.sendEmail({
        to: email,
        subject: '【うたつくる】仮パスワードのお知らせ',
        name: 'うたつくる',
        body: nickname + ' さん\n\nうたつくる へのご登録ありがとうございます。\n\n仮パスワード：' + pw +
          '\n\nログイン画面：' + appUrl_() + '\n初回ログイン時に新しいパスワードへの変更をお願いします。\n\n※このメールに心当たりがない場合は破棄してください。',
      });
    } catch (e) {
      throw new AppError('メールを送信できませんでした。時間をおいて再度お試しください');
    }
    appendRow_(USERS, USER_COLS, u);
    return { message: '仮パスワードを ' + email + ' に送りました。メールを確認してログインしてください' };
  });
}

function act_login_(req) {
  const email = str_(req.email, 120).toLowerCase();
  const pw = String(req.password || '');
  const u = findUserByEmail_(email);
  const ng = 'メールアドレスまたはパスワードが違います';
  if (!u || !pw) throw new AppError(ng);
  if (u.status !== 'active') throw new AppError('このアカウントは利用できません');
  const lockUntil = Number(u.lockUntil) || 0;
  if (lockUntil > now_()) throw new AppError('ログインに続けて失敗したためロック中です。あと' + Math.ceil((lockUntil - now_()) / 60000) + '分ほどお待ちください');
  if (hash_(pw, u.salt) !== u.passHash) {
    const n = (Number(u.failCount) || 0) + 1;
    if (n >= MAX_FAIL) {
      u.failCount = '0'; u.lockUntil = String(now_() + LOCK_MIN * 60000);
      writeRow_(USERS, USER_COLS, u);
      throw new AppError('ログインに' + MAX_FAIL + '回失敗したため、' + LOCK_MIN + '分間ロックしました');
    }
    u.failCount = String(n);
    writeRow_(USERS, USER_COLS, u);
    throw new AppError(ng + '（あと' + (MAX_FAIL - n) + '回失敗するとロックされます）');
  }
  u.failCount = '0'; u.lockUntil = '0'; u.lastLogin = String(now_());
  writeRow_(USERS, USER_COLS, u);
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('s_' + token, u.userId, SESSION_TTL);
  return { token, user: publicUser_(u) };
}

function act_logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('s_' + String(req.token));
  return {};
}

function act_me_(req) {
  return { user: publicUser_(auth_(req, false)), version: APP_VERSION };
}

function act_changePassword_(req) {
  const u = auth_(req, false);
  const cur = String(req.currentPassword || ''), np = String(req.newPassword || '');
  if (hash_(cur, u.salt) !== u.passHash) throw new AppError('今のパスワードが違います');
  if (np.length < 8 || np.length > 64 || !/[A-Za-z]/.test(np) || !/\d/.test(np)) throw new AppError('新しいパスワードは8〜64文字で、英字と数字を両方含めてください');
  if (np === cur) throw new AppError('今と違うパスワードにしてください');
  setPassword_(u, np);
  u.mustChange = '0';
  writeRow_(USERS, USER_COLS, u);
  return { message: 'パスワードを変更しました' };
}

function act_forgotPassword_(req) {
  const email = str_(req.email, 120).toLowerCase();
  const msg = '登録済みのメールアドレスであれば、仮パスワードを送りました。メールを確認してください';
  if (!validEmail_(email)) throw new AppError('メールアドレスの形式が正しくありません');
  const c = CacheService.getScriptCache();
  if (c.get('fp_' + email)) return { message: msg }; // 5分以内の連続再発行は送らない
  c.put('fp_' + email, '1', 300);
  withLock_(() => {
    const u = findUserByEmail_(email);
    if (!u || u.status !== 'active') return;
    const pw = tempPassword_();
    setPassword_(u, pw);
    u.mustChange = '1'; u.failCount = '0'; u.lockUntil = '0';
    MailApp.sendEmail({
      to: email,
      subject: '【うたつくる】仮パスワード再発行のお知らせ',
      name: 'うたつくる',
      body: u.nickname + ' さん\n\n仮パスワードを再発行しました。\n\n仮パスワード：' + pw +
        '\n\nログイン画面：' + appUrl_() + '\nログイン後に新しいパスワードへの変更をお願いします。\n\n※お心当たりがない場合は、このメールを破棄してください（以前のパスワードは使えなくなっています。再発行でログインできます）。',
    });
    writeRow_(USERS, USER_COLS, u);
  });
  return { message: msg };
}

/* ============ Gemini ============ */
function gemini_(model, body) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw new AppError('サーバーに GEMINI_API_KEY が設定されていません');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  let last = '';
  for (let i = 0; i < 3; i++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    last = 'HTTP ' + code + ' ' + res.getContentText().slice(0, 300);
    if (code === 429 || code >= 500) { Utilities.sleep(1500 * (i + 1)); continue; }
    break;
  }
  console.error('Gemini error: ' + last);
  throw new AppError('AIの呼び出しに失敗しました（' + last.slice(0, 120) + '）。少し待ってから再度お試しください');
}

function geminiJson_(prompt, temperature) {
  const model = prop_('GEMINI_TEXT_MODEL') || 'gemini-2.5-flash';
  const gc = { responseMimeType: 'application/json', temperature: temperature == null ? .9 : temperature, maxOutputTokens: 16384 };
  const tb = prop_('GEMINI_THINKING_BUDGET');
  if (tb !== '' && !isNaN(Number(tb))) gc.thinkingConfig = { thinkingBudget: Number(tb) };
  const res = gemini_(model, { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gc });
  const parts = (((res.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
  const j = parseJsonLoose_(text);
  if (!j) throw new AppError('AIの応答を読み取れませんでした。もう一度お試しください');
  return Array.isArray(j) ? j[0] : j;
}

function parseJsonLoose_(text) {
  let t = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch (e) { /* 次へ */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* noop */ } }
  return null;
}

/* 読み上げ文から、指示語・見出し・演出指示を取り除く */
function cleanSpeech_(t) {
  const DIRECTION = /(繰り返し|くり返し|リピート|間奏|repeat|×\s*\d|x\s*\d|コーラス|セリフ|語り|ささや|囁|声で|調で|風に|ゆっくり|明るく|静かに|力強く|フェード|ハモ)/i;
  let s = String(t || '').replace(/\r/g, '');
  s = s.split('\n').map(l => l.trim()
    .replace(/^[\[［【<＜][^\]］】>＞]{0,20}[\]］】>＞]\s*/, '')
    .replace(/^(ナレーション|語り|歌詞|ボーカル|セリフ|narration|vocal|lyrics)\s*[:：]\s*/i, ''))
    .filter(Boolean).join('\n');
  s = s.replace(/^[^。\n]{0,40}?(読み上げ|朗読|音読)(て|し)?(ください|下さい|ます|る)?[。．.:：、!！]?\s*/, '');
  s = s.replace(/[（(]([^）)]{0,30})[）)]/g, (m, inner) => (DIRECTION.test(inner) ? '' : inner));
  s = s.replace(/[※＊*#＃]/g, '');
  return s.split('\n').map(x => x.trim()).filter(Boolean)
    .map(x => (/[。、！？!?…」』〜ー]$/.test(x) ? x : x + '。')).join('\n').trim();
}

/* ============ 作詞・構成 ============ */
function act_genLyrics_(req) {
  const u = auth_(req, true);
  useQuota_(u, 'gen');
  const i = req.input || {};
  const input = {
    genre: str_(i.genre, 40), styleHint: STYLE_KEYS[i.styleHint] ? i.styleHint : '',
    theme: str_(i.theme, 300), voiceRef: str_(i.voiceRef, 300), songRef: str_(i.songRef, 300), feelings: str_(i.feelings, 1000),
  };
  if (!input.genre) throw new AppError('ジャンルを指定してください');
  const styleList = Object.keys(STYLE_KEYS).map(k => k + '（' + STYLE_KEYS[k] + '）').join(', ');
  const prompt = [
    'あなたはプロの作詞家・音楽プロデューサーです。次の条件で、約3分のオリジナル曲の「作詞と曲の構成」を作ってください。',
    '',
    '【条件】',
    '- ジャンル: ' + input.genre,
    '- テーマ: ' + (input.theme || '（指定なし。気持ちから考える）'),
    '- 声のイメージ（歌手の雰囲気の参考）: ' + (input.voiceRef || '（指定なし）'),
    '- 曲風の参考: ' + (input.songRef || '（指定なし）'),
    '- 歌詞にしたい気持ち: ' + (input.feelings || '（指定なし。テーマから考える）'),
    '',
    '【守ること】',
    '- 歌詞は完全なオリジナル。既存の曲の歌詞・フレーズ・タイトルを引用したり、言い換えて再現したりしない。',
    '- 参考の歌手名・曲名は、声の質感・言葉づかい・テンポ感など大まかな雰囲気の参考にだけ使う。歌詞やタイトルに歌手名・曲名を入れない。',
    '- 歌詞は日本語。ジャンルに合えば英語やスペイン語の短い掛け声を少し混ぜてもよい。',
    '- 歌詞の各行は8〜16音程度。Aメロ・Bメロは各4行前後、サビは4〜6行。歌詞に見出し・記号・演出指示（［サビ］、（くり返し）など）を入れない。',
    '- 構成は pattern 記号 intro, A, B, S, C, interlude, outro を並べる（Sはサビ、Cは大サビ・展開部）。同じ記号は同じ伴奏とメロディを使い回し、歌詞は登場ごとに変えてよい。',
    '- 同じ pattern 記号は必ず同じ bars（小節数、4の倍数で4〜16）にする。intro/interlude/outro の lyrics は空配列。',
    '- 曲の長さ（秒）= 全小節数 × 1小節の拍数 × 60 ÷ bpm が170〜190秒になるようにする。',
    '- label は日本語の区間名（例: イントロ, Aメロ1, Bメロ1, サビ1, 間奏, Aメロ2, サビ2, 大サビ, ラストサビ, アウトロ）。label はすべて異なる名前にする。',
    '- styleKey は次から最も近いものを1つ: ' + styleList + (input.styleHint ? '（第一候補: ' + input.styleHint + '）' : ''),
    '- voice は読み上げ用の声を次から声のイメージに最も近いものを1つ: ' + VOICE_DESC,
    '- ワルツなど3拍子のジャンルは timeSig を "3/4"、それ以外は "4/4"。',
    '- palette は曲の雰囲気に合う色を3つ（#RRGGBB）。',
    '',
    '【出力】次の形のJSONだけを出力する。',
    '{"title":"曲名","concept":"曲のコンセプトを1文","styleKey":"","bpm":120,"timeSig":"4/4","key":"Am","voice":"","vocalImage":"声の特徴を1文","palette":["#RRGGBB","#RRGGBB","#RRGGBB"],',
    '"arrangement":[{"pattern":"intro","label":"イントロ","bars":8,"lyrics":[]},{"pattern":"A","label":"Aメロ1","bars":16,"lyrics":["…","…"]}]}',
  ].join('\n');
  const j = geminiJson_(prompt, 1.0);
  if (!j || !Array.isArray(j.arrangement)) throw new AppError('曲の構成をうまく作れませんでした。もう一度お試しください');
  if (VOICES.indexOf(j.voice) < 0) j.voice = 'Kore';
  if (!STYLE_KEYS[j.styleKey]) j.styleKey = input.styleHint || 'reiwa';
  j.arrangement.forEach(a => { if (Array.isArray(a.lyrics)) a.lyrics = a.lyrics.map(l => cleanLyricLine_(l)).filter(Boolean); });
  return { song: j };
}
function cleanLyricLine_(l) {
  return String(l || '').replace(/^[\[［【][^\]］】]{0,20}[\]］】]\s*/, '').replace(/[※＊*#＃]/g, '').trim().slice(0, 80);
}

/* ============ 作曲 ============ */
function act_genMusic_(req) {
  const u = auth_(req, true);
  useQuota_(u, 'gen');
  const s = req.song || {};
  const targets = (Array.isArray(req.targets) ? req.targets : []).map(t => str_(t, 20)).filter(Boolean).slice(0, 4);
  const pats = (Array.isArray(s.patterns) ? s.patterns : []).slice(0, 12).map(p => ({
    key: str_(p.key, 20), label: str_(p.label, 30), bars: Math.max(2, Math.min(32, parseInt(p.bars, 10) || 8)),
    lyrics: (Array.isArray(p.lyrics) ? p.lyrics : []).slice(0, 12).map(l => str_(l, 80)),
  }));
  if (!targets.length || !pats.length) throw new AppError('作曲する部分が指定されていません');
  const beats = String(s.timeSig) === '3/4' ? 3 : 4;
  const style = STYLE_KEYS[s.styleKey] || str_(s.genre, 40);
  const want = targets.map(t => { const p = pats.find(x => x.key === t); return p ? '"' + t + '": chords と melody をそれぞれ ' + p.bars + ' 個' : ''; }).filter(Boolean);
  const prompt = [
    'あなたは作曲家・編曲家です。次の曲の一部のパターンについて、コード進行とメロディを作ってください。',
    '',
    '曲名: ' + str_(s.title, 60),
    'コンセプト: ' + str_(s.concept, 200),
    'ジャンル: ' + str_(s.genre, 40) + '（伴奏スタイル: ' + style + '）',
    'キー: ' + str_(s.key, 6) + '／拍子: ' + beats + '/4／テンポ: ' + (parseInt(s.bpm, 10) || 120),
    '',
    '曲全体のパターン（参考。同じ曲として統一感を持たせる）:',
    pats.map(p => '- ' + p.key + '（' + p.label + '、' + p.bars + '小節） 歌詞: ' + (p.lyrics.length ? p.lyrics.join(' / ') : 'なし（楽器のみ）')).join('\n'),
    '',
    '今回作るパターン: ' + targets.join(', '),
    '',
    '【ルール】',
    '- chords: 配列の1要素が1小節。1小節に2つのコードを入れるときは "F G" のように半角スペースで区切る。',
    '  表記は C, Am, G7, Fmaj7, Dm7, E7, Bm7b5, Csus4, Cdim, Caug, C6, C/E など一般的なものだけ。',
    '- melody: 配列の1要素が1小節。「音名オクターブ:拍数」を半角スペースで区切る（例 "E4:1 G4:0.5 A4:0.5 C5:2"）。休符は "R:拍数"。',
    '  各小節の拍数の合計は必ず ' + beats + '。音域は C4〜A5。シャープは #、フラットは b（例 F#4, Bb4）。',
    '- 歌詞のある部分は、歌詞の音数に合う自然なリズムと抑揚にする。サビ(S)は高めの音域で覚えやすく印象的に。',
    '- intro/interlude/outro は楽器のテーマ（サビのモチーフを生かす）。outro の最後の小節は主音で終える。',
    '- キー ' + str_(s.key, 6) + ' を基本に、ジャンルらしい進行にする（例: 昭和歌謡なら哀愁のある短調、ジャズなら ii-V-I、ロカビリーならブルース進行、ボサノバ系ならテンションコード）。',
    '- 既存曲のメロディやコード進行を丸写ししない。',
    '- 要素数: ' + want.join('、'),
    '',
    '【出力】次の形のJSONだけを出力する。',
    '{"patterns":{"' + targets[0] + '":{"chords":["Am","F G"],"melody":["A4:1 C5:1 E5:2","D5:2 C5:1 B4:1"]}}}',
  ].join('\n');
  const j = geminiJson_(prompt, .8);
  const out = {};
  const src = (j && j.patterns) || j || {};
  targets.forEach(t => {
    const p = src[t];
    if (p && (Array.isArray(p.chords) || Array.isArray(p.melody))) {
      out[t] = {
        chords: (p.chords || []).slice(0, 32).map(c => str_(c, 24)),
        melody: (p.melody || []).slice(0, 32).map(m => str_(m, 200)),
      };
    }
  });
  if (!Object.keys(out).length) throw new AppError('作曲の結果をうまく読み取れませんでした。もう一度お試しください');
  return { patterns: out };
}

/* ============ 演出・ナレーション ============ */
function act_genVisual_(req) {
  const u = auth_(req, true);
  useQuota_(u, 'gen');
  const s = req.song || {};
  const secs = (Array.isArray(s.sections) ? s.sections : []).slice(0, 24).map(x => ({ label: str_(x.label, 30), kind: str_(x.kind, 10), first: str_(x.first, 80) }));
  const prompt = [
    'あなたはミュージックビデオの演出家です。次の曲の、曲紹介ナレーションと、Google Earth Studio で作る背景映像の撮影プランを作ってください。',
    '',
    '曲名: ' + str_(s.title, 60),
    'コンセプト: ' + str_(s.concept, 200),
    'ジャンル: ' + str_(s.genre, 40),
    'テーマ: ' + str_(s.theme, 300),
    '区間: ',
    secs.map(x => '- ' + x.label + (x.first ? '（歌い出し: ' + x.first + '）' : '（楽器のみ）')).join('\n'),
    '',
    '【ナレーションのルール】',
    '- 読み上げる本文だけを書く。「ナレーション：」などの見出し、「〜で読み上げてください」「〜な声で」などの指示、カッコ書きの演出指示、絵文字、記号は入れない。',
    '- intro は曲の紹介で2〜3文（60〜110文字）。最後に曲名を自然に紹介する。outro は締めのひとこと1〜2文（20〜60文字）。',
    '',
    '【撮影プランのルール】',
    '- scenes は上の区間と同じ数・同じ順番・同じ label にする。',
    '- 曲のテーマや情景に合う実在の場所を選び、lat/lng は正確な座標（小数）。altitude はカメラの高度（メートル、200〜20000）。',
    '- heading はカメラの向き（0〜359度）、tilt は傾き（0=真下、90=水平。30〜80）。',
    '- motion は 周回 / 接近 / 上昇 / 横移動 / 固定 のいずれか。サビは動きのある絵、間奏やアウトロは広い引きの絵にする。',
    '- description は映像のイメージを1文で。',
    '',
    '【出力】次の形のJSONだけを出力する。',
    '{"narration":{"intro":"…","outro":"…"},"scenes":[{"label":"イントロ","description":"…","place":"…","lat":35.0,"lng":139.0,"altitude":1500,"heading":0,"tilt":65,"motion":"周回"}],"palette":["#RRGGBB","#RRGGBB","#RRGGBB"]}',
  ].join('\n');
  const j = geminiJson_(prompt, .9) || {};
  const n = j.narration || {};
  return {
    narration: { intro: cleanSpeech_(n.intro).slice(0, 300), outro: cleanSpeech_(n.outro).slice(0, 200) },
    scenes: (Array.isArray(j.scenes) ? j.scenes : []).slice(0, 24).map(x => ({
      label: str_(x.label, 30), description: str_(x.description, 120), place: str_(x.place, 60),
      lat: Number(x.lat), lng: Number(x.lng), altitude: Number(x.altitude) || 1500,
      heading: Number(x.heading) || 0, tilt: Number(x.tilt) || 60, motion: str_(x.motion, 10) || '固定',
    })),
    palette: (Array.isArray(j.palette) ? j.palette : []).filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 3),
  };
}

/* ============ 読み上げ（Gemini TTS） ============ */
function act_tts_(req) {
  const u = auth_(req, true);
  useQuota_(u, 'tts');
  let text = cleanSpeech_(req.text);
  if (!text) throw new AppError('読み上げる文章がありません');
  if (text.length > 1500) text = text.slice(0, 1500);
  const voice = VOICES.indexOf(req.voice) >= 0 ? req.voice : 'Kore';
  const model = prop_('GEMINI_TTS_MODEL') || 'gemini-2.5-flash-preview-tts';
  // 指示文を一切付けず、本文だけを渡す（冒頭に「〜で読み上げて」等が入らないように）
  const body = {
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
  for (let i = 0; i < 2; i++) {
    const res = gemini_(model, body);
    const parts = (((res.candidates || [])[0] || {}).content || {}).parts || [];
    const a = parts.find(p => p.inlineData && p.inlineData.data);
    if (a) {
      const m = /rate=(\d+)/.exec(a.inlineData.mimeType || '');
      return { audio: a.inlineData.data, rate: m ? Number(m[1]) : 24000 };
    }
  }
  throw new AppError('音声を作れませんでした。歌詞を少し短くして再度お試しください');
}

/* ============ 曲の保存（ドライブ＋シート） ============ */
function userFolder_(u) {
  const root = DriveApp.getFolderById(prop_('ROOT_FOLDER_ID'));
  const it = root.getFoldersByName(u.userId);
  return it.hasNext() ? it.next() : root.createFolder(u.userId);
}
function ownSong_(u, songId) {
  const s = readAll_(SONGS, SONG_COLS).find(x => x.songId === String(songId || ''));
  if (!s || s.userId !== u.userId) throw new AppError('曲が見つかりません');
  return s;
}
function folderUrl_(id) { return 'https://drive.google.com/drive/folders/' + id; }

function act_saveSong_(req) {
  const u = auth_(req, true);
  const song = req.song;
  if (!song || !Array.isArray(song.arrangement)) throw new AppError('保存する曲がありません');
  const json = JSON.stringify(song);
  if (json.length > 800000) throw new AppError('曲のデータが大きすぎて保存できません');
  const title = str_(song.title, 60) || '無題の曲';
  const genre = str_(song.genre, 40), theme = str_((song.input || {}).theme, 100);
  return withLock_(() => {
    if (req.songId) {
      const s = ownSong_(u, req.songId);
      DriveApp.getFileById(s.jsonFileId).setContent(json);
      s.title = title; s.genre = genre; s.theme = theme; s.updatedAt = String(now_());
      writeRow_(SONGS, SONG_COLS, s);
      return { songId: s.songId, folderUrl: folderUrl_(s.folderId) };
    }
    const songId = 's_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    const folder = userFolder_(u).createFolder(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm') + '_' + title.replace(/[\\/:*?"<>|]/g, '_'));
    const file = folder.createFile('song.json', json, 'application/json');
    appendRow_(SONGS, SONG_COLS, { songId, userId: u.userId, title, genre, theme, folderId: folder.getId(), jsonFileId: file.getId(), audioFileId: '', createdAt: String(now_()), updatedAt: String(now_()) });
    return { songId, folderUrl: folderUrl_(folder.getId()) };
  });
}

function act_listSongs_(req) {
  const u = auth_(req, false);
  const songs = readAll_(SONGS, SONG_COLS).filter(s => s.userId === u.userId)
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
    .map(s => ({ songId: s.songId, title: s.title, genre: s.genre, theme: s.theme, updatedAt: Number(s.updatedAt), hasAudio: !!s.audioFileId }));
  return { songs };
}

function act_loadSong_(req) {
  const u = auth_(req, false);
  const s = ownSong_(u, req.songId);
  const song = JSON.parse(DriveApp.getFileById(s.jsonFileId).getBlob().getDataAsString('UTF-8'));
  return { song, songId: s.songId, folderUrl: folderUrl_(s.folderId) };
}

function act_deleteSong_(req) {
  const u = auth_(req, false);
  return withLock_(() => {
    const s = ownSong_(u, req.songId);
    try { DriveApp.getFolderById(s.folderId).setTrashed(true); } catch (e) { /* フォルダが無くても行は消す */ }
    sheet_(SONGS).deleteRow(s._row);
    return {};
  });
}

function act_saveAudio_(req) {
  const u = auth_(req, true);
  const s = ownSong_(u, req.songId);
  const bytes = Utilities.base64Decode(String(req.data || ''));
  if (!bytes.length) throw new AppError('音声データがありません');
  if (bytes.length > AUDIO_MAX) throw new AppError('音声が大きすぎます');
  const name = str_(req.name, 60).replace(/[\\/:*?"<>|]/g, '_') || 'song.wav';
  const file = DriveApp.getFolderById(s.folderId).createFile(Utilities.newBlob(bytes, 'audio/wav', name));
  if (s.audioFileId) { try { DriveApp.getFileById(s.audioFileId).setTrashed(true); } catch (e) { /* noop */ } }
  s.audioFileId = file.getId(); s.updatedAt = String(now_());
  writeRow_(SONGS, SONG_COLS, s);
  return { fileId: file.getId(), url: file.getUrl() };
}

function act_listMedia_(req) {
  const u = auth_(req, false);
  const s = ownSong_(u, req.songId);
  const files = [];
  const it = DriveApp.getFolderById(s.folderId).getFiles();
  while (it.hasNext()) {
    const f = it.next(), mt = f.getMimeType();
    if (/^(image|video)\//.test(mt)) files.push({ id: f.getId(), name: f.getName(), mimeType: mt, size: f.getSize() });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files };
}

function act_getMedia_(req) {
  const u = auth_(req, false);
  const s = ownSong_(u, req.songId);
  const f = DriveApp.getFileById(String(req.fileId || ''));
  let inside = false;
  const ps = f.getParents();
  while (ps.hasNext()) if (ps.next().getId() === s.folderId) { inside = true; break; }
  if (!inside) throw new AppError('この曲のフォルダにあるファイルではありません');
  if (f.getSize() > MEDIA_MAX) throw new AppError('ファイルが大きすぎます（20MBまで）。端末のファイルとして読み込んでください');
  if (!/^(image|video)\//.test(f.getMimeType())) throw new AppError('画像か動画を選んでください');
  return { mimeType: f.getMimeType(), data: Utilities.base64Encode(f.getBlob().getBytes()) };
}

function act_uploadImage_(req) {
  const u = auth_(req, true);
  const s = ownSong_(u, req.songId);
  const mt = String(req.mimeType || '');
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mt)) throw new AppError('PNG・JPEG・WebP・GIF の画像を選んでください');
  const bytes = Utilities.base64Decode(String(req.data || ''));
  if (!bytes.length || bytes.length > IMAGE_MAX) throw new AppError('画像は8MBまでです');
  const name = str_(req.name, 80).replace(/[\\/:*?"<>|]/g, '_') || 'image';
  DriveApp.getFolderById(s.folderId).createFile(Utilities.newBlob(bytes, mt, name));
  return {};
}

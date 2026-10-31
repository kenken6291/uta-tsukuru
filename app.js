/*!
 * うたつくる app.js v1.1.0（Gemini消費削減：1曲＝AI1回、作曲はブラウザ内）
 * 会員認証 / 曲づくり（Gemini）/ ステージ再生 / 歌詞の声（Gemini TTS）/ 書き出し / マイソング
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const E = window.UtaEngine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 容量不足などは無視 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } },
  };
  const fmt = sec => { const s = Math.max(0, Math.floor(sec || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const GENRES = [
    ['rock', 'ロック'], ['salsa', 'サルサ'], ['bachata', 'バチャータ'], ['showa', '昭和歌謡'], ['reiwa', '令和ミュージック'],
    ['swing', 'スウィング'], ['country', 'カントリーウエスタン'], ['jazz', 'ジャズ'], ['rockabilly', 'ロカビリー'],
    ['game', 'ゲーム音楽'], ['bgm', 'BGM'], ['jive', 'ジャイブ'], ['samba', 'サンバ'], ['chachacha', 'チャチャチャ'],
    ['rumba', 'ルンバ'], ['tango', 'タンゴ'], ['waltz', 'ワルツ'],
  ];
  // GAS側の VOICES と同じ並び
  const VOICES = [
    ['Kore', '芯のある声（女性的）'], ['Aoede', '明るく軽やかな声（女性的）'], ['Leda', '若々しい声（女性的）'],
    ['Callirrhoe', 'おだやかな声（女性的）'], ['Sulafat', 'あたたかい声（女性的）'], ['Zephyr', 'はつらつとした声（女性的）'],
    ['Puck', '陽気な声（男性的）'], ['Charon', '落ち着いた語り口（男性的）'], ['Fenrir', '力強い声（男性的）'],
    ['Orus', '低めでしっかりした声（男性的）'], ['Iapetus', 'くっきりした声（男性的）'], ['Gacrux', '大人びた声'],
    ['Achird', '親しみやすい声'], ['Enceladus', '息づかいのある声'], ['Algieba', 'なめらかな声'],
  ];
  const voiceLabel = v => (VOICES.find(x => x[0] === v) || [v, v])[1];

  const state = { token: store.get('uta_token', null), user: null, song: null, songId: null, folderUrl: null };

  /* ===== 設定 ===== */
  const URL_RE = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[\w-]+\/exec$/;
  const settings = () => Object.assign({ gasUrl: '', silenceSec: CFG.SPEECH_SILENCE_SEC || 10 }, store.get('uta_settings', {}));
  function gasUrl() {
    const s = (settings().gasUrl || '').trim();
    if (s) return s;
    const c = (CFG.GAS_URL || '').trim();
    return URL_RE.test(c) ? c : '';
  }

  /* ===== 通信 ===== */
  async function api(action, payload) {
    const url = gasUrl();
    if (!url) { openModal('modalSettings'); throw new Error('サーバー（GAS）のURLが設定されていません。設定画面で入力してください。'); }
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token: state.token || '' }, payload || {})),
      });
    } catch (e) {
      throw new Error('サーバーに接続できませんでした。通信状況とGASのURLを確認してください。');
    }
    let data;
    try { data = await res.json(); } catch (e) {
      throw new Error('サーバーの応答を読み取れませんでした。GASのデプロイで「アクセスできるユーザー：全員」になっているか確認してください。');
    }
    if (!data.ok) {
      if (data.code === 'AUTH') { clearSession(); showAuth(); }
      if (data.code === 'MUST_CHANGE') openPwModal(true);
      const err = new Error(data.error || 'エラーが発生しました'); err.code = data.code; throw err;
    }
    return data;
  }

  async function pool(items, n, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length) { const it = items[i++]; await fn(it); }
    });
    await Promise.all(workers);
  }

  /* ===== 表示まわり ===== */
  let toastTimer;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 6500 : 3500);
  }
  async function busy(btn, text, fn) {
    if (!btn || btn.dataset.busy) return;
    const old = btn.innerHTML;
    btn.dataset.busy = '1'; btn.disabled = true;
    btn.innerHTML = '<span class="spin" aria-hidden="true"></span>' + esc(text);
    try { return await fn(); }
    catch (e) { toast(e.message || String(e), 'error'); }
    finally { delete btn.dataset.busy; btn.disabled = false; btn.innerHTML = old; }
  }

  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 5.2A9.6 9.6 0 0 1 12 5c7 0 11 7 11 7a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M1 1l22 22"/></svg>';
  const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>';
  const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1"/></svg>';

  function initEyes() {
    $$('[data-eye]').forEach(b => {
      if (b.dataset.ready) return;
      b.dataset.ready = '1';
      b.innerHTML = EYE;
      b.setAttribute('aria-label', 'パスワードを表示');
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        const inp = b.previousElementSibling;
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        b.innerHTML = show ? EYE_OFF : EYE;
        b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
        b.setAttribute('aria-pressed', String(show));
      });
    });
  }

  /* ===== モーダル ===== */
  function openModal(id) {
    const d = document.getElementById(id);
    if (!d || d.open) return;
    if (id === 'modalSettings') fillSettings();
    d.showModal ? d.showModal() : d.setAttribute('open', '');
  }
  function closeModal(d) { if (d && d.open) { d.close ? d.close() : d.removeAttribute('open'); } }
  function bindModals() {
    $$('[data-open]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.open)));
    $$('dialog.modal').forEach(d => {
      d.addEventListener('click', e => {
        if (e.target.closest('[data-close]') && !(d.id === 'modalPw' && d.dataset.forced)) closeModal(d);
        if (e.target === d && !(d.id === 'modalPw' && d.dataset.forced)) closeModal(d);
      });
      d.addEventListener('cancel', e => { if (d.id === 'modalPw' && d.dataset.forced) e.preventDefault(); });
    });
  }

  /* ===== 認証 ===== */
  function showAuth() {
    $('#authView').hidden = false; $('#appView').hidden = true;
    player.stop(); Speech.stop();
  }
  function showApp() {
    $('#authView').hidden = true; $('#appView').hidden = false;
    $('#userName').textContent = state.user ? state.user.nickname + ' さん' : '';
  }
  function clearSession() { state.token = null; state.user = null; store.del('uta_token'); }
  function switchAuth(name) {
    $$('[data-auth]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.auth === name)));
    $$('[data-authpane]').forEach(f => { f.hidden = f.dataset.authpane !== name; });
  }
  const allAgreed = () => $$('[data-agree]').every(c => c.checked);
  const updateRegBtn = () => { $('#btnRegister').disabled = !allAgreed(); };

  function bindAuth() {
    $$('[data-auth]').forEach(b => b.addEventListener('click', () => switchAuth(b.dataset.auth)));
    $$('[data-agree]').forEach(c => c.addEventListener('change', updateRegBtn));

    $('#formLogin').addEventListener('submit', e => {
      e.preventDefault();
      const email = $('#loginEmail').value.trim(), password = $('#loginPw').value;
      if (!email || !password) { toast('メールアドレスとパスワードを入力してください', 'error'); return; }
      busy($('#btnLogin'), 'ログインしています', async () => {
        const r = await api('login', { email, password });
        state.token = r.token; state.user = r.user;
        store.set('uta_token', r.token);
        $('#loginPw').value = '';
        showApp(); restoreDraft();
        if (r.user.mustChange) openPwModal(true);
        else toast('ようこそ、' + r.user.nickname + ' さん', 'ok');
      });
    });

    $('#formRegister').addEventListener('submit', e => {
      e.preventDefault();
      if (!allAgreed()) { toast('すべての項目に同意してください', 'error'); return; }
      const nickname = $('#regNick').value.trim(), email = $('#regEmail').value.trim();
      if (!nickname || !email) { toast('ニックネームとメールアドレスを入力してください', 'error'); return; }
      busy($('#btnRegister'), '登録しています', async () => {
        const r = await api('register', { nickname, email, agreed: true });
        toast(r.message || '仮パスワードをメールで送りました', 'ok');
        $('#formRegister').reset();
        switchAuth('login');
        $('#loginEmail').value = email;
        $('#loginPw').focus();
      }).finally(updateRegBtn);
    });

    $('#formForgot').addEventListener('submit', e => {
      e.preventDefault();
      const email = $('#forgotEmail').value.trim();
      if (!email) { toast('メールアドレスを入力してください', 'error'); return; }
      busy($('#btnForgot'), '送信しています', async () => {
        const r = await api('forgotPassword', { email });
        toast(r.message, 'ok');
        switchAuth('login');
        $('#loginEmail').value = email;
      });
    });

    $('#btnLogout').addEventListener('click', () => {
      api('logout').catch(() => { /* 期限切れでも続行 */ });
      clearSession(); showAuth(); switchAuth('login');
      toast('ログアウトしました');
    });
  }

  function openPwModal(forced) {
    const d = $('#modalPw');
    d.dataset.forced = forced ? '1' : '';
    $('#pwForcedNote').hidden = !forced;
    $('#btnPwCancel').hidden = !!forced;
    $('#btnPwX').hidden = !!forced;
    $('#formPw').reset();
    openModal('modalPw');
  }
  function bindPw() {
    $('#btnOpenPw').addEventListener('click', () => {
      if (!state.token) { toast('ログインしてから変更してください', 'error'); return; }
      closeModal($('#modalSettings')); openPwModal(false);
    });
    $('#formPw').addEventListener('submit', e => {
      e.preventDefault();
      const cur = $('#pwCurrent').value, n1 = $('#pwNew').value, n2 = $('#pwNew2').value;
      if (!cur || !n1) { toast('パスワードを入力してください', 'error'); return; }
      if (n1 !== n2) { toast('確認用のパスワードが一致しません', 'error'); return; }
      if (n1.length < 8 || !/[A-Za-z]/.test(n1) || !/\d/.test(n1)) { toast('新しいパスワードは8文字以上で、英字と数字を両方含めてください', 'error'); return; }
      busy($('#btnPwSave'), '変更しています', async () => {
        await api('changePassword', { currentPassword: cur, newPassword: n1 });
        if (state.user) state.user.mustChange = false;
        const d = $('#modalPw'); d.dataset.forced = ''; closeModal(d);
        toast('パスワードを変更しました', 'ok');
      });
    });
  }

  /* ===== 設定画面 ===== */
  function fillSettings() {
    const s = settings();
    $('#setGasUrl').value = s.gasUrl || '';
    $('#setGasHint').textContent = URL_RE.test(CFG.GAS_URL || '') ? '空欄のときは config.js のURLを使います。' : 'config.js にURLが未設定です。ここに入力してください。';
    $('#setSilence').value = s.silenceSec;
    $('#btnOpenPw').hidden = !state.token;
  }
  function bindSettings() {
    $('#btnSaveSettings').addEventListener('click', () => {
      const url = $('#setGasUrl').value.trim();
      if (url && !URL_RE.test(url)) { toast('GASのURLは https://script.google.com/macros/s/…/exec の形で入力してください', 'error'); return; }
      const sil = Math.max(4, Math.min(60, parseInt($('#setSilence').value, 10) || 10));
      store.set('uta_settings', { gasUrl: url, silenceSec: sil });
      toast('設定を保存しました', 'ok');
      closeModal($('#modalSettings'));
    });
    $('#btnResetSettings').addEventListener('click', () => { store.del('uta_settings'); fillSettings(); toast('初期値に戻しました'); });
    $('#btnTestGas').addEventListener('click', () => {
      const url = $('#setGasUrl').value.trim() || gasUrl();
      const st = $('#gasStatus');
      if (!url) { st.textContent = 'URLが入力されていません'; return; }
      busy($('#btnTestGas'), '確認しています', async () => {
        try {
          const r = await (await fetch(url)).json();
          st.textContent = r.ok ? '接続できました（サーバー v' + r.version + '）' : '応答はありましたが内容が想定と違います';
          if (r.ok) $('#serverVersion').textContent = '／サーバー v' + r.version;
        } catch (e) { st.textContent = '接続できませんでした。URLとデプロイ設定を確認してください。'; }
      });
    });
  }

  /* ===== 音声入力（言葉につまっても途切れにくい） ===== */
  const Speech = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const isAndroid = /Android/i.test(navigator.userAgent);
    let rec = null, active = false, target = null, btn = null, base = '', sessionText = '', lastHeard = 0, watch = null, restartTimer = null;
    const join = (a, b) => {
      if (!a) return b; if (!b) return a;
      const cjk = /[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]$/.test(a);
      return a + (cjk || /\s$/.test(a) ? '' : ' ') + b;
    };
    function compose(ev) {
      let fin = '', interim = '';
      for (let i = 0; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) {
          // Androidは確定結果が累積で返ることがあるため、最長のものだけ採用して重複を防ぐ
          if (isAndroid) { if (t.length > fin.length) fin = t; } else fin += t;
        } else interim = isAndroid ? t : interim + t;
      }
      return { fin, interim };
    }
    function render(fin, interim) {
      target.value = join(base, fin + interim);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function startRec() {
      rec = new SR();
      rec.lang = CFG.SPEECH_LANG || 'ja-JP';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      sessionText = '';
      rec.onspeechstart = () => { lastHeard = Date.now(); };
      rec.onresult = ev => { lastHeard = Date.now(); const r = compose(ev); sessionText = r.fin; render(r.fin, r.interim); };
      rec.onerror = ev => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { toast('マイクの使用が許可されていません。ブラウザの設定で許可してください。', 'error'); stop(); }
        else if (ev.error === 'audio-capture') { toast('マイクが見つかりません', 'error'); stop(); }
        // no-speech / network / aborted は onend で自動再開
      };
      rec.onend = () => {
        base = join(base, sessionText); sessionText = '';
        if (target) { target.value = base; target.dispatchEvent(new Event('input', { bubbles: true })); }
        if (active) restartTimer = setTimeout(() => { if (active) { try { startRec(); } catch (e) { stop(); } } }, 150);
      };
      rec.start();
    }
    function start(t, b) {
      if (!SR) { toast('このブラウザは音声入力に対応していません。Chrome・Edge・Safari をお使いください。', 'error'); return; }
      stop();
      target = t; btn = b; base = t.value.trim(); active = true; lastHeard = Date.now();
      b.classList.add('rec'); b.setAttribute('aria-pressed', 'true');
      watch = setInterval(() => {
        const left = (settings().silenceSec || 10) * 1000 - (Date.now() - lastHeard);
        if (left <= 0) { stop(); toast('聞き取りを終了しました'); }
        else b.dataset.left = Math.ceil(left / 1000);
      }, 300);
      try { startRec(); } catch (e) { stop(); }
    }
    function stop() {
      active = false;
      clearInterval(watch); clearTimeout(restartTimer);
      if (rec) { try { rec.stop(); } catch (e) { /* noop */ } }
      rec = null;
      if (btn) { btn.classList.remove('rec'); btn.setAttribute('aria-pressed', 'false'); delete btn.dataset.left; }
      btn = null;
    }
    return { start, stop, isActive: b => active && btn === b };
  })();

  function bindMics() {
    $$('[data-mic]').forEach(b => {
      b.innerHTML = MIC;
      b.addEventListener('click', () => {
        if (Speech.isActive(b)) { Speech.stop(); return; }
        Speech.start(document.getElementById(b.dataset.mic), b);
      });
    });
  }

  /* ===== つくる ===== */
  function buildForm() {
    $('#genreChips').innerHTML = GENRES.map(([k, l], i) =>
      `<label class="chip"><input type="radio" name="genre" value="${k}" data-label="${esc(l)}"${i === 4 ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('');
    const opts = '<option value="auto">AIにおまかせ</option>' + VOICES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    $('#inVoice').innerHTML = opts;
    $('#stVoice').innerHTML = VOICES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    $('#genreFree').addEventListener('input', () => {
      if ($('#genreFree').value.trim()) $$('input[name=genre]').forEach(r => { r.checked = false; });
    });
    $('#genreChips').addEventListener('change', () => { $('#genreFree').value = ''; });
  }

  function readInput() {
    const free = $('#genreFree').value.trim();
    const r = $('input[name=genre]:checked');
    const input = {
      genre: free || (r ? r.dataset.label : ''),
      styleHint: free ? '' : (r ? r.value : ''),
      theme: $('#inTheme').value.trim(),
      voiceRef: $('#inVoiceRef').value.trim(),
      songRef: $('#inSongRef').value.trim(),
      feelings: $('#inFeel').value.trim(),
      voice: $('#inVoice').value,
    };
    if (!input.genre) { toast('ジャンルを選ぶか入力してください', 'error'); return null; }
    if (!input.theme && !input.feelings) { toast('テーマか、歌詞にしたい気持ちを入力してください', 'error'); return null; }
    return input;
  }
  function fillInput(input) {
    if (!input) return;
    const r = $(`input[name=genre][value="${input.styleHint || ''}"]`);
    if (r) { r.checked = true; $('#genreFree').value = ''; }
    else { $$('input[name=genre]').forEach(x => { x.checked = false; }); $('#genreFree').value = input.genre || ''; }
    $('#inTheme').value = input.theme || '';
    $('#inVoiceRef').value = input.voiceRef || '';
    $('#inSongRef').value = input.songRef || '';
    $('#inFeel').value = input.feelings || '';
    $('#inVoice').value = input.voice || 'auto';
  }

  function setProgress(step, err) {
    const order = ['lyrics', 'music', 'visual'];
    const box = $('#progress'); box.hidden = false;
    const idx = step === 'done' ? 3 : order.indexOf(step);
    $$('li', box).forEach((li, i) => {
      li.className = i < idx ? 'done' : i === idx ? (err ? 'err' : 'doing') : '';
    });
  }

  async function generate(input) {
    input = input || readInput();
    if (!input) return;
    Speech.stop();
    await busy($('#btnGenerate'), 'つくっています', async () => {
      let step = 'lyrics';
      try {
        // AI呼び出しはこの1回だけ（作詞・構成・コード進行・演出・ナレーション）
        setProgress('lyrics');
        const r = await api('genSong', { input });
        const g = r.song || {};
        const song = E.normalizeStructure(Object.assign({}, g, { input, genre: input.genre }));
        if (input.voice && input.voice !== 'auto') song.voice = input.voice;
        if (!VOICES.some(v => v[0] === song.voice)) song.voice = 'Kore';
        // 作曲（メロディ）はブラウザ内で行う＝AIを使わない
        step = 'music'; setProgress('music');
        song.patterns = g.patterns || {};
        E.composeMelody(song);
        E.finalize(song, CFG.TARGET_SECONDS || 180);
        step = 'visual'; setProgress('visual');
        song.narration = g.narration || {};
        song.scenes = Array.isArray(g.scenes) ? g.scenes : [];
        if (Array.isArray(g.palette) && g.palette.length) song.palette = g.palette;
        setProgress('done');
        setSong(song, null, null);
        toast('「' + song.title + '」ができました。ステージで聴いてみましょう。', 'ok');
        $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        setProgress(step, true);
        throw e;
      }
    });
  }

  async function directVisual(song) {
    try {
      const r = await api('genVisual', {
        song: {
          title: song.title, concept: song.concept || '', genre: song.genre, theme: (song.input || {}).theme || '',
          sections: song.arrangement.map(s => ({ label: s.label, first: s.lyrics[0] || '' })),
        },
      });
      song.narration = r.narration || {};
      song.scenes = Array.isArray(r.scenes) ? r.scenes : [];
      if (Array.isArray(r.palette) && r.palette.length) song.palette = r.palette;
    } catch (e) {
      if (e.code === 'AUTH') throw e;
      song.narration = song.narration || {}; song.scenes = song.scenes || [];
      toast('演出の作成に失敗しました（曲は使えます）：' + e.message, 'error');
    }
  }

  function setSong(song, songId, folderUrl) {
    state.song = song; state.songId = songId; state.folderUrl = folderUrl;
    player.reset();
    $('#stVoice').value = song.voice || 'Kore';
    renderResult();
    saveDraft();
  }

  function renderResult() {
    const song = state.song, box = $('#result');
    if (!song) { box.hidden = true; return; }
    const st = E.STYLES[song.styleKey] || {};
    const dur = song.durationSec || 0;
    box.hidden = false;
    box.innerHTML = `
      <div class="song-head">
        <h2 class="song-title">${esc(song.title)}</h2>
        ${song.concept ? `<p class="song-concept">${esc(song.concept)}</p>` : ''}
        <ul class="facts">
          <li>ジャンル<b>${esc(song.genre || st.label || '')}</b></li>
          <li>伴奏スタイル<b>${esc(st.label || '')}</b></li>
          <li>テンポ<b>${song.bpm}</b></li>
          <li>キー<b>${esc(song.key)}</b></li>
          <li>拍子<b>${esc(song.timeSig)}</b></li>
          <li>長さ<b>約${fmt(dur)}</b></li>
          <li>声<b>${esc(voiceLabel(song.voice))}</b></li>
        </ul>
        <div class="actions">
          <button type="button" class="btn primary" data-act="stage">ステージで聴く</button>
          <button type="button" class="btn" data-act="save">${state.songId ? '上書き保存' : '保存する'}</button>
          <button type="button" class="btn ghost" data-act="remusic" title="AIを使わないので何度でも無料です">メロディを作り直す</button>
          <button type="button" class="btn ghost" data-act="revisual" title="AIを1回使います">演出をやり直す</button>
          <button type="button" class="btn ghost" data-act="reall" title="AIを1回使います">歌詞からやり直す</button>
        </div>
      </div>
      <div class="secs">
        ${song.arrangement.map((s, i) => {
          const pat = (song.patterns || {})[s.pattern] || { chords: [] };
          return `<article class="sec k-${E.kindOf(s.pattern)}">
            <header><h3>${esc(s.label)}</h3><span class="bars">${s.bars}小節</span></header>
            <div class="chordrow" aria-label="コード進行">${(pat.chords || []).map(c => `<span>${esc(c)}</span>`).join('')}</div>
            <label class="sr" for="lyr${i}">${esc(s.label)}の歌詞</label>
            <textarea id="lyr${i}" data-lyr="${i}" rows="${Math.max(2, s.lyrics.length)}" placeholder="（歌詞なし。書き足すこともできます）">${esc(s.lyrics.join('\n'))}</textarea>
          </article>`;
        }).join('')}
      </div>`;
  }

  function bindResult() {
    const box = $('#result');
    const onLyr = debounce(() => { player.invalidate(); saveDraft(); }, 600);
    box.addEventListener('input', e => {
      const t = e.target.closest('[data-lyr]');
      if (!t || !state.song) return;
      state.song.arrangement[+t.dataset.lyr].lyrics = t.value.split('\n').map(x => x.trim()).filter(Boolean);
      onLyr();
    });
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b || !state.song) return;
      const act = b.dataset.act;
      if (act === 'stage') go('stage');
      if (act === 'save') busy(b, '保存しています', () => saveSong());
      if (act === 'remusic') {
        // ブラウザ内の作曲なのでAIの消費なし。歌詞の声（読み上げ）はそのまま使えます
        E.composeMelody(state.song);
        player.reset(); renderResult(); saveDraft();
        toast('メロディを作り直しました', 'ok');
      }
      if (act === 'revisual' && confirm('演出とナレーションをAIで作り直します（AIを1回使います）。よろしいですか？')) busy(b, '演出を考えています', async () => {
        await directVisual(state.song);
        player.reset(); renderResult(); saveDraft();
        toast('演出とナレーションを作り直しました', 'ok');
      });
      if (act === 'reall') {
        if (!confirm('歌詞から作り直します（AIを1回使います）。今の歌詞は置き換わります。よろしいですか？')) return;
        fillInput(state.song.input); window.scrollTo({ top: 0, behavior: 'smooth' }); generate(state.song.input); }
    });
  }

  /* 下書き（ブラウザ内） */
  const saveDraft = debounce(() => {
    if (!state.song || !state.user) return;
    store.set('uta_draft', { email: state.user.email, song: state.song, songId: state.songId, folderUrl: state.folderUrl });
  }, 400);
  function restoreDraft() {
    const d = store.get('uta_draft', null);
    if (!d || !state.user || d.email !== state.user.email || !d.song) return;
    state.song = d.song; state.songId = d.songId || null; state.folderUrl = d.folderUrl || null;
    $('#stVoice').value = d.song.voice || 'Kore';
    fillInput(d.song.input);
    renderResult();
  }

  /* ===== 保存・マイソング ===== */
  async function saveSong() {
    const r = await api('saveSong', { songId: state.songId, song: state.song });
    state.songId = r.songId; state.folderUrl = r.folderUrl;
    renderResult(); saveDraft(); updateFolderLink();
    toast('保存しました', 'ok');
  }
  async function loadSongs() {
    const box = $('#songList');
    box.innerHTML = '<p class="muted">読み込んでいます…</p>';
    try {
      const r = await api('listSongs');
      if (!r.songs.length) {
        box.innerHTML = '<div class="empty"><p>保存した曲はまだありません。</p><button type="button" class="btn primary" data-goto="create">曲をつくる</button></div>';
        return;
      }
      box.innerHTML = r.songs.map(s => `
        <div class="songrow">
          <div class="grow"><div class="t">${esc(s.title)}</div>
            <div class="m">${esc(s.genre)}　${esc(new Date(Number(s.updatedAt)).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }))}${s.hasAudio ? '　音声保存済み' : ''}</div></div>
          <button type="button" class="btn small primary" data-load="${esc(s.songId)}">開く</button>
          <button type="button" class="btn small ghost" data-del="${esc(s.songId)}" data-title="${esc(s.title)}">削除</button>
        </div>`).join('');
    } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }
  function bindSongs() {
    $('#btnSongsRefresh').addEventListener('click', loadSongs);
    $('#songList').addEventListener('click', e => {
      const l = e.target.closest('[data-load]'), d = e.target.closest('[data-del]');
      if (l) busy(l, '開いています', async () => {
        const r = await api('loadSong', { songId: l.dataset.load });
        setSong(r.song, r.songId, r.folderUrl);
        fillInput(r.song.input);
        go('stage');
      });
      if (d) {
        if (!confirm('「' + d.dataset.title + '」を削除します。ドライブのフォルダはゴミ箱に移動します。よろしいですか？')) return;
        busy(d, '削除しています', async () => {
          await api('deleteSong', { songId: d.dataset.del });
          if (state.songId === d.dataset.del) state.songId = null;
          toast('削除しました', 'ok'); loadSongs();
        });
      }
    });
  }

  /* ===== 読み上げ文の整形（指示語が混ざらないように） ===== */
  const DIRECTION = /(繰り返し|くり返し|リピート|間奏|repeat|×\s*\d|x\s*\d|コーラス|セリフ|語り|ささや|囁|声で|調で|風に|ゆっくり|明るく|静かに|力強く|フェード|ハモ)/i;
  function cleanSpeech(t) {
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
  const speechText = lines => cleanSpeech((lines || []).join('\n'));

  /* ===== 歌詞の声 ===== */
  const clipCache = new Map();
  const currentVoice = () => $('#stVoice').value || (state.song && state.song.voice) || 'Kore';
  const mixState = () => ({
    melody: $('#mixMelody').checked, accomp: $('#mixAccomp').checked, drums: $('#mixDrums').checked,
    vocal: $('#mixVocal').checked, narr: $('#mixNarr').checked,
  });
  function clipsBySection() {
    const out = {};
    if (!state.song || !$('#mixVocal').checked) return out;
    const v = currentVoice();
    state.song.arrangement.forEach((s, i) => {
      const txt = speechText(s.lyrics);
      const c = txt && clipCache.get(v + '|' + txt);
      if (c) out[i] = c;
    });
    return out;
  }
  function narrClips() {
    const o = {};
    if (!state.song || !$('#mixNarr').checked) return o;
    const v = currentVoice(), n = state.song.narration || {};
    ['intro', 'outro'].forEach(k => { const txt = cleanSpeech(n[k]); const c = txt && clipCache.get(v + '|' + txt); if (c) o[k] = c; });
    return o;
  }
  function voiceStatus() {
    if (!state.song) return;
    const v = currentVoice();
    let total = 0, done = 0;
    const seen = new Set();
    const check = txt => { if (!txt || seen.has(txt)) return; seen.add(txt); total++; if (clipCache.has(v + '|' + txt)) done++; };
    state.song.arrangement.forEach(s => check(speechText(s.lyrics)));
    const n = state.song.narration || {};
    check(cleanSpeech(n.intro)); check(cleanSpeech(n.outro));
    $('#ttsStatus').textContent = total ? (done === total ? 'すべての声ができています' : `${done} / ${total} 件の声ができています`) : '';
  }
  async function makeVoices() {
    const song = state.song; if (!song) return;
    const v = currentVoice();
    const jobs = [], seen = new Set();
    const add = txt => { if (!txt) return; const k = v + '|' + txt; if (clipCache.has(k) || seen.has(k)) return; seen.add(k); jobs.push({ k, txt }); };
    song.arrangement.forEach(s => add(speechText(s.lyrics)));
    const n = song.narration || {};
    add(cleanSpeech(n.intro)); add(cleanSpeech(n.outro));
    if (!jobs.length) { toast('声はすべてできています', 'ok'); return; }
    let done = 0, reused = 0;
    const st = $('#ttsStatus');
    st.textContent = `0 / ${jobs.length} 件`;
    await busy($('#btnTts'), '声をつくっています', async () => {
      await pool(jobs, CFG.TTS_PARALLEL || 2, async j => {
        const r = await api('tts', { text: j.txt, voice: v });
        clipCache.set(j.k, E.b64ToClip(r.audio, r.rate || 24000));
        if (r.cached) reused++;
        done++; st.textContent = `${done} / ${jobs.length} 件`;
      });
      player.invalidate();
      voiceStatus();
      toast('歌詞の声ができました' + (reused ? `（${reused}件は保存済みの声を再利用し、AIは使っていません）` : '') + '。再生すると曲に重なります。', 'ok');
    });
    voiceStatus();
  }

  /* ===== プレイヤー ===== */
  function lowerBound(evs, t) { let lo = 0, hi = evs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (evs[m].t < t) lo = m + 1; else hi = m; } return lo; }
  const player = {
    ctx: null, mixer: null, tl: null, outs: null, playing: false, startAt: 0, offset: 0, idx: 0, timer: null, dirty: true,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.mixer = E.createMixer(this.ctx, this.ctx.destination);
        this.applyMix();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    timeline() {
      if (!state.song) return null;
      if (this.dirty || !this.tl) { this.tl = E.buildTimeline(state.song, { clips: clipsBySection(), narr: narrClips() }); this.dirty = false; }
      return this.tl;
    },
    applyMix() { if (this.mixer) E.applyMix(this.mixer, mixState()); },
    get time() { return this.playing ? this.ctx.currentTime - this.startAt : this.offset; },
    play() {
      if (!state.song) return;
      this.ensure();
      const tl = this.timeline();
      if (this.offset >= tl.duration - .05) this.offset = 0;
      const off = this.offset, now = this.ctx.currentTime;
      this.outs = E.createSession(this.ctx, this.mixer);
      const g = this.mixer.music.gain; g.cancelScheduledValues(now); g.setValueAtTime(1, now);
      this.startAt = now + .08 - off;
      // 途中から再生するとき、鳴っているはずの音声を途中から鳴らす
      tl.events.forEach(ev => { if (ev.type === 'clip' && ev.t < off && ev.t + ev.dur > off) E.scheduleEvent(this.ctx, this.outs, this.mixer, ev, this.startAt + off, off - ev.t); });
      this.idx = lowerBound(tl.events, off);
      this.playing = true;
      this.tick();
      this.timer = setInterval(() => this.tick(), 40);
      bgMedia(true); updatePlayBtn();
    },
    tick() {
      const tl = this.tl, now = this.ctx.currentTime, songNow = now - this.startAt, horizon = songNow + .25;
      while (this.idx < tl.events.length && tl.events[this.idx].t < horizon) {
        const ev = tl.events[this.idx++];
        const when = this.startAt + ev.t;
        if (when < now - .05) continue;
        E.scheduleEvent(this.ctx, this.outs, this.mixer, ev, Math.max(when, now), 0);
      }
      if (songNow >= tl.duration) this.stop();
    },
    halt() {
      clearInterval(this.timer); this.timer = null;
      if (this.outs) { this.outs.dispose(); this.outs = null; }
      if (this.mixer) { const g = this.mixer.music.gain, n = this.ctx.currentTime; g.cancelScheduledValues(n); g.setValueAtTime(1, n); }
      this.playing = false;
      bgMedia(false); updatePlayBtn();
    },
    pause() { if (!this.playing) return; this.offset = this.time; this.halt(); },
    stop() { this.halt(); this.offset = 0; },
    toggle() { this.playing ? this.pause() : this.play(); },
    seek(sec) { const was = this.playing; if (was) this.halt(); this.offset = Math.max(0, sec); if (was) this.play(); },
    invalidate() { const was = this.playing, t = this.time; if (was) this.halt(); this.dirty = true; this.offset = t; if (was) this.play(); },
    reset() { if (this.playing) this.halt(); this.offset = 0; this.dirty = true; this.tl = null; },
  };
  function updatePlayBtn() {
    const b = $('#btnPlay');
    b.innerHTML = player.playing ? PAUSE : PLAY;
    b.setAttribute('aria-label', player.playing ? '一時停止' : '再生');
  }

  /* ===== ステージ表示 ===== */
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const HEX = /^#[0-9a-f]{6}$/i;
  const palette = () => {
    const p = ((state.song && state.song.palette) || []).filter(c => HEX.test(c));
    return p.length >= 2 ? p.slice(0, 3) : ['#3B2C7A', '#B3205A', '#E3A72F'];
  };
  const bgMode = () => ($('input[name=bgMode]:checked') || {}).value || 'auto';
  let freq = null, seeking = false;
  const lastText = {};
  const setText = (id, txt) => { if (lastText[id] !== txt) { lastText[id] = txt; document.getElementById(id).textContent = txt; } };

  function drawCanvas() {
    const c = $('#stageCanvas'), w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const useAuto = bgMode() === 'auto' || !$('#stageBg').firstChild;
    const tm = reduceMotion.matches ? 0 : performance.now() / 1000;
    if (useAuto) {
      g.fillStyle = '#12172E'; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'screen';
      palette().forEach((col, i) => {
        const x = w * (.5 + .38 * Math.sin(tm * .11 * (i + 1) + i * 2.1));
        const y = h * (.42 + .28 * Math.cos(tm * .09 * (i + 1) + i));
        const r = Math.max(w, h) * (.42 + .08 * i);
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, col + 'AA'); gr.addColorStop(1, col + '00');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      });
      g.globalCompositeOperation = 'source-over';
    }
    const vg = g.createLinearGradient(0, h * .4, 0, h);
    vg.addColorStop(0, 'rgba(10,12,30,0)'); vg.addColorStop(1, 'rgba(10,12,30,.78)');
    g.fillStyle = vg; g.fillRect(0, 0, w, h);
    if (player.mixer && player.playing) {
      const an = player.mixer.analyser;
      if (!freq || freq.length !== an.frequencyBinCount) freq = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(freq);
      const n = 48, bw = w / n;
      g.fillStyle = 'rgba(227,167,47,.5)';
      for (let i = 0; i < n; i++) {
        const v = freq[Math.floor(i * freq.length * .7 / n)] / 255;
        const bh = v * h * .14;
        g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      }
    }
  }

  function updateLyrics() {
    const tl = player.timeline(); if (!tl) return;
    const t = player.time;
    const title = $('#stTitle');
    const showTitle = t < tl.musicStart + 2.5 && (!tl.sections[0] || t < tl.sections[0].lyrStart + 1);
    title.style.opacity = showTitle || t >= tl.musicEnd ? '1' : '0';
    setText('stTitle', state.song.title);
    let sec = null, si = -1;
    for (let i = 0; i < tl.sections.length; i++) { if (t >= tl.sections[i].start && t < tl.sections[i].end) { sec = tl.sections[i]; si = i; break; } }
    if (!sec || showTitle) { setText('stSection', ''); setText('stPrev', ''); setText('stNow', ''); setText('stNext', ''); return; }
    setText('stSection', sec.label);
    const L = sec.lyrics;
    if (!L.length) {
      const nx = tl.sections.slice(si + 1).find(s => s.lyrics.length);
      setText('stPrev', ''); setText('stNow', ''); setText('stNext', nx ? nx.lyrics[0] : '');
      return;
    }
    const rel = (t - sec.lyrStart) / sec.lyrDur * L.length;
    const idx = Math.max(0, Math.min(L.length - 1, Math.floor(rel)));
    const p = rel < 0 ? 0 : rel >= L.length ? 1 : rel - idx;
    setText('stPrev', L[idx - 1] || '');
    setText('stNow', L[idx]);
    $('#stNow').style.setProperty('--p', p.toFixed(3));
    let next = L[idx + 1];
    if (!next) { const nx = tl.sections.slice(si + 1).find(s => s.lyrics.length); next = nx ? nx.lyrics[0] : ''; }
    setText('stNext', next || '');
  }

  function updateTime() {
    const tl = player.timeline(); if (!tl) return;
    const sk = $('#seek');
    if (+sk.max !== Math.round(tl.duration * 10) / 10) sk.max = (Math.round(tl.duration * 10) / 10).toString();
    if (!seeking) sk.value = player.time;
    setText('timeNow', fmt(seeking ? +sk.value : player.time));
    setText('timeDur', fmt(tl.duration));
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!state.song || $('#panel-stage').hidden || $('#appView').hidden) return;
    drawCanvas(); updateLyrics(); updateTime();
  }

  function enterStage() {
    const has = !!state.song;
    $('#stageEmpty').hidden = has; $('#stageWrap').hidden = !has;
    if (!has) return;
    $('#stVoice').value = state.song.voice || 'Kore';
    renderScenes(); voiceStatus(); updateFolderLink(); updatePlayBtn();
  }

  /* 背景 */
  function setBg(src, mime) {
    const box = $('#stageBg');
    box.innerHTML = '';
    if (!src) return;
    if (/^video\//.test(mime)) {
      const v = document.createElement('video');
      v.src = src; v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', '');
      box.appendChild(v);
      if (player.playing) v.play().catch(() => { /* 自動再生不可は無視 */ });
    } else {
      const img = document.createElement('img'); img.src = src; img.alt = ''; box.appendChild(img);
    }
  }
  function bgMedia(play) {
    const v = $('#stageBg video');
    if (!v) return;
    if (play) v.play().catch(() => { /* noop */ }); else v.pause();
  }
  function updateFolderLink() {
    const a = $('#folderLink');
    if (state.folderUrl) { a.href = state.folderUrl; a.hidden = false; } else a.hidden = true;
  }
  async function ensureSaved() { if (!state.songId) await saveSong(); }
  const blobToB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('ファイルを読み込めませんでした')); r.readAsDataURL(blob); });

  async function loadMediaList() {
    const box = $('#mediaList');
    await ensureSaved();
    box.innerHTML = '<p class="small muted">読み込んでいます…</p>';
    const r = await api('listMedia', { songId: state.songId });
    if (!r.files.length) { box.innerHTML = '<p class="small muted">フォルダに画像や動画がまだありません。</p>'; return; }
    box.innerHTML = r.files.map(f => `<button type="button" data-media="${esc(f.id)}" data-mime="${esc(f.mimeType)}">${/^video/.test(f.mimeType) ? '動画' : '画像'}：${esc(f.name)}（${(f.size / 1048576).toFixed(1)}MB）</button>`).join('');
  }

  function bindStage() {
    updatePlayBtn();
    $('#btnPlay').addEventListener('click', () => player.toggle());
    $('#btnStop').addEventListener('click', () => player.stop());
    const sk = $('#seek');
    sk.addEventListener('input', () => { seeking = true; });
    sk.addEventListener('change', () => { seeking = false; player.seek(+sk.value); });
    ['mixMelody', 'mixAccomp', 'mixDrums'].forEach(id => $('#' + id).addEventListener('change', () => player.applyMix()));
    ['mixVocal', 'mixNarr'].forEach(id => $('#' + id).addEventListener('change', () => { player.applyMix(); player.invalidate(); }));
    $('#stVoice').addEventListener('change', () => {
      if (state.song) { state.song.voice = $('#stVoice').value; saveDraft(); renderResult(); }
      player.invalidate(); voiceStatus();
    });
    $('#btnTts').addEventListener('click', makeVoices);
    $('#btnWav').addEventListener('click', () => busy($('#btnWav'), '書き出しています', async () => {
      const buf = await E.renderOffline(state.song, { clips: clipsBySection(), narr: narrClips(), mix: mixState() }, 44100, 2);
      const blob = E.toWav(buf);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = safeName(state.song.title) + '.wav';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      $('#exportStatus').textContent = 'WAVファイルを保存しました（' + (blob.size / 1048576).toFixed(1) + 'MB）';
    }));
    $('#btnDrive').addEventListener('click', () => busy($('#btnDrive'), 'ドライブに保存しています', async () => {
      await ensureSaved();
      const buf = await E.renderOffline(state.song, { clips: clipsBySection(), narr: narrClips(), mix: mixState() }, 22050, 1);
      const blob = E.toWav(buf);
      if (blob.size > 24 * 1048576) throw new Error('音声が大きすぎてドライブに保存できません。WAVで保存してください。');
      const data = await blobToB64(blob);
      await api('saveAudio', { songId: state.songId, data, name: safeName(state.song.title) + '.wav' });
      $('#exportStatus').textContent = 'ドライブのフォルダに保存しました（軽量版 22kHz モノラル）';
      updateFolderLink();
      toast('ドライブに保存しました', 'ok');
    }));

    $$('input[name=bgMode]').forEach(r => r.addEventListener('change', () => {
      const m = bgMode();
      $('#bgLocalBox').hidden = m !== 'local';
      $('#bgDriveBox').hidden = m !== 'drive';
      if (m === 'auto') setBg(null);
    }));
    let localUrl = null;
    $('#bgFile').addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      if (localUrl) URL.revokeObjectURL(localUrl);
      localUrl = URL.createObjectURL(f);
      setBg(localUrl, f.type);
    });
    $('#btnMediaRefresh').addEventListener('click', () => busy($('#btnMediaRefresh'), '読み込んでいます', loadMediaList));
    $('#mediaList').addEventListener('click', e => {
      const b = e.target.closest('[data-media]'); if (!b) return;
      busy(b, '取り込んでいます', async () => {
        const r = await api('getMedia', { songId: state.songId, fileId: b.dataset.media });
        const bytes = Uint8Array.from(atob(r.data), ch => ch.charCodeAt(0));
        setBg(URL.createObjectURL(new Blob([bytes], { type: r.mimeType })), r.mimeType);
      });
    });
    $('#bgUpload').addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 8 * 1048576) { toast('画像は8MBまでです', 'error'); return; }
      busy($('#btnMediaRefresh'), 'アップロードしています', async () => {
        await ensureSaved();
        await api('uploadImage', { songId: state.songId, name: f.name, mimeType: f.type, data: await blobToB64(f) });
        e.target.value = '';
        await loadMediaList();
        toast('画像をドライブに追加しました', 'ok');
      });
    });

    $('#btnFull').addEventListener('click', () => {
      const s = $('#stage');
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      if (s.classList.contains('pseudo-fs')) { s.classList.remove('pseudo-fs'); return; }
      if (s.requestFullscreen) s.requestFullscreen().catch(() => s.classList.add('pseudo-fs'));
      else if (s.webkitRequestFullscreen) s.webkitRequestFullscreen();
      else s.classList.add('pseudo-fs');
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') $('#stage').classList.remove('pseudo-fs');
      if (e.code === 'Space' && !$('#panel-stage').hidden && !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
        e.preventDefault(); player.toggle();
      }
    });
    $('#btnCopyScenes').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(sceneText()); toast('撮影指示をコピーしました', 'ok'); }
      catch (e) { toast('コピーできませんでした', 'error'); }
    });
  }
  const safeName = s => String(s || 'song').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

  /* ===== Google Earth Studio 撮影指示 ===== */
  const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  function sceneRows() {
    const tl = player.timeline(); if (!tl) return [];
    const sc = (state.song.scenes || []);
    return tl.sections.map((s, i) => {
      const base = s.label.replace(/（くり返し）$/, '');
      const x = sc.find(v => v && v.label === s.label) || sc.find(v => v && v.label === base) || sc[i] || {};
      return {
        label: s.label, start: s.start, end: s.end, place: x.place || '', desc: x.description || '',
        lat: num(x.lat, null), lng: num(x.lng, null), alt: Math.round(num(x.altitude, 1500)),
        heading: Math.round(num(x.heading, 0)), tilt: Math.round(num(x.tilt, 60)), motion: x.motion || '固定',
      };
    });
  }
  function earthUrl(r) {
    if (r.lat != null && r.lng != null && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180) {
      return `https://earth.google.com/web/@${r.lat},${r.lng},${r.alt}a,${Math.round(r.alt * 1.5)}d,35y,${r.heading}h,${r.tilt}t,0r`;
    }
    return r.place ? 'https://earth.google.com/web/search/' + encodeURIComponent(r.place) : '';
  }
  function renderScenes() {
    const rows = sceneRows();
    $('#sceneBody').innerHTML = rows.map(r => {
      const u = earthUrl(r);
      return `<tr>
        <td>${esc(r.label)}</td>
        <td class="num">${fmt(r.start)}〜${fmt(r.end)}</td>
        <td>${esc(r.place || '—')}${r.lat != null ? `<br><span class="muted small">${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}</span>` : ''}</td>
        <td>${esc(r.desc)}</td>
        <td class="num">${esc(r.motion)}<br><span class="muted small">高度${r.alt}m／向き${r.heading}°／傾き${r.tilt}°</span></td>
        <td class="num">${Math.round(r.end - r.start)}秒</td>
        <td>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">Google Earth</a>` : ''}</td>
      </tr>`;
    }).join('');
  }
  function sceneText() {
    const s = state.song;
    const head = `「${s.title}」Google Earth Studio 撮影指示（全体 ${fmt(player.timeline().duration)}）\n`;
    return head + sceneRows().map(r =>
      `[${fmt(r.start)}〜${fmt(r.end)}] ${r.label}｜${r.place}${r.lat != null ? `（${r.lat}, ${r.lng}）` : ''}｜高度${r.alt}m 向き${r.heading}° 傾き${r.tilt}°｜カメラ：${r.motion}｜${Math.round(r.end - r.start)}秒｜${r.desc}`
    ).join('\n');
  }

  /* ===== 画面切り替え ===== */
  function go(tab) {
    $$('[data-nav]').forEach(b => b.setAttribute('aria-current', b.dataset.nav === tab ? 'page' : 'false'));
    $$('.panel').forEach(p => { p.hidden = p.id !== 'panel-' + tab; });
    if (tab !== 'stage' && player.playing) player.pause();
    if (tab === 'stage') enterStage();
    if (tab === 'songs') loadSongs();
    window.scrollTo({ top: 0 });
  }

  /* ===== 起動 ===== */
  function init() {
    $$('.app-version').forEach(e => { e.textContent = CFG.VERSION || 'v1.0.0'; });
    buildForm(); initEyes(); bindModals(); bindAuth(); bindPw(); bindSettings(); bindMics(); bindResult(); bindSongs(); bindStage();
    $$('[data-nav]').forEach(b => b.addEventListener('click', () => go(b.dataset.nav)));
    document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) go(g.dataset.goto); });
    $('#formCreate').addEventListener('submit', e => { e.preventDefault(); generate(); });
    requestAnimationFrame(loop);

    if (!store.get('uta_seen_guide', false)) { store.set('uta_seen_guide', true); setTimeout(() => openModal('modalGuide'), 300); }
    if (!gasUrl()) { showAuth(); toast('最初に「設定」からサーバー（GAS）のURLを入力してください', 'error'); return; }
    if (state.token) {
      api('me').then(r => {
        state.user = r.user; showApp(); restoreDraft();
        if (r.user.mustChange) openPwModal(true);
      }).catch(() => { clearSession(); showAuth(); });
    } else showAuth();
  }
  document.addEventListener('DOMContentLoaded', init);
})();

/*!
 * うたつくる 音楽エンジン engine.js v1.0.0
 * Web Audio API だけで、ジャンル別の伴奏・ドラム・メロディと、
 * Gemini TTS の読み上げ音声（歌詞の声・ナレーション）をミックスします。
 * リアルタイム再生と、高速なオフライン書き出し（WAV）の両方に対応。
 */
(function (global) {
  'use strict';

  /* ===== 音名・コード ===== */
  const PC = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };
  const pcOf = s => PC[String(s).toUpperCase()];
  const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

  function noteToMidi(tok) {
    const m = /^([A-Ga-g])([#b]?)(\d)$/.exec(String(tok).replace(/♯/g, '#').replace(/♭/g, 'b'));
    if (!m) return null;
    const pc = pcOf(m[1] + m[2]);
    if (pc == null) return null;
    return (Number(m[3]) + 1) * 12 + pc;
  }

  const QUAL = {
    '': [0, 4, 7], M: [0, 4, 7], maj: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7],
    '7': [0, 4, 7, 10], M7: [0, 4, 7, 11], maj7: [0, 4, 7, 11], '△7': [0, 4, 7, 11],
    m7: [0, 3, 7, 10], '-7': [0, 3, 7, 10], mM7: [0, 3, 7, 11], m7b5: [0, 3, 6, 10], 'm7-5': [0, 3, 6, 10], 'ø': [0, 3, 6, 10],
    dim: [0, 3, 6], dim7: [0, 3, 6, 9], o: [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8],
    '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '9': [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
    add9: [0, 4, 7, 14], sus4: [0, 5, 7], sus2: [0, 2, 7], '7sus4': [0, 5, 7, 10],
    '11': [0, 4, 7, 10, 14, 17], '13': [0, 4, 7, 10, 14, 21], '7b9': [0, 4, 7, 10, 13], '7#9': [0, 4, 7, 10, 15], '5': [0, 7],
  };

  function parseChord(sym) {
    if (!sym) return null;
    let s = String(sym).trim().replace(/♭/g, 'b').replace(/♯/g, '#');
    if (!s || /^(N\.?C\.?|-|%)$/i.test(s)) return null;
    let bass = null;
    const sl = s.split('/');
    s = sl[0];
    if (sl[1]) { const bm = /^([A-G][#b]?)/.exec(sl[1]); if (bm) bass = pcOf(bm[1]); }
    const m = /^([A-G][#b]?)(.*)$/.exec(s);
    if (!m) return null;
    const root = pcOf(m[1]);
    if (root == null) return null;
    const q = m[2].replace(/[()]/g, '');
    let iv = QUAL[q];
    if (!iv) {
      let best = '';
      for (const k in QUAL) if (k && q.startsWith(k) && k.length > best.length) best = k;
      iv = QUAL[best] || QUAL[''];
    }
    return { root, iv, bass: bass == null ? root : bass, sym: String(sym) };
  }

  const splitChords = str => String(str || '').split(/[\s|]+/).map(parseChord).filter(Boolean);

  /* ===== 音色 ===== */
  const T = {
    piano: { w1: 'triangle', w2: 'sine', oct2: 2, det: 0, a: .004, d: .9, s: 0, r: .25, cut: 3800, gain: .2 },
    epiano: { w1: 'sine', w2: 'triangle', oct2: 1, det: 4, a: .006, d: 1.2, s: .15, r: .35, cut: 3000, gain: .2 },
    bell: { w1: 'sine', w2: 'sine', oct2: 3, det: 0, a: .003, d: 1.4, s: 0, r: .5, cut: 6000, gain: .07 },
    strings: { w1: 'sawtooth', w2: 'sawtooth', oct2: 1, det: 9, a: .35, d: .4, s: .85, r: .7, cut: 2300, gain: .05 },
    pad: { w1: 'sawtooth', w2: 'triangle', oct2: 1, det: 7, a: .25, d: .5, s: .8, r: .8, cut: 1600, gain: .055 },
    nylon: { w1: 'triangle', w2: 'sawtooth', oct2: 1, det: 2, a: .003, d: .55, s: 0, r: .18, cut: 2400, gain: .13 },
    guitar: { w1: 'sawtooth', w2: 'triangle', oct2: 1, det: 3, a: .003, d: .35, s: .1, r: .12, cut: 2000, gain: .075 },
    dist: { w1: 'sawtooth', w2: 'square', oct2: 1, det: 8, a: .004, d: .25, s: .65, r: .1, cut: 1700, gain: .055 },
    pluck: { w1: 'square', w2: 'sawtooth', oct2: 2, det: 5, a: .002, d: .25, s: 0, r: .1, cut: 3200, gain: .065 },
    accordion: { w1: 'sawtooth', w2: 'square', oct2: 1, det: 14, a: .02, d: .2, s: .7, r: .08, cut: 2600, gain: .055 },
    chip: { w1: 'square', a: .002, d: .1, s: .4, r: .04, cut: 9000, gain: .045 },
    lead_saw: { w1: 'sawtooth', w2: 'sawtooth', oct2: 1, det: 6, a: .01, d: .2, s: .7, r: .12, cut: 3000, gain: .07, vib: .004 },
    lead_bright: { w1: 'square', w2: 'sawtooth', oct2: 1, det: 5, a: .01, d: .2, s: .7, r: .12, cut: 3400, gain: .055, vib: .004 },
    lead_square: { w1: 'square', a: .004, d: .1, s: .75, r: .06, cut: 7000, gain: .055, vib: .003 },
    lead_soft: { w1: 'triangle', w2: 'sine', oct2: 2, det: 0, a: .05, d: .3, s: .7, r: .3, cut: 2500, gain: .12, vib: .003 },
    sax: { w1: 'sawtooth', w2: 'square', oct2: 1, det: 4, a: .04, d: .25, s: .75, r: .12, cut: 1900, gain: .065, vib: .005, fenv: .12 },
    brass: { w1: 'sawtooth', w2: 'sawtooth', oct2: 1, det: 10, a: .03, d: .2, s: .75, r: .1, cut: 2600, gain: .06, fenv: .08 },
    violin: { w1: 'sawtooth', w2: 'sawtooth', oct2: 1, det: 5, a: .09, d: .3, s: .85, r: .2, cut: 3200, gain: .055, vib: .006 },
    fiddle: { w1: 'sawtooth', a: .04, d: .2, s: .8, r: .12, cut: 3600, gain: .065, vib: .007 },
    flute: { w1: 'sine', w2: 'triangle', oct2: 1, det: 3, a: .06, d: .2, s: .8, r: .15, cut: 5000, gain: .15, vib: .005 },
    twang: { w1: 'sawtooth', w2: 'square', oct2: 1, det: 2, a: .003, d: .3, s: .35, r: .1, cut: 2800, gain: .065, vib: .003 },
    pluck_lead: { w1: 'triangle', w2: 'sawtooth', oct2: 1, det: 2, a: .003, d: .6, s: .15, r: .2, cut: 3000, gain: .14 },
    bass_finger: { w1: 'triangle', w2: 'sine', oct2: 1, det: 0, a: .006, d: .5, s: .55, r: .08, cut: 900, gain: .3 },
    bass_pick: { w1: 'sawtooth', w2: 'triangle', oct2: 1, det: 0, a: .004, d: .3, s: .6, r: .06, cut: 800, gain: .16 },
    bass_synth: { w1: 'sawtooth', w2: 'square', oct2: .5, det: 0, a: .005, d: .3, s: .7, r: .08, cut: 650, gain: .14 },
    bass_upright: { w1: 'sine', w2: 'triangle', oct2: 1, det: 0, a: .008, d: .45, s: .25, r: .08, cut: 750, gain: .36 },
    bass_chip: { w1: 'triangle', a: .002, d: .1, s: .8, r: .03, cut: 4000, gain: .26 },
  };

  /* ===== ジャンル別スタイル =====
   * 1小節を16分音符で刻んだステップ列（3拍子は12ステップ）。長さ32は2小節周期。
   * ドラム: x=打つ / X=強く打つ
   * ベース: R=根音 5=5度 3=3度 8=オクターブ上 N=次のコードの根音 W=ウォーキング B=ブギ / .=伸ばす _=休み
   * 伴奏: x=和音 X=和音を長く a=分散和音 / .=伸ばす _=休み
   */
  const STYLES = {
    rock: { label: 'ロック', beats: 4, swing: 0, bpm: [112, 140],
      drums: { k: 'x.......x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
      bass: { p: 'R.R.R.R.R.R.R.R.', gate: .8, tim: 'bass_pick' },
      comp: [{ p: 'x.x.x.x.x.x.x.x.', gate: .85, tim: 'dist', voicing: 'power' }], lead: 'lead_saw' },
    salsa: { label: 'サルサ', beats: 4, swing: 0, bpm: [150, 190],
      drums: { r: '....x...x.......x.....x.....x...', cb: 'x...x...x...x...', cgh: '....x...........', cgl: '............x.x.', sh: 'x.x.x.x.x.x.x.x.' },
      bass: { p: '......5.....N...', gate: 1, tim: 'bass_finger' },
      comp: [{ p: 'a.aa.a.aa.aa.a.a', gate: .9, tim: 'piano', voicing: 'arp' }], lead: 'brass' },
    bachata: { label: 'バチャータ', beats: 4, swing: 0, bpm: [120, 140],
      drums: { cgh: 'x.x.x.x.x.x.x.x.', sh: 'x.xxx.xxx.xxx.xx', k: 'x.......x.......' }, drumGain: .8,
      bass: { p: 'R.....5.R.....N.', gate: .7, tim: 'bass_finger' },
      comp: [{ p: 'aaaaaaaaaaaaaaaa', gate: .9, tim: 'nylon', voicing: 'arp' }], lead: 'pluck_lead' },
    showa: { label: '昭和歌謡', beats: 4, swing: 0, bpm: [80, 110],
      drums: { k: 'x.......x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, drumGain: .7,
      bass: { p: 'R.......5.......', gate: .9, tim: 'bass_finger' },
      comp: [{ p: 'X...............', gate: 1, tim: 'strings', voicing: 'open' }, { p: 'a.a.a.a.a.a.a.a.', gate: .9, tim: 'nylon', voicing: 'arp' }], lead: 'sax' },
    reiwa: { label: '令和ミュージック', beats: 4, swing: 0, bpm: [120, 150],
      drums: { k: 'x.....x...x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
      bass: { p: 'R.R.R.R.R.R.R.R.', gate: .7, tim: 'bass_synth' },
      comp: [{ p: 'X.......X.......', gate: 1, tim: 'pad', voicing: 'open' }, { p: 'a.a.a.a.a.a.a.a.', gate: .6, tim: 'pluck', voicing: 'arp' }], lead: 'lead_bright' },
    swing: { label: 'スウィング', beats: 4, swing: 1, bpm: [130, 180],
      drums: { rd: 'x...x.x.x...x.x.', h: '....x.......x...', k: 'x...x...x...x...' }, drumGain: .8,
      bass: { p: 'W...W...W...W...', gate: .9, tim: 'bass_upright' },
      comp: [{ p: 'x...x...x...x...', gate: .35, tim: 'guitar', voicing: 'shell' }], lead: 'brass' },
    country: { label: 'カントリーウエスタン', beats: 4, swing: .3, bpm: [100, 130],
      drums: { k: 'x.......x.......', s: '....x.......x...', sh: 'x.x.x.x.x.x.x.x.' },
      bass: { p: 'R.......5.......', gate: .6, tim: 'bass_finger' },
      comp: [{ p: '....x.......x...', gate: .4, tim: 'guitar', voicing: 'open' }], lead: 'fiddle' },
    jazz: { label: 'ジャズ', beats: 4, swing: .9, bpm: [90, 140],
      drums: { rd: 'x...x.x.x...x.x.', h: '....x.......x...', br: 'x...x...x...x...' }, drumGain: .75,
      bass: { p: 'W...W...W...W...', gate: .9, tim: 'bass_upright' },
      comp: [{ p: 'x.....x.........', gate: .6, tim: 'epiano', voicing: 'jazz' }], lead: 'sax' },
    rockabilly: { label: 'ロカビリー', beats: 4, swing: .6, bpm: [150, 190],
      drums: { k: 'x.......x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
      bass: { p: 'B.B.B.B.B.B.B.B.', gate: .6, tim: 'bass_upright' },
      comp: [{ p: 'x.x.x.x.x.x.x.x.', gate: .4, tim: 'guitar', voicing: 'power' }], lead: 'twang' },
    game: { label: 'ゲーム音楽', beats: 4, swing: 0, bpm: [130, 160],
      drums: { k: 'x.......x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
      bass: { p: 'R.8.R.8.R.8.R.8.', gate: .7, tim: 'bass_chip' },
      comp: [{ p: 'aaaaaaaaaaaaaaaa', gate: .8, tim: 'chip', voicing: 'arp' }], lead: 'lead_square' },
    bgm: { label: 'BGM', beats: 4, swing: 0, bpm: [70, 95],
      drums: { sh: 'x.......x.......' }, drumGain: .5,
      bass: { p: 'R...............', gate: 1, tim: 'bass_synth' },
      comp: [{ p: 'X...............', gate: 1, tim: 'pad', voicing: 'open' }, { p: 'a...a...a...a...', gate: 1, tim: 'bell', voicing: 'arp' }], lead: 'lead_soft' },
    jive: { label: 'ジャイブ', beats: 4, swing: 1, bpm: [160, 190],
      drums: { k: 'x...x...x...x...', s: '....x.......x...', rd: 'x...x.x.x...x.x.' },
      bass: { p: 'B.B.B.B.B.B.B.B.', gate: .6, tim: 'bass_upright' },
      comp: [{ p: 'x...x...x...x...', gate: .3, tim: 'piano', voicing: 'shell' }], lead: 'brass' },
    samba: { label: 'サンバ', beats: 4, swing: 0, bpm: [95, 110],
      drums: { k: 'x..xx..xx..xx..x', sh: 'xxxxxxxxxxxxxxxx', r: 'x.xx.x.x.xx.x.x.', cgl: '....x.......x...' }, drumGain: .85,
      bass: { p: 'R..5R..5R..5R..5', gate: .6, tim: 'bass_finger' },
      comp: [{ p: 'x.xx.x.x.x.x.xx.', gate: .4, tim: 'nylon', voicing: 'open' }], lead: 'flute' },
    chachacha: { label: 'チャチャチャ', beats: 4, swing: 0, bpm: [110, 128],
      drums: { cb: 'x...x...x...x...', sh: 'x.x.x.x.x.x.x.x.', cgh: '............x.x.', k: 'x.......x.......' }, drumGain: .85,
      bass: { p: 'R.......R...5...', gate: .7, tim: 'bass_finger' },
      comp: [{ p: 'x...x.x.x...x...', gate: .5, tim: 'piano', voicing: 'open' }], lead: 'flute' },
    rumba: { label: 'ルンバ', beats: 4, swing: 0, bpm: [96, 108],
      drums: { cgh: '....x..x....x..x', sh: 'x.x.x.x.x.x.x.x.', r: 'x..x..x...x.x...' }, drumGain: .8,
      bass: { p: 'R.....5.R.......', gate: .8, tim: 'bass_finger' },
      comp: [{ p: 'X...............', gate: 1, tim: 'strings', voicing: 'open' }, { p: 'a.a.a.a.a.a.a.a.', gate: .9, tim: 'nylon', voicing: 'arp' }], lead: 'violin' },
    tango: { label: 'タンゴ', beats: 4, swing: 0, bpm: [110, 130],
      drums: {},
      bass: { p: 'R...R...R...5...', gate: .35, tim: 'bass_upright' },
      comp: [{ p: 'x...x...x...x..x', gate: .3, tim: 'accordion', voicing: 'open' }], lead: 'violin' },
    waltz: { label: 'ワルツ', beats: 3, swing: 0, bpm: [84, 100],
      drums: { k: 'x...........', h: '....x...x...' }, drumGain: .5,
      bass: { p: 'R...........', gate: .8, tim: 'bass_upright' },
      comp: [{ p: '....x...x...', gate: .5, tim: 'piano', voicing: 'open' }, { p: 'X...........', gate: 1, tim: 'strings', voicing: 'open' }], lead: 'violin' },
  };

  /* セクションの盛り上がり */
  const ENERGY = {
    inst: { drums: .75, comp: .85, melody: .85, layer2: 1 },
    verse: { drums: .8, comp: .8, melody: .9, layer2: .6 },
    pre: { drums: .9, comp: .9, melody: .95, layer2: .85 },
    chorus: { drums: 1, comp: 1, melody: 1, layer2: 1 },
    bridge: { drums: .7, comp: .9, melody: .95, layer2: 1 },
  };

  function kindOf(p) {
    const s = String(p || '').toLowerCase();
    if (/^(intro|inter|outro|イントロ|間奏|アウトロ|エンディング)/.test(s)) return 'inst';
    if (/^(s|chorus|サビ|hook)/.test(s)) return 'chorus';
    if (/^(b|pre|bメロ)/.test(s)) return 'pre';
    if (/^(c|bridge|cメロ|大サビ)/.test(s)) return 'bridge';
    return 'verse';
  }

  /* ===== 構成の整形 ===== */
  function normalizeStructure(song) {
    if (!STYLES[song.styleKey]) song.styleKey = 'reiwa';
    const st = STYLES[song.styleKey];
    song.timeSig = st.beats === 3 ? '3/4' : '4/4';
    let arr = Array.isArray(song.arrangement) ? song.arrangement : [];
    if (!arr.length) {
      arr = [
        { pattern: 'intro', label: 'イントロ', bars: 8 }, { pattern: 'A', label: 'Aメロ', bars: 16 },
        { pattern: 'B', label: 'Bメロ', bars: 8 }, { pattern: 'S', label: 'サビ', bars: 16 },
        { pattern: 'outro', label: 'アウトロ', bars: 8 },
      ];
    }
    const bars = {};
    song.arrangement = arr.map(x => {
      const p = String(x.pattern || 'A').trim().slice(0, 20) || 'A';
      let n = parseInt(x.bars, 10);
      if (!(n >= 2 && n <= 32)) n = kindOf(p) === 'inst' ? 8 : 16;
      if (bars[p] == null) bars[p] = n; else n = bars[p];
      let ly = Array.isArray(x.lyrics) ? x.lyrics : String(x.lyrics || '').split(/\n/);
      ly = ly.map(s => String(s).trim()).filter(Boolean).slice(0, 16);
      return { pattern: p, label: String(x.label || p).slice(0, 30), bars: n, lyrics: ly };
    });
    let bpm = parseInt(song.bpm, 10);
    if (!(bpm >= 50 && bpm <= 240)) bpm = Math.round((st.bpm[0] + st.bpm[1]) / 2);
    song.bpm = bpm;
    song.title = String(song.title || '無題の曲').slice(0, 60);
    song.key = String(song.key || 'C').slice(0, 6);
    return song;
  }

  /* 作曲結果の整形と、約3分に合わせるテンポ調整 */
  function finalize(song, target) {
    target = target || 180;
    const st = STYLES[song.styleKey] || STYLES.reiwa;
    const beats = st.beats;
    song.patterns = song.patterns || {};
    const bars = {};
    song.arrangement.forEach(s => { if (bars[s.pattern] == null) bars[s.pattern] = s.bars; });
    const tonic = parseChord(song.key) ? song.key : 'C';
    Object.keys(bars).forEach(p => {
      const pat = song.patterns[p] || {};
      const n = bars[p];
      let ch = Array.isArray(pat.chords) ? pat.chords.map(String).filter(x => x.trim()) : [];
      if (!ch.length) ch = [tonic];
      const cb = ch.slice();
      while (ch.length < n) ch.push(cb[ch.length % cb.length]);
      let mel = Array.isArray(pat.melody) ? pat.melody.map(String) : [];
      const mb = mel.slice();
      while (mel.length < n) mel.push(mb.length ? mb[mel.length % mb.length] : 'R:' + beats);
      song.patterns[p] = { chords: ch.slice(0, n), melody: mel.slice(0, n) };
    });
    const totalBars = () => song.arrangement.reduce((a, s) => a + s.bars, 0);
    const lo = Math.round(st.bpm[0] * .8), hi = Math.round(st.bpm[1] * 1.2);
    song.bpm = Math.max(lo, Math.min(hi, Math.round(totalBars() * beats * 60 / target)));
    const durOf = () => totalBars() * beats * 60 / song.bpm;
    let guard = 0;
    while (durOf() < target - 20 && guard++ < 3) {
      const ch = [...song.arrangement].reverse().find(s => kindOf(s.pattern) === 'chorus') || song.arrangement[song.arrangement.length - 1];
      const copy = { pattern: ch.pattern, label: ch.label.replace(/（くり返し）$/, '') + '（くり返し）', bars: ch.bars, lyrics: (ch.lyrics || []).slice() };
      const last = song.arrangement[song.arrangement.length - 1];
      const pos = kindOf(last.pattern) === 'inst' ? song.arrangement.length - 1 : song.arrangement.length;
      song.arrangement.splice(pos, 0, copy);
    }
    guard = 0;
    while (durOf() > target + 30 && guard++ < 3) {
      const i = song.arrangement.findIndex((s, k) => k > 0 && k < song.arrangement.length - 1 && /inter|間奏/i.test(s.pattern));
      if (i < 0) break;
      song.arrangement.splice(i, 1);
    }
    song.durationSec = Math.round(durOf());
    return song;
  }

  /* メロディ1小節 "E4:1 G4:0.5 R:0.5 A4:2" → 音の配列（拍数合計を小節に合わせる） */
  function parseMelodyBar(str, beats) {
    const toks = String(str || '').trim().split(/[\s,]+/).filter(Boolean);
    const notes = [];
    toks.forEach(t => {
      const m = /^([^:]+)(?::([\d.\/]+))?$/.exec(t);
      if (!m) return;
      let d = 1;
      if (m[2]) d = m[2].includes('/') ? (Number(m[2].split('/')[0]) / Number(m[2].split('/')[1])) : Number(m[2]);
      if (!(d > 0)) d = 1;
      const name = m[1].trim();
      notes.push({ midi: /^R$/i.test(name) ? null : noteToMidi(name), dur: d });
    });
    if (!notes.length) return [{ midi: null, dur: beats }];
    const total = notes.reduce((a, n) => a + n.dur, 0);
    if (Math.abs(total - beats) > .01) { const k = beats / total; notes.forEach(n => n.dur *= k); }
    return notes;
  }

  /* ===== 和音の並べ方 ===== */
  function voice(c, how) {
    const pc = c.root;
    let base = 48 + pc;
    switch (how) {
      case 'power': if (base > 54) base -= 12; return [base, base + 7, base + 12];
      case 'shell': { if (base > 55) base -= 12; return [base, base + (c.iv[1] || 4), base + (c.iv[3] || c.iv[2] || 7)]; }
      case 'jazz': { if (base < 50) base += 12; return [base + (c.iv[1] || 4), base + (c.iv[3] || 10), base + 14].map(n => n > 74 ? n - 12 : n); }
      case 'arp': { if (base < 52) base += 12; const ns = c.iv.filter(i => i < 12).map(i => base + i); ns.push(base + 12); return ns; }
      default: { if (base < 52) base += 12; return c.iv.map(i => base + (i >= 12 ? i - 12 : i)); }
    }
  }
  const arpOf = ns => ns.length > 2 ? ns.concat(ns.slice(1, -1).reverse()) : ns;
  const bassMidi = pc => pc + (pc > 7 ? 28 : 40);
  function gapTo(p, i) { const L = p.length; for (let j = 1; j <= L; j++) { if (p[(i + j) % L] !== '.') return j; } return L; }
  const hum = () => .9 + Math.random() * .1;
  const clipLen = c => c.pcm.length / c.rate;

  /* ===== タイムライン作成 ===== */
  function buildTimeline(song, opts) {
    opts = opts || {};
    const st = STYLES[song.styleKey] || STYLES.reiwa;
    const beats = st.beats, spb = 60 / song.bpm, barDur = spb * beats, spBar = beats * 4, sd = spb / 4;
    const swingOff = (st.swing || 0) * spb / 6;
    const clips = opts.clips || {}, narr = opts.narr || {};
    const arr = song.arrangement || [];
    const pats = song.patterns || {};
    const ev = [], sections = [];

    const barChords = [];
    arr.forEach(sec => { const pat = pats[sec.pattern] || {}; for (let b = 0; b < sec.bars; b++) barChords.push(splitChords((pat.chords || [])[b])); });
    let last = [parseChord(song.key) || parseChord('C')];
    for (let i = 0; i < barChords.length; i++) { if (barChords[i].length) last = barChords[i]; else barChords[i] = last; }

    // 曲紹介ナレーション（イントロに重ね、長いときは曲の開始を遅らせる）
    let t0 = .2;
    if (narr.intro) {
      const nd = clipLen(narr.intro);
      const introDur = arr.length && kindOf(arr[0].pattern) === 'inst' ? arr[0].bars * barDur : 0;
      t0 = Math.max(.2, nd + 1.0 - introDur);
      ev.push({ type: 'clip', ch: 'narr', t: .3, clip: narr.intro, rate: 1, dur: nd });
      const dd = .3 + nd - t0;
      if (dd > 0) ev.push({ type: 'duck', t: t0, dur: dd, level: .4 });
    }

    let t = t0, gbar = 0;
    const drumGain = st.drumGain || 1;
    arr.forEach((sec, si) => {
      const pat = pats[sec.pattern] || {};
      const kind = kindOf(sec.pattern), en = ENERGY[kind];
      const start = t, secDur = sec.bars * barDur;
      const aIdx = [0, 0, 0];
      for (let b = 0; b < sec.bars; b++, gbar++) {
        const bt = t + b * barDur;
        const chords = barChords[gbar];
        const nextC = (barChords[gbar + 1] || chords)[0];
        const chordAt = s => chords[Math.min(chords.length - 1, Math.floor(s * chords.length / spBar))];
        const at = s => bt + s * sd + (s % 4 === 2 ? swingOff : 0);

        // ドラム
        for (const lane in st.drums) {
          const p = st.drums[lane];
          for (let s = 0; s < spBar; s++) {
            const c = p[(gbar * spBar + s) % p.length];
            if (c === 'x' || c === 'X') ev.push({ type: 'drum', inst: lane, t: at(s), vel: (c === 'X' ? 1 : .85) * en.drums * drumGain * hum() });
          }
        }
        if (b === sec.bars - 1 && st.drums.s && si < arr.length - 1) {
          for (let s = spBar - 4; s < spBar; s++) ev.push({ type: 'drum', inst: 's', t: at(s), vel: (.45 + .12 * (s - spBar + 4)) * drumGain });
        }
        if (b === 0 && kind === 'chorus' && Object.keys(st.drums).length) ev.push({ type: 'drum', inst: 'crash', t: bt, vel: .8 * drumGain });

        // ベース
        const bp = st.bass.p, bl = bp.length;
        let wIdx = 0, bIdx = 0;
        for (let s = 0; s < spBar; s++) {
          const gi = (gbar * spBar + s) % bl, sym = bp[gi];
          if (sym === '.' || sym === '_') continue;
          const c = chordAt(s), base = bassMidi(c.bass), rootM = bassMidi(c.root), third = c.iv[1] || 4;
          let m;
          switch (sym) {
            case 'R': m = base; break;
            case '5': m = rootM + 7; break;
            case '3': m = rootM + third; break;
            case '8': m = base + 12; break;
            case 'N': m = bassMidi(nextC.bass); break;
            case 'W': { const k = wIdx++ % 4; m = k === 0 ? base : k === 1 ? rootM + third : k === 2 ? rootM + 7 : bassMidi(nextC.bass) - 1; break; }
            case 'B': { const seq = [0, third, 7, 9, 12, 9, 7, third]; m = rootM + seq[bIdx++ % 8]; break; }
            default: m = base;
          }
          ev.push({ type: 'note', ch: 'bass', tim: st.bass.tim, midi: m, t: at(s), dur: gapTo(bp, gi) * sd * st.bass.gate, vel: .95 * hum() });
        }

        // 伴奏
        st.comp.forEach((L, li) => {
          const lv = li === 0 ? en.comp : en.comp * en.layer2;
          const p = L.p, pl = p.length;
          for (let s = 0; s < spBar; s++) {
            const gi = (gbar * spBar + s) % pl, sym = p[gi];
            if (sym !== 'x' && sym !== 'X' && sym !== 'a') continue;
            const c = chordAt(s), notes = voice(c, L.voicing);
            const dur = gapTo(p, gi) * sd * (sym === 'X' ? 1 : L.gate);
            if (sym === 'a') {
              const ar = arpOf(notes);
              ev.push({ type: 'note', ch: 'comp', tim: L.tim, midi: ar[aIdx[li]++ % ar.length], t: at(s), dur: Math.max(dur, sd * 1.5), vel: .85 * lv * hum() });
            } else {
              notes.forEach((n, j) => ev.push({ type: 'note', ch: 'comp', tim: L.tim, midi: n, t: at(s) + j * .004, dur, vel: (sym === 'X' ? .8 : .9) * lv * hum() }));
            }
          }
        });

        // メロディ
        let pos = 0;
        parseMelodyBar((pat.melody || [])[b], beats).forEach(n => {
          if (n.midi != null) {
            let m = n.midi;
            while (m < 55) m += 12;
            while (m > 84) m -= 12;
            const sw = Math.abs((pos % 1) - .5) < 1e-3 ? swingOff : 0;
            ev.push({ type: 'note', ch: 'melody', tim: st.lead, midi: m, t: bt + pos * spb + sw, dur: Math.max(.08, n.dur * spb * .92), vel: .9 * en.melody * hum() });
          }
          pos += n.dur;
        });
      }

      // 歌詞の声
      const clip = clips[si];
      const lyrStart = start + spb * .5;
      let lyrDur = Math.max(1, secDur - spb) * .95;
      if (clip) {
        const cd = clipLen(clip), avail = secDur - spb * .5;
        const rate = cd > avail ? Math.min(1.3, cd / avail) : 1;
        ev.push({ type: 'clip', ch: 'vocal', t: lyrStart, clip, rate, dur: cd / rate });
        ev.push({ type: 'duck', t: lyrStart, dur: cd / rate, level: .7 });
        lyrDur = cd / rate;
      }
      sections.push({ index: si, label: sec.label, kind, start, end: start + secDur, lyrics: (sec.lyrics || []).filter(x => String(x).trim()), lyrStart, lyrDur });
      t += secDur;
    });

    // エンディング
    const lb = barChords[barChords.length - 1] || [parseChord('C')];
    const lastC = lb[lb.length - 1];
    const hold = Math.max(1.6, barDur);
    voice(lastC, 'open').forEach(n => ev.push({ type: 'note', ch: 'comp', tim: 'strings', midi: n, t, dur: hold, vel: .9 }));
    ev.push({ type: 'note', ch: 'bass', tim: st.bass.tim, midi: bassMidi(lastC.bass), t, dur: hold, vel: 1 });
    if (Object.keys(st.drums).length) {
      ev.push({ type: 'drum', inst: 'crash', t, vel: .8 * drumGain });
      ev.push({ type: 'drum', inst: 'k', t, vel: .9 * drumGain });
    }
    let end = t + hold + 2.2;
    if (narr.outro) {
      const nd = clipLen(narr.outro);
      ev.push({ type: 'clip', ch: 'narr', t: t + .6, clip: narr.outro, rate: 1, dur: nd });
      end = Math.max(end, t + .6 + nd + 1.2);
    }
    ev.sort((a, b) => a.t - b.t);
    return { events: ev, sections, duration: end, bpm: song.bpm, beats, musicStart: t0, musicEnd: t };
  }

  /* ===== 音づくり ===== */
  const noiseCache = new WeakMap();
  function noise(ctx) {
    let b = noiseCache.get(ctx);
    if (!b) {
      const len = (ctx.sampleRate * 2) | 0;
      b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      noiseCache.set(ctx, b);
    }
    return b;
  }
  function nz(ctx, out, t, o) {
    const s = ctx.createBufferSource(); s.buffer = noise(ctx);
    const f = ctx.createBiquadFilter(); f.type = o.type || 'highpass'; f.frequency.value = o.freq || 6000; f.Q.value = o.q || .7;
    const g = ctx.createGain(); const a = o.attack || .001, d = o.decay || .05;
    g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(o.gain, t + a); g.gain.exponentialRampToValueAtTime(.0001, t + a + d);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, d < .4 ? Math.random() * .5 : 0); s.stop(t + a + d + .05);
  }
  function tone(ctx, out, t, o) {
    const osc = ctx.createOscillator(); osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.sweep || .05));
    const g = ctx.createGain(); g.gain.setValueAtTime(Math.max(.0002, o.gain), t); g.gain.exponentialRampToValueAtTime(.0001, t + o.decay);
    osc.connect(g); g.connect(out); osc.start(t); osc.stop(t + o.decay + .05);
  }
  function drum(ctx, out, inst, t, v) {
    switch (inst) {
      case 'k': tone(ctx, out, t, { f0: 150, f1: 42, gain: .9 * v, decay: .32, sweep: .12 }); break;
      case 's': nz(ctx, out, t, { type: 'highpass', freq: 1400, gain: .36 * v, decay: .16 }); tone(ctx, out, t, { type: 'triangle', f0: 200, f1: 160, gain: .24 * v, decay: .09 }); break;
      case 'h': nz(ctx, out, t, { freq: 7500, gain: .11 * v, decay: .04 }); break;
      case 'o': nz(ctx, out, t, { freq: 7000, gain: .1 * v, decay: .28 }); break;
      case 'rd': nz(ctx, out, t, { type: 'bandpass', freq: 6500, q: 1.2, gain: .09 * v, decay: .35 }); tone(ctx, out, t, { type: 'square', f0: 520, gain: .015 * v, decay: .2 }); break;
      case 'br': nz(ctx, out, t, { type: 'bandpass', freq: 3000, q: .8, gain: .08 * v, decay: .14, attack: .03 }); break;
      case 'r': tone(ctx, out, t, { f0: 2500, gain: .2 * v, decay: .05 }); break;
      case 'cb': tone(ctx, out, t, { type: 'square', f0: 560, gain: .05 * v, decay: .22 }); tone(ctx, out, t, { type: 'square', f0: 845, gain: .035 * v, decay: .18 }); break;
      case 'cgh': tone(ctx, out, t, { f0: 340, f1: 310, gain: .36 * v, decay: .18 }); break;
      case 'cgl': tone(ctx, out, t, { f0: 210, f1: 190, gain: .42 * v, decay: .28 }); break;
      case 'sh': nz(ctx, out, t, { type: 'bandpass', freq: 5200, q: 1.5, gain: .08 * v, decay: .06, attack: .01 }); break;
      case 'crash': nz(ctx, out, t, { freq: 4200, gain: .2 * v, decay: 1.6 }); break;
    }
  }
  function synthNote(ctx, out, f, t, dur, tm, vel) {
    const end = t + Math.max(dur, tm.a);
    const stopAt = end + tm.r + .1;
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = .7;
    if (tm.fenv) { flt.frequency.setValueAtTime(tm.cut * .25, t); flt.frequency.exponentialRampToValueAtTime(tm.cut, t + tm.fenv); }
    else flt.frequency.value = tm.cut;
    const g = ctx.createGain();
    const peak = Math.max(.0002, tm.gain * vel);
    g.gain.setValueAtTime(.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + tm.a);
    g.gain.setTargetAtTime(tm.s > 0 ? peak * tm.s : .0001, t + tm.a, tm.d / 3);
    g.gain.setTargetAtTime(.0001, end, tm.r / 3);
    const o1 = ctx.createOscillator(); o1.type = tm.w1; o1.frequency.value = f;
    o1.connect(flt);
    let o2 = null;
    if (tm.w2) { o2 = ctx.createOscillator(); o2.type = tm.w2; o2.frequency.value = f * (tm.oct2 || 1); o2.detune.value = tm.det || 0; o2.connect(flt); }
    if (tm.vib) {
      const l = ctx.createOscillator(); l.frequency.value = 5.5;
      const lg = ctx.createGain(); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * tm.vib, t + .3);
      l.connect(lg); lg.connect(o1.frequency); if (o2) lg.connect(o2.frequency);
      l.start(t); l.stop(stopAt);
    }
    flt.connect(g); g.connect(out);
    o1.start(t); o1.stop(stopAt);
    if (o2) { o2.start(t); o2.stop(stopAt); }
  }

  /* ===== ミキサー ===== */
  function impulse(ctx) {
    const len = (ctx.sampleRate * 2.2) | 0, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    return b;
  }
  const LEVELS = { melody: .9, bass: .9, comp: .8, drums: .85, vocal: 1.1, narr: 1.1 };
  function createMixer(ctx, dest) {
    const master = ctx.createGain(); master.gain.value = .9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = .01; comp.release.value = .2;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    master.connect(comp); comp.connect(analyser); analyser.connect(dest);
    const music = ctx.createGain(); music.connect(master);
    const rev = ctx.createConvolver(); rev.buffer = impulse(ctx);
    const revG = ctx.createGain(); revG.gain.value = .22; rev.connect(revG); revG.connect(music);
    const buses = {};
    Object.keys(LEVELS).forEach(k => {
      const g = ctx.createGain(); g.gain.value = LEVELS[k]; buses[k] = g;
      g.connect(k === 'vocal' || k === 'narr' ? master : music);
    });
    ['melody', 'comp'].forEach(k => { const s = ctx.createGain(); s.gain.value = .5; buses[k].connect(s); s.connect(rev); });
    const vs = ctx.createGain(); vs.gain.value = .15; buses.vocal.connect(vs); vs.connect(rev);
    return { ctx, master, music, buses, analyser };
  }
  function applyMix(mixer, mix) {
    mix = mix || {};
    const on = k => mix[k] !== false;
    const set = (bus, v) => { mixer.buses[bus].gain.value = v ? LEVELS[bus] : 0; };
    set('melody', on('melody')); set('bass', on('accomp')); set('comp', on('accomp'));
    set('drums', on('drums')); set('vocal', on('vocal')); set('narr', on('narr'));
  }
  function createSession(ctx, mixer) {
    const outs = {};
    Object.keys(mixer.buses).forEach(k => { const g = ctx.createGain(); g.connect(mixer.buses[k]); outs[k] = g; });
    outs.dispose = () => {
      Object.keys(mixer.buses).forEach(k => { try { outs[k].gain.setTargetAtTime(0, ctx.currentTime, .02); } catch (e) { /* noop */ } });
      setTimeout(() => Object.keys(mixer.buses).forEach(k => { try { outs[k].disconnect(); } catch (e) { /* noop */ } }), 250);
    };
    return outs;
  }
  const bufCache = new WeakMap();
  function clipBuffer(ctx, clip) {
    let m = bufCache.get(ctx);
    if (!m) { m = new Map(); bufCache.set(ctx, m); }
    let b = m.get(clip);
    if (!b) { b = ctx.createBuffer(1, clip.pcm.length, clip.rate); b.copyToChannel ? b.copyToChannel(clip.pcm, 0) : b.getChannelData(0).set(clip.pcm); m.set(clip, b); }
    return b;
  }
  function scheduleEvent(ctx, outs, mixer, ev, when, skip) {
    switch (ev.type) {
      case 'drum': drum(ctx, outs.drums, ev.inst, when, ev.vel); break;
      case 'note': synthNote(ctx, outs[ev.ch], midiToFreq(ev.midi), when, ev.dur, T[ev.tim] || T.piano, ev.vel); break;
      case 'clip': {
        const src = ctx.createBufferSource();
        src.buffer = clipBuffer(ctx, ev.clip);
        src.playbackRate.value = ev.rate;
        src.connect(outs[ev.ch]);
        src.start(when, Math.max(0, (skip || 0) * ev.rate));
        break;
      }
      case 'duck': {
        const g = mixer.music.gain;
        g.setTargetAtTime(ev.level, when, .12);
        g.setTargetAtTime(1, when + ev.dur, .35);
        break;
      }
    }
  }

  /* ===== 書き出し ===== */
  async function renderOffline(song, opts, sampleRate, channels) {
    const tl = buildTimeline(song, opts);
    const Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    const ctx = new Ctx(channels, Math.ceil(tl.duration * sampleRate), sampleRate);
    const mixer = createMixer(ctx, ctx.destination);
    applyMix(mixer, opts && opts.mix);
    const outs = createSession(ctx, mixer);
    tl.events.forEach(ev => scheduleEvent(ctx, outs, mixer, ev, ev.t, 0));
    return await ctx.startRendering();
  }
  function toWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
    w(36, 'data'); data.setUint32(40, len * ch * 2, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
    }
    return new Blob([data], { type: 'audio/wav' });
  }
  /* Gemini TTS の PCM(16bit/リトルエンディアン) base64 → クリップ */
  function b64ToClip(b64, rate) {
    const bin = atob(b64), n = bin.length >> 1, pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      pcm[i] = v / 0x8000;
    }
    return { pcm, rate: rate || 24000 };
  }

  global.UtaEngine = {
    STYLES, parseChord, splitChords, kindOf, normalizeStructure, finalize, buildTimeline,
    createMixer, applyMix, createSession, scheduleEvent, renderOffline, toWav, b64ToClip,
  };
})(window);

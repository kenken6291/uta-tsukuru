/**
 * うたつくる 設定ファイル（config.js）
 * ------------------------------------------------------------
 * GAS（Google Apps Script）ウェブアプリのURLはここで一元管理します。
 * 画面の「設定」からブラウザごとに上書きもできます（上書きが優先されます）。
 * GASを新しいデプロイにしてURLが変わったときは GAS_URL を貼り替えてください。
 */
window.APP_CONFIG = {
  APP_NAME: 'うたつくる',
  VERSION: 'v1.1.0',

  // GASウェブアプリのURL（.../exec で終わるもの）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwra9mFXy2uc5zccA3FI06rDF5nEr2Y8buCIVshyEA-wIzfP425qakrvccAz-DQ9Wlr/exec',

  // 公開URL（参考・メール本文はGAS側のAPP_URLを使用）
  SITE_URL: 'https://kenken6291.github.io/uta-tsukuru/',

  // 曲の目標の長さ（秒）
  TARGET_SECONDS: 180,

  // 音声入力
  SPEECH_LANG: 'ja-JP',
  SPEECH_SILENCE_SEC: 10, // 無音がこの秒数続いたら自動で聞き取り終了（設定画面で変更可）

  // 読み上げ音声を同時に作る数（GASの負荷に合わせて調整）
  TTS_PARALLEL: 2,
};

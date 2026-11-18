/*
 * 자체 한글 조합기 (두벌식)
 * 브라우저/OS 입력기(IME)의 조합 이벤트에 의존하지 않고, 키 입력을 직접 받아
 * 초성·중성·종성을 조합한다. 이 방식은 조합이 끝나는 시점이 늦어
 * 다음 글자가 같은 칸에 덮어써지는 문제가 생기지 않는다.
 *
 * comp = { cho: '', jung: '', jong: '' }
 * step(comp, jamo) -> { cur, next }
 *   next 가 null 이면 현재 칸을 cur 로 갱신
 *   next 가 있으면 현재 칸을 cur 로 확정하고, 다음 칸에서 next 로 조합 시작
 */
(function (root) {
  'use strict';

  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'.split('');
  const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'.split('');
  const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

  const V_COMBO = { 'ㅗㅏ': 'ㅘ', 'ㅗㅐ': 'ㅙ', 'ㅗㅣ': 'ㅚ', 'ㅜㅓ': 'ㅝ', 'ㅜㅔ': 'ㅞ', 'ㅜㅣ': 'ㅟ', 'ㅡㅣ': 'ㅢ' };
  const J_COMBO = { 'ㄱㅅ': 'ㄳ', 'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ', 'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ', 'ㄹㅂ': 'ㄼ', 'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ', 'ㄹㅎ': 'ㅀ', 'ㅂㅅ': 'ㅄ' };
  const V_SPLIT = {}, J_SPLIT = {};
  Object.keys(V_COMBO).forEach(function (k) { V_SPLIT[V_COMBO[k]] = [k[0], k[1]]; });
  Object.keys(J_COMBO).forEach(function (k) { J_SPLIT[J_COMBO[k]] = [k[0], k[1]]; });

  // 두벌식 자판 (KeyboardEvent.code 기준) : [기본, 쉬프트]
  const KEYMAP = {
    KeyQ: ['ㅂ', 'ㅃ'], KeyW: ['ㅈ', 'ㅉ'], KeyE: ['ㄷ', 'ㄸ'], KeyR: ['ㄱ', 'ㄲ'], KeyT: ['ㅅ', 'ㅆ'],
    KeyY: ['ㅛ'], KeyU: ['ㅕ'], KeyI: ['ㅑ'], KeyO: ['ㅐ', 'ㅒ'], KeyP: ['ㅔ', 'ㅖ'],
    KeyA: ['ㅁ'], KeyS: ['ㄴ'], KeyD: ['ㅇ'], KeyF: ['ㄹ'], KeyG: ['ㅎ'],
    KeyH: ['ㅗ'], KeyJ: ['ㅓ'], KeyK: ['ㅏ'], KeyL: ['ㅣ'],
    KeyZ: ['ㅋ'], KeyX: ['ㅌ'], KeyC: ['ㅊ'], KeyV: ['ㅍ'], KeyB: ['ㅠ'], KeyN: ['ㅜ'], KeyM: ['ㅡ']
  };
  const JAMO_TO_KEY = {};
  Object.keys(KEYMAP).forEach(function (code) {
    KEYMAP[code].forEach(function (j, i) { JAMO_TO_KEY[j] = [code, i === 1]; });
  });

  function isVowel(j) { return JUNG.indexOf(j) >= 0; }
  function isConsonant(j) { return CHO.indexOf(j) >= 0; }
  function empty() { return { cho: '', jung: '', jong: '' }; }
  function isEmpty(c) { return !c || (!c.cho && !c.jung && !c.jong); }
  function clone(c) { return { cho: c.cho || '', jung: c.jung || '', jong: c.jong || '' }; }

  function compose(c) {
    if (!c) return '';
    if (c.cho && c.jung) {
      return String.fromCharCode(0xAC00 + (CHO.indexOf(c.cho) * 21 + JUNG.indexOf(c.jung)) * 28 + JONG.indexOf(c.jong || ''));
    }
    return c.cho || c.jung || '';
  }

  function step(comp, j) {
    const c = clone(comp || empty());
    if (isConsonant(j)) {
      if (!c.cho && !c.jung) { c.cho = j; return { cur: c, next: null }; }
      if (!c.jung || !c.cho) return { cur: c, next: { cho: j, jung: '', jong: '' } };
      if (!c.jong) {
        if (JONG.indexOf(j) > 0) { c.jong = j; return { cur: c, next: null }; }
        return { cur: c, next: { cho: j, jung: '', jong: '' } };
      }
      const d = J_COMBO[c.jong + j];
      if (d) { c.jong = d; return { cur: c, next: null }; }
      return { cur: c, next: { cho: j, jung: '', jong: '' } };
    }
    if (isVowel(j)) {
      if (!c.cho && !c.jung) { c.jung = j; return { cur: c, next: null }; }
      if (c.cho && !c.jung) { c.jung = j; return { cur: c, next: null }; }
      if (!c.jong) {
        const v = V_COMBO[c.jung + j];
        if (v) { c.jung = v; return { cur: c, next: null }; }
        return { cur: c, next: { cho: '', jung: j, jong: '' } };
      }
      // 종성이 다음 글자의 초성으로 넘어간다
      const sp = J_SPLIT[c.jong];
      const move = sp ? sp[1] : c.jong;
      c.jong = sp ? sp[0] : '';
      return { cur: c, next: { cho: move, jung: j, jong: '' } };
    }
    return { cur: c, next: null };
  }

  function back(comp) {
    const c = clone(comp || empty());
    if (c.jong) { c.jong = J_SPLIT[c.jong] ? J_SPLIT[c.jong][0] : ''; return c; }
    if (c.jung) { c.jung = V_SPLIT[c.jung] ? V_SPLIT[c.jung][0] : ''; return c; }
    c.cho = '';
    return c;
  }

  function keyToJamo(code, shift) {
    const k = KEYMAP[code];
    if (!k) return null;
    return (shift && k[1]) ? k[1] : k[0];
  }

  // 한 글자(완성형)를 두벌식 키 입력 순서로 분해 (테스트용)
  function syllableToJamo(ch) {
    const n = ch.charCodeAt(0) - 0xAC00;
    if (n < 0 || n > 11171) return [ch];
    const cho = CHO[Math.floor(n / 588)], jung = JUNG[Math.floor((n % 588) / 28)], jong = JONG[n % 28];
    const out = [cho];
    (V_SPLIT[jung] || [jung]).forEach(function (x) { out.push(x); });
    if (jong) (J_SPLIT[jong] || [jong]).forEach(function (x) { out.push(x); });
    return out;
  }
  function textToKeys(text) {
    const keys = [];
    Array.from(text).forEach(function (ch) {
      syllableToJamo(ch).forEach(function (j) { if (JAMO_TO_KEY[j]) keys.push(JAMO_TO_KEY[j]); });
    });
    return keys;
  }

  // n칸짜리 줄에 키 입력을 흘려 넣는 시뮬레이터 (테스트용)
  function simulate(text, n) {
    const cells = new Array(n).fill('');
    let idx = 0, comp = empty();
    textToKeys(text).forEach(function (k) {
      const j = keyToJamo(k[0], k[1]);
      const r = step(comp, j);
      if (r.next) {
        if (idx + 1 >= n) return;
        cells[idx] = compose(r.cur); idx++; comp = r.next;
      } else comp = r.cur;
      cells[idx] = compose(comp);
    });
    return cells;
  }

  const api = {
    KEYMAP: KEYMAP, compose: compose, step: step, back: back, empty: empty, isEmpty: isEmpty,
    keyToJamo: keyToJamo, isVowel: isVowel, isConsonant: isConsonant,
    textToKeys: textToKeys, syllableToJamo: syllableToJamo, simulate: simulate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hangul = api;
})(typeof window !== 'undefined' ? window : globalThis);

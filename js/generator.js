/*
 * 크로스워드 생성기
 * - 단어 데이터베이스에서 무작위로 단어를 골라 서로 교차하도록 배치한다.
 * - 이웃한 칸끼리 의도치 않은 단어가 생기지 않도록 인접 규칙을 검사한다.
 * - 배치된 모든 단어(가로·세로)에 고유 번호를 붙인다.
 */
(function (root) {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  const DIRS = { across: [0, 1], down: [1, 0] };

  function attemptOnce(db, target, size, rng) {
    const letters = [];   // letters[r][c] = 글자 또는 null
    const owner = [];     // owner[r][c] = { across: idx, down: idx }
    for (let r = 0; r < size; r++) {
      letters.push(new Array(size).fill(null));
      owner.push(new Array(size).fill(null).map(function () { return {}; }));
    }
    const index = new Map(); // 글자 -> [[r,c],...]
    const placed = [];
    const used = new Set();

    const inB = function (r, c) { return r >= 0 && c >= 0 && r < size && c < size; };
    const empty = function (r, c) { return !inB(r, c) || letters[r][c] === null; };

    function check(chars, r, c, dir) {
      const d = DIRS[dir];
      const L = chars.length;
      const er = r + d[0] * (L - 1), ec = c + d[1] * (L - 1);
      if (!inB(r, c) || !inB(er, ec)) return -1;
      if (!empty(r - d[0], c - d[1]) || !empty(er + d[0], ec + d[1])) return -1;
      let cross = 0;
      for (let k = 0; k < L; k++) {
        const rr = r + d[0] * k, cc = c + d[1] * k;
        const cur = letters[rr][cc];
        if (cur !== null) {
          if (cur !== chars[k] || owner[rr][cc][dir] !== undefined) return -1;
          cross++;
        } else {
          // 진행 방향과 수직인 이웃 칸이 비어 있어야 한다
          if (!empty(rr + d[1], cc + d[0]) || !empty(rr - d[1], cc - d[0])) return -1;
        }
      }
      if (placed.length > 0 && cross === 0) return -1;
      if (cross === L) return -1;
      return cross;
    }

    function put(entry, chars, r, c, dir) {
      const d = DIRS[dir];
      const idx = placed.length;
      const cells = [];
      for (let k = 0; k < chars.length; k++) {
        const rr = r + d[0] * k, cc = c + d[1] * k;
        if (letters[rr][cc] === null) {
          letters[rr][cc] = chars[k];
          if (!index.has(chars[k])) index.set(chars[k], []);
          index.get(chars[k]).push([rr, cc]);
        }
        owner[rr][cc][dir] = idx;
        cells.push([rr, cc]);
      }
      placed.push({ entry: entry, chars: chars, r: r, c: c, dir: dir, cells: cells });
      used.add(entry.word);
    }

    // 첫 단어: 4글자 이상을 가운데 가로로
    const first = shuffle(db.filter(function (w) { return Array.from(w.word).length >= 4; }), rng)[0];
    const fc = Array.from(first.word);
    put(first, fc, Math.floor(size / 2), Math.floor((size - fc.length) / 2), 'across');

    const mid = (size - 1) / 2;
    while (placed.length < target) {
      let best = null;
      const pool = shuffle(db, rng);
      for (let p = 0; p < pool.length; p++) {
        const entry = pool[p];
        if (used.has(entry.word)) continue;
        const chars = Array.from(entry.word);
        for (let i = 0; i < chars.length; i++) {
          const spots = index.get(chars[i]);
          if (!spots) continue;
          for (let s = 0; s < spots.length; s++) {
            const sr = spots[s][0], sc = spots[s][1];
            const own = owner[sr][sc];
            const dirs = [];
            if (own.across === undefined) dirs.push('across');
            if (own.down === undefined) dirs.push('down');
            for (let q = 0; q < dirs.length; q++) {
              const dir = dirs[q];
              const d = DIRS[dir];
              const r = sr - d[0] * i, c = sc - d[1] * i;
              const cross = check(chars, r, c, dir);
              if (cross < 1) continue;
              const cr = r + d[0] * (chars.length - 1) / 2, cc = c + d[1] * (chars.length - 1) / 2;
              const dist = Math.abs(cr - mid) + Math.abs(cc - mid);
              const score = cross * 6 - dist * 0.6 + rng() * 3;
              if (!best || score > best.score) best = { score: score, entry: entry, chars: chars, r: r, c: c, dir: dir };
            }
          }
        }
      }
      if (!best) break;
      put(best.entry, best.chars, best.r, best.c, best.dir);
    }
    return { letters: letters, placed: placed, size: size };
  }

  function finalize(raw) {
    let minR = Infinity, minC = Infinity, maxR = -1, maxC = -1;
    raw.placed.forEach(function (p) {
      p.cells.forEach(function (rc) {
        minR = Math.min(minR, rc[0]); maxR = Math.max(maxR, rc[0]);
        minC = Math.min(minC, rc[1]); maxC = Math.max(maxC, rc[1]);
      });
    });
    const rows = maxR - minR + 1, cols = maxC - minC + 1;
    const grid = [];
    for (let r = 0; r < rows; r++) {
      grid.push([]);
      for (let c = 0; c < cols; c++) grid[r].push(raw.letters[r + minR][c + minC]);
    }
    const words = raw.placed.map(function (p) {
      return {
        word: p.entry.word,
        def: p.entry.def,
        hint: p.entry.hint,
        dir: p.dir,
        r: p.r - minR,
        c: p.c - minC,
        len: p.chars.length,
        chars: p.chars,
        cells: p.cells.map(function (rc) { return [rc[0] - minR, rc[1] - minC]; })
      };
    });
    // 읽는 순서(위→아래, 왼→오)로 정렬하고 각 단어마다 고유 번호 부여
    words.sort(function (a, b) {
      return a.r - b.r || a.c - b.c || (a.dir === 'across' ? -1 : 1);
    });
    words.forEach(function (w, i) { w.id = i; w.num = i + 1; });
    return { rows: rows, cols: cols, grid: grid, words: words };
  }

  function generate(db, opts) {
    opts = opts || {};
    const target = opts.target || 30;
    const size = opts.size || 15;
    const maxAttempts = opts.attempts || 40;
    const seed = opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 1e9);
    const rng = mulberry32(seed);
    let best = null;
    for (let a = 0; a < maxAttempts; a++) {
      const raw = attemptOnce(db, target, size, rng);
      if (!best || raw.placed.length > best.placed.length) best = raw;
      if (best.placed.length >= target) break;
    }
    const puzzle = finalize(best);
    puzzle.seed = seed;
    return puzzle;
  }

  /*
   * 난이도 적용
   *  easy   : 모든 번호에 힌트 + 서로 다른 단어의 칸 REVEAL_COUNT 곳에 글자 공개
   *  normal : 모든 번호에 힌트
   *  hard   : 5개 번호만 힌트 없음 (서로 교차하지 않는 낱말들)
   */
  const NO_HINT_COUNT = 5;
  const REVEAL_COUNT = 5;
  function applyDifficulty(puzzle, mode, seed) {
    const rng = mulberry32(seed !== undefined ? seed : Math.floor(Math.random() * 1e9));
    const n = puzzle.words.length;
    let hinted;
    if (mode === 'hard') {
      // 힌트 없음은 NO_HINT_COUNT 개, 그리고 힌트 없는 낱말끼리는 서로 교차하지 않게 고른다
      const owners = {};
      puzzle.words.forEach(function (w) { w.cells.forEach(function (rc) { const k = rc[0] + ',' + rc[1]; (owners[k] = owners[k] || []).push(w.id); }); });
      const crosses = function (a, b) {
        return a.cells.some(function (rc) { return owners[rc[0] + ',' + rc[1]].indexOf(b.id) >= 0; });
      };
      const picked = [];
      const order = shuffle(puzzle.words, rng);
      for (let i = 0; i < order.length && picked.length < NO_HINT_COUNT; i++) {
        const w = order[i];
        if (!picked.some(function (p) { return crosses(w, p); })) picked.push(w);
      }
      const none = new Set(picked.map(function (w) { return w.id; }));
      hinted = new Set(puzzle.words.filter(function (w) { return !none.has(w.id); }).map(function (w) { return w.id; }));
    } else {
      hinted = new Set(puzzle.words.map(function (w) { return w.id; }));
    }
    puzzle.words.forEach(function (w) { w.hasHint = hinted.has(w.id); });

    puzzle.reveals = [];
    if (mode === 'easy') {
      const usedCells = new Set();
      const order = shuffle(puzzle.words, rng);
      for (let i = 0; i < order.length && puzzle.reveals.length < REVEAL_COUNT; i++) {
        const w = order[i];
        const k = Math.floor(rng() * w.len);
        const rc = w.cells[k];
        const key = rc[0] + ',' + rc[1];
        if (usedCells.has(key)) continue;
        usedCells.add(key);
        puzzle.reveals.push({ r: rc[0], c: rc[1], ch: puzzle.grid[rc[0]][rc[1]] });
      }
    }
    // 타임 어택 낱말: 공개 글자가 없는 낱말 중 하나를 몰래 고른다 (화면에는 표시하지 않음)
    const revealed = new Set(puzzle.reveals.map(function (x) { return x.r + ',' + x.c; }));
    const cand = puzzle.words.filter(function (w) {
      return !w.cells.some(function (rc) { return revealed.has(rc[0] + ',' + rc[1]); });
    });
    puzzle.bonus = cand.length ? { word: cand[Math.floor(rng() * cand.length)].num } : null;

    puzzle.mode = mode;
    return puzzle;
  }

  const api = { generate: generate, applyDifficulty: applyDifficulty, mulberry32: mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CrosswordGen = api;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * 검증 로직 (브라우저 검증 모드와 Node 테스트에서 함께 사용)
 */
(function (root) {
  'use strict';

  function item(name, pass, detail) { return { name: name, pass: !!pass, detail: detail || '' }; }

  // 1) 단어가 칸에 제대로 배치되어 정답이 나오는가
  function verifyLayout(p, db) {
    const out = [];
    const dict = new Set(db.map(function (w) { return w.word; }));
    const n = p.words.length;
    out.push(item('전체 단어 수가 약 30개', n >= 28 && n <= 32, n + '개'));

    const badLen = p.words.filter(function (w) { return w.len < 3 || w.len > 6 || Array.from(w.word).length !== w.len; });
    out.push(item('모든 단어가 3~6글자', badLen.length === 0, badLen.map(function (w) { return w.word; }).join(', ')));

    const notDict = p.words.filter(function (w) { return !dict.has(w.word); });
    out.push(item('모든 단어가 사전 데이터베이스에 있음', notDict.length === 0, notDict.map(function (w) { return w.word; }).join(', ')));

    const dup = p.words.length - new Set(p.words.map(function (w) { return w.word; })).size;
    out.push(item('같은 단어가 중복 배치되지 않음', dup === 0, dup ? dup + '개 중복' : ''));

    // 단어들로부터 격자를 새로 쌓아 보면서 충돌 확인
    const g = [];
    for (let r = 0; r < p.rows; r++) g.push(new Array(p.cols).fill(null));
    const conflicts = [];
    const shapeErr = [];
    p.words.forEach(function (w) {
      const chars = Array.from(w.word);
      const dr = w.dir === 'down' ? 1 : 0, dc = w.dir === 'across' ? 1 : 0;
      for (let k = 0; k < chars.length; k++) {
        const r = w.r + dr * k, c = w.c + dc * k;
        if (!w.cells[k] || w.cells[k][0] !== r || w.cells[k][1] !== c) shapeErr.push(w.word);
        if (r < 0 || c < 0 || r >= p.rows || c >= p.cols) { shapeErr.push(w.word); continue; }
        if (g[r][c] !== null && g[r][c] !== chars[k]) conflicts.push(w.word + '@' + r + ',' + c);
        g[r][c] = chars[k];
      }
    });
    out.push(item('각 단어가 시작 칸부터 올바른 방향으로 연속 배치됨', shapeErr.length === 0, shapeErr.join(', ')));
    out.push(item('교차하는 칸의 글자가 가로·세로 정답 모두와 일치', conflicts.length === 0, conflicts.join(', ')));

    let mismatch = 0;
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) if (g[r][c] !== p.grid[r][c]) mismatch++;
    out.push(item('정답 격자와 단어 목록이 정확히 일치', mismatch === 0, mismatch ? mismatch + '칸 불일치' : ''));

    // 격자에 나타나는 모든 연속 구간(2칸 이상)이 배치된 단어와 같은가 (의도치 않은 단어 없음)
    const placedKeys = new Set(p.words.map(function (w) { return w.dir + ':' + w.r + ',' + w.c + ':' + w.word; }));
    const stray = [];
    function scan(dir) {
      const R = dir === 'across' ? p.rows : p.cols, C = dir === 'across' ? p.cols : p.rows;
      for (let a = 0; a < R; a++) {
        let run = '', start = -1;
        for (let b = 0; b <= C; b++) {
          const ch = b < C ? (dir === 'across' ? p.grid[a][b] : p.grid[b][a]) : null;
          if (ch) { if (start < 0) start = b; run += ch; }
          else {
            if (start >= 0 && Array.from(run).length >= 2) {
              const r = dir === 'across' ? a : start, c = dir === 'across' ? start : a;
              if (!placedKeys.has(dir + ':' + r + ',' + c + ':' + run)) stray.push(run);
            }
            run = ''; start = -1;
          }
        }
      }
    }
    scan('across'); scan('down');
    out.push(item('격자에 의도하지 않은 낱말이 생기지 않음', stray.length === 0, stray.join(', ')));

    // 모든 칸이 최소 한 단어에 속함
    const cover = new Set();
    p.words.forEach(function (w) { w.cells.forEach(function (rc) { cover.add(rc[0] + ',' + rc[1]); }); });
    let orphan = 0;
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) if (p.grid[r][c] && !cover.has(r + ',' + c)) orphan++;
    out.push(item('모든 글자 칸이 어떤 단어에 속함', orphan === 0, orphan ? orphan + '칸' : ''));

    // 모든 단어가 하나로 연결됨
    const adj = p.words.map(function () { return []; });
    const cellOwners = {};
    p.words.forEach(function (w, i) {
      w.cells.forEach(function (rc) {
        const k = rc[0] + ',' + rc[1];
        (cellOwners[k] = cellOwners[k] || []).push(i);
      });
    });
    Object.keys(cellOwners).forEach(function (k) {
      const o = cellOwners[k];
      if (o.length === 2) { adj[o[0]].push(o[1]); adj[o[1]].push(o[0]); }
    });
    const seen = new Set([0]); const st = [0];
    while (st.length) { const x = st.pop(); adj[x].forEach(function (y) { if (!seen.has(y)) { seen.add(y); st.push(y); } }); }
    out.push(item('모든 단어가 교차로 하나로 연결됨', seen.size === n, seen.size + '/' + n));

    // 번호
    const nums = p.words.map(function (w) { return w.num; });
    const uniq = new Set(nums).size === n && nums.every(function (x, i) { return x === i + 1; });
    out.push(item('가로·세로 모든 단어에 고유 번호(1~' + n + ')', uniq, ''));
    return out;
  }

  // 2) 난이도별 힌트 / 공개 글자 확인
  function verifyDifficulty(p) {
    const out = [];
    const n = p.words.length;
    const hinted = p.words.filter(function (w) { return w.hasHint && w.hint && w.hint.trim().length > 0; });
    if (p.mode === 'easy' || p.mode === 'normal') {
      const missing = p.words.filter(function (w) { return !(w.hasHint && w.hint && w.hint.trim()); });
      out.push(item('[' + p.mode + '] 모든 번호에 힌트가 주어짐', missing.length === 0,
        hinted.length + '/' + n + (missing.length ? ' 누락: ' + missing.map(function (w) { return w.num; }).join(',') : '')));
    }
    if (p.mode === 'easy') {
      const rv = p.reveals || [];
      const okCh = rv.every(function (x) { return x.ch && p.grid[x.r][x.c] === x.ch; });
      const distinct = new Set(rv.map(function (x) { return x.r + ',' + x.c; })).size === rv.length;
      out.push(item('[easy] 공개 글자가 정확히 5곳', rv.length === 5 && distinct, rv.map(function (x) { return x.ch; }).join(' ')));
      out.push(item('[easy] 공개 글자가 정답 글자와 같음', okCh, ''));
    }
    if (p.mode === 'normal') {
      out.push(item('[normal] 공개 글자 없음', (p.reveals || []).length === 0, ''));
    }
    if (p.bonus !== undefined) {
      const b = p.bonus;
      const w = b ? p.words.find(function (x) { return x.num === b.word; }) : null;
      const isRev = w && w.cells.some(function (rc) { return (p.reveals || []).some(function (x) { return x.r === rc[0] && x.c === rc[1]; }); });
      out.push(item('[' + p.mode + '] 타임 어택 낱말 1개 (공개 글자 없는 낱말)', !!w && !isRev, w ? w.num + '번 ' + w.word : '없음'));
    }
    if (p.mode === 'hard') {
      const noHint = p.words.filter(function (w) { return !w.hasHint; });
      out.push(item('[hard] 힌트 없음은 5개', noHint.length === 5, '힌트 없음 ' + noHint.length + '/' + n + ' (' + noHint.map(function (w) { return w.num; }).join(',') + ')'));
      const cellOf = {};
      noHint.forEach(function (w) { w.cells.forEach(function (rc) { const k = rc[0] + ',' + rc[1]; (cellOf[k] = cellOf[k] || []).push(w.num); }); });
      const linked = Object.keys(cellOf).filter(function (k) { return cellOf[k].length > 1; }).map(function (k) { return cellOf[k].join('↔'); });
      out.push(item('[hard] 힌트 없는 낱말끼리 서로 교차하지 않음', linked.length === 0, linked.join(', ')));
    }
    return out;
  }

  const api = { verifyLayout: verifyLayout, verifyDifficulty: verifyDifficulty };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CrosswordVerify = api;
})(typeof window !== 'undefined' ? window : globalThis);

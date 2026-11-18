(function () {
  'use strict';

  const DB = window.WORD_DB;
  const Gen = window.CrosswordGen;
  const V = window.CrosswordVerify;
  const H = window.Hangul;
  const $ = function (s) { return document.querySelector(s); };
  const MODE_NAME = { easy: '이지', normal: '일반', hard: '하드' };
  const DIR_NAME = { across: '가로', down: '세로' };
  const START_HAMMERS = 3;
  const BONUS_HAMMERS = 1;
  const BONUS_MS = 10000;

  const el = {
    start: $('#startScreen'), game: $('#game'), win: $('#winScreen'), verify: $('#verifyScreen'),
    board: $('#board'), boardOuter: $('#boardOuter'), fx: $('#fxCanvas'),
    across: $('#acrossList'), down: $('#downList'), cc: $('#currentClue'),
    timer: $('#timer'), score: $('#score'), badge: $('#modeBadge'), bar: $('#progressBar'),
    toast: $('#toast'), confetti: $('#confetti'), pid: $('#puzzleId'),
    hammerBtn: $('#hammerBtn'), hammerCount: $('#hammerCount'), bonusBar: $('#bonusBar'),
    kbd: $('#vkbd'), kbdToggle: $('#kbdToggle')
  };

  let mode = 'normal';
  let S = null;            // 현재 게임 상태
  let ME = null;           // 사용자 정보
  let online = true;       // 서버 연결 여부

  /* ================= 서버 통신 ================= */
  async function api(method, url, body) {
    const r = await fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return j;
  }

  function hydrate(pz) {
    pz.words.forEach(function (w, i) {
      w.id = i;
      w.chars = Array.from(w.word);
      w.len = w.chars.length;
      const dr = w.dir === 'down' ? 1 : 0, dc = w.dir === 'across' ? 1 : 0;
      w.cells = w.chars.map(function (_, k) { return [w.r + dr * k, w.c + dc * k]; });
    });
    pz.reveals = pz.reveals || [];
    // 타임 어택 낱말 id (이전 형식 {r,c} 칸이면 그 칸이 속한 낱말로 변환)
    pz.bonusWordId = null;
    if (pz.bonus && pz.bonus.word != null) {
      const bw = pz.words.find(function (w) { return w.num === pz.bonus.word; });
      if (bw) pz.bonusWordId = bw.id;
    } else if (pz.bonus && pz.bonus.r != null) {
      const bw = pz.words.find(function (w) { return w.cells.some(function (rc) { return rc[0] === pz.bonus.r && rc[1] === pz.bonus.c; }); });
      if (bw) pz.bonusWordId = bw.id;
    }
    return pz;
  }

  function localPuzzle(m, seed) {
    const p = Gen.applyDifficulty(Gen.generate(DB, { target: 30, attempts: 80, seed: seed }), m, seed);
    p.id = 'LOCAL-' + (p.seed % 100000);
    return hydrate({
      id: p.id, mode: m, rows: p.rows, cols: p.cols, grid: p.grid, reveals: p.reveals, bonus: p.bonus,
      words: p.words.map(function (w) { return { num: w.num, word: w.word, def: w.def, hint: w.hint, hasHint: w.hasHint, dir: w.dir, r: w.r, c: w.c }; })
    });
  }

  /* ================= 사용자 ================= */
  function renderUser() {
    document.querySelectorAll('.user-name').forEach(function (x) { x.textContent = ME ? ME.name : '오프라인'; });
  }

  // 사용자 카드 → 메뉴 (이름 바꾸기 / 내 기록 보기 / 통계)
  document.querySelectorAll('.user-chip').forEach(function (chip) {
    chip.addEventListener('click', function (e) { e.stopPropagation(); toggleUserMenu(chip); });
  });

  function editName(chip) {
    if (chip.querySelector('input')) return;
    const span = chip.querySelector('.user-name');
    const inp = document.createElement('input');
    inp.className = 'name-input'; inp.value = ME.name; inp.maxLength = 20;
    span.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    async function finish(saveIt) {
      if (done) return; done = true;
      const v = inp.value.trim();
      const s = document.createElement('span'); s.className = 'user-name';
      inp.replaceWith(s);
      if (saveIt && v && v !== ME.name) {
        try { const r = await api('PUT', '/api/me', { name: v }); ME = r.user; toast('이름이 "' + ME.name + '"(으)로 바뀌었어요', 'ok'); }
        catch (e) { toast(e.message, 'bad'); }
      }
      renderUser();
    }
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', function () { finish(true); });
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function renderResume(pr) {
    const box = $('#resumeBox');
    if (!pr) { box.classList.add('hidden'); $('#startBtn').textContent = '시작하기'; return; }
    box.classList.remove('hidden');
    $('#resumeInfo').innerHTML = '문제 <b>' + pr.puzzleId + '</b> · ' + MODE_NAME[pr.mode] + ' · ' + pr.solved + '/' + pr.total +
      '개 · ' + fmtTime(Math.floor(pr.elapsedMs / 1000));
    $('#resumeBtn').dataset.id = pr.puzzleId;
    $('#startBtn').textContent = '새 게임 시작';
  }

  async function refreshMe() {
    try {
      const r = await api('GET', '/api/me');
      ME = r.user; online = true;
      renderUser(); renderResume(r.progress);
      return r;
    } catch (e) {
      online = false; ME = null; renderUser();
      renderResume(null);
      return null;
    }
  }

  /* ================= 사용자 메뉴 · 내 기록 · 통계 ================= */
  const menu = $('#userMenu');
  let menuChip = null;
  function toggleUserMenu(chip) {
    if (!menu.classList.contains('hidden') && menuChip === chip) { closeUserMenu(); return; }
    if (chip.querySelector('input')) return;
    menuChip = chip;
    if (typeof closeNewMenu === 'function') closeNewMenu();
    const r = chip.getBoundingClientRect();
    menu.classList.remove('hidden');
    const w = menu.offsetWidth;
    menu.style.top = (r.bottom + window.scrollY + 8) + 'px';
    menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    menu.classList.remove('pop'); void menu.offsetWidth; menu.classList.add('pop');
    menu.querySelector('.menu-name').textContent = ME ? ME.name : '오프라인';
    menu.querySelectorAll('[data-act]').forEach(function (b) { b.disabled = !online || !ME; });
  }
  function closeUserMenu() { menu.classList.add('hidden'); }
  document.addEventListener('click', function (e) { if (!menu.contains(e.target)) closeUserMenu(); });
  menu.querySelectorAll('[data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      const act = b.dataset.act, chip = menuChip;
      closeUserMenu();
      if (act === 'rename') editName(chip);
      else if (act === 'records') openMyRecords();
      else if (act === 'stats') openStats('modes');
    });
  });
  // 승리 화면 → 이 문제의 순위표가 펼쳐진 게임별 통계
  $('#winStats').addEventListener('click', async function () {
    const id = S && S.p ? S.p.id : null;
    openStats('puzzles');
    if (!id || String(id).startsWith('LOCAL')) return;
    for (let i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 50); });
      const inp = document.querySelector('#pzSearch');
      if (inp && document.querySelector('#pzRows')) {
        inp.value = id; inp.dispatchEvent(new Event('input'));
        for (let k = 0; k < 40; k++) {
          await new Promise(function (r) { setTimeout(r, 50); });
          const tr = document.querySelector('tr.pz-row[data-id="' + id + '"]');
          if (tr) { tr.click(); return; }
        }
        return;
      }
    }
  });
  $('#myRecordsBtn').addEventListener('click', function () { if (online) openMyRecords(); else toast('오프라인 모드에서는 기록을 볼 수 없어요', 'bad'); });
  $('#statsBtn').addEventListener('click', function () { if (online) openStats('modes'); else toast('오프라인 모드에서는 통계를 볼 수 없어요', 'bad'); });

  const panel = { el: $('#panelScreen'), title: $('#panelTitle'), tabs: $('#panelTabs'), body: $('#panelBody') };
  $('#panelClose').addEventListener('click', closePanel);
  panel.el.addEventListener('click', function (e) { if (e.target === panel.el) closePanel(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (!menu.classList.contains('hidden')) closeUserMenu(); else if (panel.el.classList.contains('show')) closePanel(); }
  });
  function openPanel(title) {
    panel.title.textContent = title;
    panel.tabs.innerHTML = '';
    panel.body.innerHTML = '<div class="loading">불러오는 중…</div>';
    panel.el.classList.add('show');
  }
  function closePanel() { panel.el.classList.remove('show'); }
  function ms(t) {
    if (t == null) return '<span class="muted">—</span>';
    const s = Math.floor(t / 1000);
    return s >= 3600 ? Math.floor(s / 3600) + ':' + fmtTime(s % 3600) : fmtTime(s);
  }
  function medal(rank) { return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '<span class="rank-n">' + rank + '</span>'; }
  function modeBadge(m) { return '<span class="badge sm ' + m + '">' + (MODE_NAME[m] || m) + '</span>'; }
  function pidLink(id) { return '<a class="pid" href="/p/' + id + '" data-pid="' + id + '">' + id + '</a>'; }
  function meTag(isMe) { return isMe ? ' <span class="me-tag">나</span>' : ''; }
  function stagger(root) { root.querySelectorAll('.anim').forEach(function (x, i) { x.style.animationDelay = Math.min(i * 30, 600) + 'ms'; }); }

  // 문제 ID 링크: 창을 새로 열지 않고 바로 그 문제로 이동
  panel.body.addEventListener('click', function (e) {
    const a = e.target.closest('a[data-pid]');
    if (!a) return;
    e.preventDefault();
    goPuzzle(a.dataset.pid);
  });
  async function goPuzzle(id) {
    closePanel(); hideWin();
    if (S && !S.won && !S.testing) await saveNow();
    stopTimer(); stopBonusTimer();
    history.pushState(null, '', '/p/' + id);
    await openPuzzleById(id);
  }

  /* ---- 내 기록 ---- */
  async function openMyRecords() {
    openPanel('📜 내 기록 — ' + (ME ? ME.name : ''));
    let offset = 0;
    try {
      const r = await api('GET', '/api/me/records?limit=20&offset=0');
      const sm = r.summary, t = sm.total;
      const by = {}; sm.byMode.forEach(function (x) { by[x.mode] = x; });
      let html = '<div class="sum-cards">' +
        sumCard('🏁', '총 클리어', t.clears + '회') +
        sumCard('🧩', '푼 문제', t.puzzles + '개') +
        sumCard('⏳', '총 플레이 시간', ms(t.totalMs)) +
        sumCard('📅', '첫 클리어', t.firstAt ? fmtDate(t.firstAt) : '—') + '</div>';
      html += '<div class="mode-cards">' + ['easy', 'normal', 'hard'].map(function (m) {
        const x = by[m];
        if (!x) return '<div class="mode-card ' + m + ' empty anim">' + modeBadge(m) + '<p class="muted">아직 기록이 없어요</p></div>';
        return '<div class="mode-card ' + m + ' anim">' + modeBadge(m) +
          '<div class="mc-best"><span>최고</span><b>' + ms(x.bestMs) + '</b></div>' +
          '<div class="mc-row"><span>평균</span>' + ms(x.avgMs) + '</div>' +
          '<div class="mc-row"><span>클리어</span>' + x.clears + '회</div>' +
          '<div class="mc-row"><span>전체 순위</span>' + (x.rank === 1 ? '🥇 ' : '') + x.rank + '위 / ' + x.players + '명</div></div>';
      }).join('') + '</div>';
      html += '<h3 class="sec-title">클리어 기록 <span class="muted">(' + r.total + '개)</span></h3>';
      if (!r.total) html += '<p class="muted empty-note">아직 클리어한 문제가 없어요. 첫 퍼즐에 도전해 보세요!</p>';
      else html += '<div class="tbl-wrap"><table class="stat-table"><thead><tr><th>날짜</th><th>문제 ID</th><th>난이도</th><th>클리어 시간</th><th>망치</th><th>문제 내 순위</th></tr></thead><tbody id="myRecRows"></tbody></table></div>' +
        '<button id="myRecMore" class="btn ghost more-btn hidden">더 보기</button>';
      panel.body.innerHTML = html;
      const tbody = $('#myRecRows'), more = $('#myRecMore');
      function addRows(rows) {
        if (!tbody) return;
        tbody.insertAdjacentHTML('beforeend', rows.map(function (x) {
          return '<tr class="anim"><td>' + fmtDate(x.at) + '</td><td>' + pidLink(x.puzzleId) + '</td><td>' + modeBadge(x.mode) + '</td><td><b>' + ms(x.timeMs) +
            '</b></td><td>🔨 ' + x.hammersUsed + '</td><td>' + medal(x.puzzleRank) + (x.puzzleRank > 3 ? '위' : '') + '</td></tr>';
        }).join(''));
        offset += rows.length;
        if (more) more.classList.toggle('hidden', offset >= r.total);
        stagger(panel.body);
      }
      addRows(r.records);
      if (more) more.addEventListener('click', async function () {
        more.disabled = true;
        try { const n = await api('GET', '/api/me/records?limit=20&offset=' + offset); addRows(n.records); } finally { more.disabled = false; }
      });
      stagger(panel.body);
    } catch (e) { panel.body.innerHTML = '<p class="muted">불러오지 못했어요: ' + escapeHtml(e.message) + '</p>'; }
  }
  function sumCard(icon, label, value) {
    return '<div class="sum-card anim"><span class="sc-icon">' + icon + '</span><span class="sc-label">' + label + '</span><b class="sc-value">' + value + '</b></div>';
  }

  /* ---- 통계 ---- */
  const STAT_TABS = [['modes', '🏆 난이도별 최고 기록'], ['puzzles', '🧩 게임별 최고 기록'], ['users', '👥 사용자별 최고 기록']];
  function openStats(tab) {
    openPanel('📊 통계');
    panel.tabs.innerHTML = STAT_TABS.map(function (t) { return '<button class="tab" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '<span class="tab-ink"></span>';
    panel.tabs.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { showStatTab(b.dataset.tab); }); });
    showStatTab(tab);
  }
  function showStatTab(tab) {
    panel.tabs.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    const on = panel.tabs.querySelector('.tab.on'), ink = panel.tabs.querySelector('.tab-ink');
    if (on && ink) { ink.style.left = on.offsetLeft + 'px'; ink.style.width = on.offsetWidth + 'px'; }
    panel.body.innerHTML = '<div class="loading">불러오는 중…</div>';
    ({ modes: statModes, puzzles: statPuzzles, users: statUsers })[tab]().catch(function (e) {
      panel.body.innerHTML = '<p class="muted">불러오지 못했어요: ' + escapeHtml(e.message) + '</p>';
    });
  }

  async function statModes() {
    const r = (await api('GET', '/api/stats/modes?limit=10')).modes;
    panel.body.innerHTML = '<div class="lb-cols">' + ['easy', 'normal', 'hard'].map(function (m) {
      const x = r[m], s = x.summary;
      let h = '<section class="lb-col ' + m + ' anim"><header>' + modeBadge(m) +
        '<div class="lb-sum">클리어 <b>' + s.clears + '</b>회 · 플레이어 <b>' + s.players + '</b>명<br>평균 ' + ms(s.avgMs) + '</div></header>';
      if (!x.top.length) h += '<p class="muted empty-note">아직 기록이 없어요</p>';
      else h += '<ol class="lb-list">' + x.top.map(function (t) {
        return '<li class="anim' + (t.isMe ? ' me' : '') + (t.rank <= 3 ? ' top' : '') + '"><span class="lb-rank">' + medal(t.rank) + '</span>' +
          '<span class="lb-name">' + escapeHtml(t.name) + meTag(t.isMe) + '<small>' + t.clears + '회 클리어 · ' + pidLink(t.puzzleId) + '</small></span>' +
          '<b class="lb-time">' + ms(t.timeMs) + '</b></li>';
      }).join('') + '</ol>';
      return h + '</section>';
    }).join('') + '</div><p class="muted foot-note">사용자마다 가장 빠른 기록 하나로 순위를 매깁니다.</p>';
    stagger(panel.body);
  }

  async function statPuzzles() {
    let sort = 'recent', q = '', offset = 0, total = 0;
    panel.body.innerHTML =
      '<div class="stat-ctrl"><input id="pzSearch" class="search" placeholder="문제 ID 검색 (예: L74)" maxlength="12">' +
      '<select id="pzSort" class="sel"><option value="recent">최근 클리어 순</option><option value="clears">클리어 많은 순</option><option value="best">최고 기록 빠른 순</option></select></div>' +
      '<div class="tbl-wrap"><table class="stat-table pz"><thead><tr><th>문제 ID</th><th>난이도</th><th>최고 기록</th><th>기록 보유자</th><th>클리어</th><th>플레이어</th><th>내 최고</th></tr></thead>' +
      '<tbody id="pzRows"></tbody></table></div><p id="pzEmpty" class="muted empty-note hidden">기록이 있는 문제가 없어요.</p>' +
      '<button id="pzMore" class="btn ghost more-btn hidden">더 보기</button><p class="muted foot-note">행을 누르면 그 문제의 순위표가 펼쳐집니다.</p>';
    const tbody = $('#pzRows'), more = $('#pzMore');
    async function load(reset) {
      if (reset) { offset = 0; tbody.innerHTML = ''; }
      const r = await api('GET', '/api/stats/puzzles?limit=20&offset=' + offset + '&sort=' + sort + '&q=' + encodeURIComponent(q));
      total = r.total;
      tbody.insertAdjacentHTML('beforeend', r.rows.map(function (x) {
        return '<tr class="anim pz-row" data-id="' + x.puzzleId + '"><td>' + pidLink(x.puzzleId) + '</td><td>' + modeBadge(x.mode) + '</td><td><b>' + ms(x.bestMs) +
          '</b></td><td>' + escapeHtml(x.bestName || '') + meTag(x.bestIsMe) + '</td><td>' + x.clears + '회</td><td>' + x.players + '명</td><td>' + ms(x.myBestMs) + '</td></tr>';
      }).join(''));
      offset += r.rows.length;
      more.classList.toggle('hidden', offset >= total);
      $('#pzEmpty').classList.toggle('hidden', total > 0);
      stagger(panel.body);
    }
    tbody.addEventListener('click', async function (e) {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr.pz-row');
      if (!tr) return;
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('pz-board')) { next.remove(); tr.classList.remove('open'); return; }
      tr.classList.add('open');
      const row = document.createElement('tr');
      row.className = 'pz-board';
      row.innerHTML = '<td colspan="7"><div class="loading">불러오는 중…</div></td>';
      tr.after(row);
      try {
        const b = (await api('GET', '/api/stats/puzzles/' + tr.dataset.id + '?limit=10')).board;
        row.firstChild.innerHTML = '<ol class="mini-board">' + b.map(function (t) {
          return '<li class="anim' + (t.isMe ? ' me' : '') + '"><span class="lb-rank">' + medal(t.rank) + '</span><span class="lb-name">' + escapeHtml(t.name) + meTag(t.isMe) +
            '</span><span class="muted">🔨 ' + t.hammers + ' · ' + t.clears + '회</span><b class="lb-time">' + ms(t.timeMs) + '</b></li>';
        }).join('') + '</ol>';
        stagger(row);
      } catch (err) { row.firstChild.textContent = err.message; }
    });
    let qt = null;
    $('#pzSearch').addEventListener('input', function (e) { clearTimeout(qt); q = e.target.value.trim(); qt = setTimeout(function () { load(true); }, 250); });
    $('#pzSort').addEventListener('change', function (e) { sort = e.target.value; load(true); });
    more.addEventListener('click', function () { load(false); });
    await load(true);
  }

  async function statUsers() {
    panel.body.innerHTML =
      '<div class="stat-ctrl"><select id="usSort" class="sel"><option value="clears">클리어 많은 순</option><option value="easy">이지 최고 기록 순</option>' +
      '<option value="normal">일반 최고 기록 순</option><option value="hard">하드 최고 기록 순</option><option value="recent">최근 플레이 순</option></select>' +
      '<span id="usTotal" class="muted"></span></div>' +
      '<div class="tbl-wrap"><table class="stat-table us"><thead><tr><th>순위</th><th>사용자</th><th>클리어</th><th>푼 문제</th><th>이지 최고</th><th>일반 최고</th><th>하드 최고</th><th>마지막 플레이</th></tr></thead>' +
      '<tbody id="usRows"></tbody></table></div><p id="usEmpty" class="muted empty-note hidden">아직 기록이 없어요.</p>';
    async function load(sort) {
      const r = await api('GET', '/api/stats/users?limit=50&sort=' + sort);
      $('#usTotal').textContent = '기록이 있는 사용자 ' + r.total + '명';
      $('#usEmpty').classList.toggle('hidden', r.total > 0);
      $('#usRows').innerHTML = r.rows.map(function (x) {
        const hl = function (k) { return sort === k ? ' class="hl"' : ''; };
        return '<tr class="anim' + (x.isMe ? ' me' : '') + '"><td>' + medal(x.rank) + '</td><td><b>' + escapeHtml(x.name) + '</b>' + meTag(x.isMe) +
          '</td><td' + hl('clears') + '>' + x.clears + '회</td><td>' + x.puzzles + '개</td><td' + hl('easy') + '>' + ms(x.bestEasy) + '</td><td' + hl('normal') + '>' +
          ms(x.bestNormal) + '</td><td' + hl('hard') + '>' + ms(x.bestHard) + '</td><td>' + fmtDate(x.lastAt) + '</td></tr>';
      }).join('');
      stagger(panel.body);
    }
    $('#usSort').addEventListener('change', function (e) { load(e.target.value); });
    await load('clears');
  }

  /* ================= 시작 화면 ================= */
  document.querySelectorAll('.mode').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.mode').forEach(function (x) { x.classList.remove('selected'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('selected'); b.setAttribute('aria-checked', 'true');
      mode = b.dataset.mode;
    });
  });
  $('#startBtn').addEventListener('click', function () { newGame(mode); });
  $('#resumeBtn').addEventListener('click', function () { resumeGame(); });
  // 새 퍼즐: 난이도를 고른 뒤 시작
  const newMenu = $('#newMenu');
  $('#newBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    if (!newMenu.classList.contains('hidden')) { closeNewMenu(); return; }
    closeUserMenu();
    const r = e.currentTarget.getBoundingClientRect();
    newMenu.classList.remove('hidden');
    const w = newMenu.offsetWidth;
    newMenu.style.top = (r.bottom + window.scrollY + 8) + 'px';
    newMenu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    newMenu.classList.remove('pop'); void newMenu.offsetWidth; newMenu.classList.add('pop');
    newMenu.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('current', b.dataset.mode === mode); });
    // 풀던 게임이 진행 중이면 덮어쓴다는 안내
    const started = S && !S.won && (S.solved.size > 0 || S.values.some(function (row) { return row.some(function (v) { return v; }); }));
    $('#newMenuWarn').classList.toggle('hidden', !started);
  });
  newMenu.querySelectorAll('[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () {
      closeNewMenu();
      document.querySelectorAll('.mode').forEach(function (x) {
        const on = x.dataset.mode === b.dataset.mode;
        x.classList.toggle('selected', on); x.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      newGame(b.dataset.mode);
    });
  });
  function closeNewMenu() { newMenu.classList.add('hidden'); }
  document.addEventListener('click', function (e) { if (!newMenu.contains(e.target)) closeNewMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNewMenu(); });
  $('#homeBtn').addEventListener('click', goHome);
  $('#againBtn').addEventListener('click', function () { hideWin(); newGame(mode); });
  $('#changeBtn').addEventListener('click', function () { hideWin(); goHome(); });
  // 팝업만 닫고 완성된 판을 그대로 확인
  function viewBoard() {
    hideWin();
    if (S && S.cellEls) S.cellEls.forEach(function (row) { row.forEach(function (d) { if (d) { d.classList.remove('party'); d.style.animationDelay = ''; } }); });
  }
  $('#winClose').addEventListener('click', viewBoard);
  $('#viewBoardBtn').addEventListener('click', viewBoard);
  el.win.addEventListener('click', function (e) { if (e.target === el.win) viewBoard(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.win.classList.contains('show')) viewBoard(); });
  $('#resultBtn').addEventListener('click', function () { el.win.classList.add('show'); });
  $('#copyLink').addEventListener('click', function () {
    const link = location.origin + '/p/' + S.p.id;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
      function () { toast('문제 링크를 복사했어요', 'ok'); },
      function () { toast(link); });
  });
  $('#verifyBtn').addEventListener('click', runVerifyMode);
  $('#verifyClose').addEventListener('click', function () { el.verify.classList.remove('show'); });

  async function newGame(m) {
    mode = m;
    let pz;
    if (online) {
      try { pz = hydrate((await api('POST', '/api/puzzles', { mode: m })).puzzle); }
      catch (e) { online = false; }
    }
    if (!pz) pz = localPuzzle(m);
    el.start.classList.remove('show');
    startPuzzle(pz, null);
    if (online) history.pushState(null, '', '/p/' + pz.id);
  }

  async function resumeGame() {
    try {
      const r = await api('GET', '/api/progress');
      if (!r.puzzle) { toast('이어서 할 게임이 없어요'); return refreshMe(); }
      el.start.classList.remove('show');
      startPuzzle(hydrate(r.puzzle), r.progress.state);
      history.pushState(null, '', '/p/' + r.puzzle.id);
      toast('이전 게임을 이어서 시작합니다');
    } catch (e) { toast('불러오기 실패: ' + e.message, 'bad'); }
  }

  async function openPuzzleById(id) {
    try {
      const r = await api('GET', '/api/puzzles/' + encodeURIComponent(id));
      const pz = hydrate(r.puzzle);
      let state = null;
      try {
        const pr = await api('GET', '/api/progress');
        if (pr.progress && pr.progress.puzzleId === pz.id) state = pr.progress.state;
      } catch (e) { /* 무시 */ }
      mode = pz.mode;
      el.start.classList.remove('show');
      startPuzzle(pz, state);
      toast(state ? '이 문제를 이어서 풉니다' : '문제 ' + pz.id + ' (' + MODE_NAME[pz.mode] + ')' + (r.best ? ' · 최고 기록 ' + fmtTime(Math.floor(r.best.timeMs / 1000)) : ''));
    } catch (e) {
      toast('문제 ' + id + '을(를) 찾을 수 없어요', 'bad');
      history.replaceState(null, '', '/');
      el.start.classList.add('show');
    }
  }

  async function goHome() {
    if (S && !S.won && !S.testing) await saveNow();
    stopTimer();
    stopBonusTimer();
    S = null;
    el.game.classList.add('hidden');
    el.start.classList.add('show');
    if (online && location.pathname !== '/') history.pushState(null, '', '/');
    refreshMe();
  }

  window.addEventListener('popstate', function () { boot(); });

  // 버튼 물결 효과
  document.addEventListener('pointerdown', function (e) {
    const b = e.target.closest('.btn');
    if (!b) return;
    const r = b.getBoundingClientRect();
    const s = document.createElement('span');
    const d = Math.max(r.width, r.height);
    s.className = 'ripple';
    s.style.width = s.style.height = d + 'px';
    s.style.left = (e.clientX - r.left - d / 2) + 'px';
    s.style.top = (e.clientY - r.top - d / 2) + 'px';
    b.appendChild(s);
    setTimeout(function () { s.remove(); }, 650);
  });

  // 떠다니는 배경 글자
  (function bgTiles() {
    const box = $('#bgTiles');
    const chars = Array.from(DB.slice(0, 200).map(function (w) { return w.word; }).join(''));
    for (let i = 0; i < 16; i++) {
      const t = document.createElement('div');
      t.className = 'bg-tile';
      t.textContent = chars[Math.floor(Math.random() * chars.length)];
      t.style.left = (Math.random() * 100) + 'vw';
      t.style.animationDuration = (14 + Math.random() * 16) + 's';
      t.style.animationDelay = (-Math.random() * 25) + 's';
      box.appendChild(t);
    }
  })();

  /* ================= 게임 시작 / 복원 ================= */
  function startPuzzle(puzzle, saved, opts) {
    opts = opts || {};
    $('#resultBtn').classList.add('hidden');
    stopTimer(); stopBonusTimer();
    mode = puzzle.mode;
    const rows = puzzle.rows, cols = puzzle.cols;
    S = {
      p: puzzle,
      values: [], locked: [], revealed: {}, owners: [],
      solved: new Set(), active: null, cur: null, comp: H.empty(), pt: null,
      hammers: START_HAMMERS, hammersUsed: 0,
      bonus: puzzle.bonusWordId != null ? { wordId: puzzle.bonusWordId, state: 'idle', deadline: 0 } : null,
      elapsedBase: 0, resumeAt: Date.now(), timerId: null, won: false,
      testing: !!opts.test, dirty: false
    };
    for (let r = 0; r < rows; r++) {
      S.values.push(new Array(cols).fill(''));
      S.locked.push(new Array(cols).fill(false));
      S.owners.push(new Array(cols).fill(null).map(function () { return {}; }));
    }
    puzzle.words.forEach(function (w) { w.cells.forEach(function (rc) { S.owners[rc[0]][rc[1]][w.dir] = w.id; }); });
    puzzle.reveals.forEach(function (x) { reveal(x.r, x.c, 'start'); });

    if (saved) restoreState(saved);

    el.badge.textContent = MODE_NAME[mode];
    el.badge.className = 'badge ' + mode;
    el.pid.textContent = puzzle.id;
    el.game.classList.remove('hidden');
    renderBoard();
    renderClues();
    S.solved.forEach(function (id) { markSolvedUi(wordById(id), true); });
    updateScore(); updateHammers();
    S.timerId = setInterval(tick, 1000); tick();
    puzzle.words.forEach(function (w) { if (!S.solved.has(w.id) && isCorrect(w)) solveWord(w, true); });
    if (S.won) return;
    const first = puzzle.words.find(function (w) { return !S.solved.has(w.id); });
    // 시작·이어하기 때 자동으로 잡히는 첫 포커스는 '사용자가 고른 포커스'가 아니므로 타임 어택을 켜지 않는다
    S.suppressBonus = true;
    if (first) selectWord(first.id, cursorStart(first), true);
    if (!saved && puzzle.reveals.length) toast('★ 표시된 칸 ' + puzzle.reveals.length + '곳의 글자가 공개되었어요');
    if (!saved) scheduleSave();
  }

  function reveal(r, c, kind) {
    S.values[r][c] = S.p.grid[r][c];
    S.locked[r][c] = true;
    S.revealed[r + ',' + c] = kind;
  }

  function serializeState() {
    return {
      v: 1,
      values: S.values,
      revealed: Object.keys(S.revealed).map(function (k) { return [k, S.revealed[k]]; }),
      solved: Array.from(S.solved),
      hammers: S.hammers, hammersUsed: S.hammersUsed,
      bonusState: S.bonus ? (S.bonus.state === 'running' ? 'lost' : S.bonus.state) : null,
      elapsedMs: elapsedMs()
    };
  }

  function restoreState(st) {
    const p = S.p;
    if (st.values && st.values.length === p.rows) {
      for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
        const v = st.values[r] && st.values[r][c];
        if (p.grid[r][c] && typeof v === 'string' && Array.from(v).length <= 1) S.values[r][c] = v;
      }
    }
    (st.revealed || []).forEach(function (x) {
      const rc = x[0].split(',').map(Number);
      if (p.grid[rc[0]] && p.grid[rc[0]][rc[1]]) reveal(rc[0], rc[1], x[1]);
    });
    (st.solved || []).forEach(function (id) {
      const w = p.words[id];
      if (!w) return;
      S.solved.add(id);
      w.cells.forEach(function (rc, k) { S.values[rc[0]][rc[1]] = w.chars[k]; S.locked[rc[0]][rc[1]] = true; });
    });
    if (typeof st.hammers === 'number') S.hammers = Math.max(0, st.hammers | 0);
    S.hammersUsed = st.hammersUsed | 0;
    if (S.bonus && st.bonusState) S.bonus.state = st.bonusState;
    S.elapsedBase = +st.elapsedMs || 0;
    S.resumeAt = Date.now();
  }

  /* ---- 저장 ---- */
  let saveT = null;
  function scheduleSave() {
    if (!S || S.testing || !online || S.won) return;
    S.dirty = true;
    clearTimeout(saveT);
    saveT = setTimeout(saveNow, 700);
  }
  function progressBody() {
    return { puzzleId: S.p.id, solved: S.solved.size, elapsedMs: elapsedMs(), state: serializeState() };
  }
  async function saveNow() {
    clearTimeout(saveT);
    if (!S || S.testing || !online || S.won || String(S.p.id).startsWith('LOCAL')) return;
    try { await api('POST', '/api/progress', progressBody()); S.dirty = false; } catch (e) { /* 다음에 재시도 */ }
  }
  window.addEventListener('pagehide', function () {
    if (!S || S.testing || !online || S.won || String(S.p.id).startsWith('LOCAL')) return;
    try { navigator.sendBeacon('/api/progress', new Blob([JSON.stringify(progressBody())], { type: 'application/json' })); } catch (e) { /* 무시 */ }
  });

  /* ---- 시간 ---- */
  function elapsedMs() { return S.elapsedBase + (S.resumeAt ? Date.now() - S.resumeAt : 0); }
  function tick() {
    if (!S) return;
    el.timer.textContent = fmtTime(Math.floor(elapsedMs() / 1000));
    if (S.dirty === false && !S.won && Math.floor(elapsedMs() / 1000) % 15 === 0) scheduleSave();
  }
  document.addEventListener('visibilitychange', function () {
    if (!S || S.won) return;
    if (document.hidden) { S.elapsedBase = elapsedMs(); S.resumeAt = 0; saveNow(); }
    else S.resumeAt = Date.now();
  });
  function fmtTime(s) { return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function fmtDate(t) { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function stopTimer() { if (S && S.timerId) { clearInterval(S.timerId); S.timerId = null; } }

  /* ================= 렌더링 ================= */
  function cellSize() {
    const p = S.p;
    const W = window.innerWidth, Hh = window.innerHeight;
    const availW = W > 1020 ? Math.min(W - 420, 760) : W - 34;
    const availH = W > 1020 ? Hh - 230 : 99999;
    const gap = W <= 640 ? 2 : 3;
    const byW = (availW - 20 - gap * (p.cols - 1)) / p.cols;
    const byH = (availH - 20 - gap * (p.rows - 1)) / p.rows;
    return Math.max(17, Math.min(48, Math.floor(Math.min(byW, byH))));
  }

  function renderBoard() {
    const p = S.p;
    el.board.innerHTML = '';
    el.board.style.setProperty('--cs', cellSize() + 'px');
    el.board.style.gridTemplateColumns = 'repeat(' + p.cols + ', var(--cs))';
    const starts = {};
    p.words.forEach(function (w) { const k = w.r + ',' + w.c; (starts[k] = starts[k] || []).push(w.num); });
    S.cellEls = [];
    for (let r = 0; r < p.rows; r++) {
      S.cellEls.push([]);
      for (let c = 0; c < p.cols; c++) {
        const d = document.createElement('div');
        if (p.grid[r][c]) {
          d.className = 'cell white';
          d.style.animationDelay = ((r + c) * 18) + 'ms';
          const k = r + ',' + c;
          if (starts[k]) {
            const n = document.createElement('span');
            n.className = 'num';
            n.textContent = starts[k].join('·');
            d.appendChild(n);
          }
          const ch = document.createElement('span');
          ch.className = 'ch';
          d.appendChild(ch);
          d.addEventListener('mousedown', function (e) { e.preventDefault(); });
          d.addEventListener('click', function () { onCellClick(r, c); });
        } else {
          d.className = 'cell blank';
        }
        el.board.appendChild(d);
        S.cellEls[r].push(d);
      }
    }
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) if (p.grid[r][c]) paintCell(r, c, false);
    paintBonus();
    sizeFx();
  }

  function paintCell(r, c, pop) {
    const d = S.cellEls[r][c];
    const ch = d.querySelector('.ch');
    const v = S.values[r][c];
    const kind = S.revealed[r + ',' + c];
    d.classList.toggle('revealed', !!kind);
    d.classList.toggle('hammered', kind === 'hammer');
    if (ch.textContent !== v) {
      ch.textContent = v;
      if (pop && v) { d.classList.remove('pop'); void d.offsetWidth; d.classList.add('pop'); }
    }
  }

  function paintBonus() {
    if (!S.bonus) return;
    // 타임 어택 낱말은 시작 전에는 아무 표시도 하지 않는다. 진행 중일 때만 낱말 전체를 강조
    const b = S.bonus;
    const w = wordById(b.wordId);
    w.cells.forEach(function (rc) { S.cellEls[rc[0]][rc[1]].classList.toggle('bonus-run', b.state === 'running'); });
    if (w.li) w.li.classList.toggle('bonus-run', b.state === 'running');
  }

  function clueText(w) {
    if (w.hasHint) return escapeHtml(w.hint);
    return '<span class="nohint">힌트 없음</span>';
  }

  function renderClues() {
    el.across.innerHTML = ''; el.down.innerHTML = '';
    let i = 0;
    S.p.words.forEach(function (w) {
      const li = document.createElement('li');
      li.className = 'clue' + (w.hasHint ? '' : ' nohint');
      li.dataset.id = w.id;
      li.style.animationDelay = (i++ * 25) + 'ms';
      li.innerHTML =
        '<span class="clue-num">' + w.num + '</span>' +
        '<span class="clue-body"><span class="clue-text">' + clueText(w) + '</span>' +
        '<span class="clue-len">(' + w.len + '글자)</span></span>';
      li.addEventListener('mousedown', function (e) { e.preventDefault(); });
      li.addEventListener('click', function () { userActed(); selectWord(w.id, cursorStart(w)); });
      (w.dir === 'across' ? el.across : el.down).appendChild(li);
      w.li = li;
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function updateScore() {
    const n = S.p.words.length, k = S.solved.size;
    el.score.textContent = k + ' / ' + n;
    el.bar.style.width = (k / n * 100) + '%';
  }

  function updateHammers(bump) {
    el.hammerCount.textContent = S.hammers;
    el.hammerBtn.disabled = S.hammers <= 0 || S.won;
    if (bump) { el.hammerBtn.classList.remove('bump'); void el.hammerBtn.offsetWidth; el.hammerBtn.classList.add('bump'); }
  }

  /* ================= 선택 / 커서 ================= */
  function wordById(id) { return S.p.words[id]; }
  function isLocked(rc) { return S.locked[rc[0]][rc[1]]; }
  function curIdx() {
    const w = wordById(S.active);
    return w.cells.findIndex(function (rc) { return rc[0] === S.cur[0] && rc[1] === S.cur[1]; });
  }
  function firstEditable(w) {
    for (let k = 0; k < w.len; k++) { const rc = w.cells[k]; if (!isLocked(rc) && !S.values[rc[0]][rc[1]]) return k; }
    for (let k = 0; k < w.len; k++) { if (!isLocked(w.cells[k])) return k; }
    return 0;
  }
  // 낱말 선택 시 커서 시작 위치: 첫 빈 칸, 단 그 앞이 잠긴 칸들이면 잠긴 칸부터 (단어 전체를 쳐도 되도록)
  function cursorStart(w) {
    let f = firstEditable(w);
    while (f > 0 && isLocked(w.cells[f - 1])) f--;
    return f;
  }
  // 포커스가 숨겨진 타임 어택 낱말로 처음 옮겨 가면 알림과 함께 타이머 시작
  function userActed() {
    if (!S || !S.suppressBonus) return;
    S.suppressBonus = false;
    maybeStartBonus();
  }
  function maybeStartBonus() {
    const b = S.bonus;
    if (S.suppressBonus) return;
    if (b && b.state === 'idle' && S.active === b.wordId && !S.solved.has(b.wordId) && !S.won) startBonus();
  }
  function nextEditable(w, from) {
    for (let k = from + 1; k < w.len; k++) if (!isLocked(w.cells[k])) return k;
    return -1;
  }

  function onCellClick(r, c) {
    if (!S || S.won) return;
    userActed();
    const own = S.owners[r][c];
    const cur = S.active !== null ? wordById(S.active) : null;
    let id;
    if (cur && S.cur && S.cur[0] === r && S.cur[1] === c && own.across !== undefined && own.down !== undefined) {
      id = cur.dir === 'across' ? own.down : own.across; // 같은 칸 다시 누르면 방향 전환
    } else if (cur && own[cur.dir] === cur.id) {
      id = cur.id;
    } else {
      const pref = cur ? cur.dir : 'across';
      id = own[pref] !== undefined ? own[pref] : (own.across !== undefined ? own.across : own.down);
    }
    const w = wordById(id);
    selectWord(id, w.cells.findIndex(function (rc) { return rc[0] === r && rc[1] === c; }));
  }

  function selectWord(id, idx, silent) {
    const changed = S.active !== id;
    endComp();
    S.active = id;
    const w = wordById(id);
    setCursor(w.cells[Math.max(0, Math.min(idx || 0, w.len - 1))]);
    if (changed || !silent) showCurrentClue(!silent);
  }

  // 커서는 잠긴(맞힌·공개된) 칸 위에도 올라갈 수 있다
  function setCursor(rc) {
    S.cur = [rc[0], rc[1]];
    maybeStartBonus();
    highlight();
  }

  function highlight() {
    const p = S.p;
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
      if (p.grid[r][c]) S.cellEls[r][c].classList.remove('inword', 'cursor', 'composing');
    }
    document.querySelectorAll('.clue.active').forEach(function (x) { x.classList.remove('active'); });
    if (S.active === null || !S.cur) return;
    const w = wordById(S.active);
    w.cells.forEach(function (rc) { S.cellEls[rc[0]][rc[1]].classList.add('inword'); });
    const d = S.cellEls[S.cur[0]][S.cur[1]];
    d.classList.add('cursor');
    const ct = compTarget(); if (!H.isEmpty(S.comp) && ct) S.cellEls[ct[0]][ct[1]].classList.add('composing');
    w.li.classList.add('active');
  }

  function showCurrentClue(flash) {
    const w = wordById(S.active);
    el.cc.querySelector('.cc-num').textContent = w.num + ' ' + DIR_NAME[w.dir];
    el.cc.querySelector('.cc-text').innerHTML = S.solved.has(w.id)
      ? '<b>' + w.word + '</b> — ' + escapeHtml(w.def)
      : clueText(w) + ' <span style="opacity:.6">(' + w.len + '글자)</span>';
    if (flash) { el.cc.classList.remove('flash'); void el.cc.offsetWidth; el.cc.classList.add('flash'); }
    if (w.li && window.innerWidth > 1020) w.li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ================= 입력 처리 (자체 한글 조합) ================= */
  function gameAcceptsKeys() {
    if (S && S.testing) return !S.won && S.active !== null;
    return S && !S.won && S.active !== null && !el.game.classList.contains('hidden') &&
      !el.start.classList.contains('show') && !el.win.classList.contains('show') && !el.verify.classList.contains('show') &&
      !document.querySelector('#panelScreen').classList.contains('show');
  }

  document.addEventListener('keydown', function (e) {
    if (!gameAcceptsKeys()) return;
    if (S.suppressBonus) setTimeout(userActed, 0);  // 키 처리 후 포커스가 타임 어택 낱말이면 시작
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key, code = e.code;
    if (S.spill && !H.keyToJamo(code, e.shiftKey) && k !== 'Shift') S.spill = null;
    if (k === 'Backspace') { e.preventDefault(); backspace(); return; }
    if (k === 'Delete') { e.preventDefault(); deleteCell(); return; }
    if (k === 'Enter' || k === 'Tab') { e.preventDefault(); submitWord(e.shiftKey); return; }
    if (k === ' ' || code === 'Space') { e.preventDefault(); stepCursor(); return; }
    if (k.indexOf('Arrow') === 0) {
      e.preventDefault();
      endComp();
      moveCursor(k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0, k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0);
      return;
    }
    let j = H.keyToJamo(code, e.shiftKey);
    if (!j && k && k.length === 1 && (H.isVowel(k) || H.isConsonant(k))) j = k;
    if (j) { e.preventDefault(); inputJamo(j); }
  });

  function setCell(rc, v) {
    if (S.values[rc[0]][rc[1]] === v) return false;
    S.values[rc[0]][rc[1]] = v;
    paintCell(rc[0], rc[1], true);
    return true;
  }

  /*
   * 잠긴 칸 통과(pass-through)
   * 커서가 잠긴 칸 위에서 글자를 치기 시작하면, 조합 중인 글자는 다음 빈 칸(e)에 미리 보여 준다.
   * 그 글자가 완성되었을 때 잠긴 칸의 글자와 같으면 "지나가기"로 보고 e 칸을 원래대로 되돌리고,
   * 다르면 e 칸에 그대로 확정한다. → 단어 전체를 쳐도, 빈 칸만 쳐도 모두 올바르게 들어간다.
   */
  function endComp() { S.comp = H.empty(); S.pt = null; S.spill = null; }
  function compTarget() {
    if (S.pt) return S.pt.e >= 0 ? wordById(S.active).cells[S.pt.e] : null;
    return S.cur;
  }
  function beginPassThrough(w, k) {
    const e = nextEditable(w, k);
    S.pt = { lock: k, e: e, prev: e >= 0 ? S.values[w.cells[e][0]][w.cells[e][1]] : '' };
  }
  function renderComp() {
    const t = compTarget();
    if (t) setCell(t, H.compose(S.comp));
    return t;
  }

  function inputJamo(j) {
    if (absorbSpill(j)) return;
    const w = wordById(S.active);
    if (S.solved.has(w.id)) { goNext(); if (S.active === null || S.solved.has(S.active)) return; return inputJamo(j); }
    if (!S.pt && H.isEmpty(S.comp) && isLocked(S.cur)) beginPassThrough(w, curIdx());
    const res = H.step(S.comp, j);
    if (!res.next) {
      S.comp = res.cur;
      const t = renderComp();
      afterChange(t ? [t] : []);
      return;
    }
    // 한 글자가 완성되고 다음 글자가 시작됨
    const fin = H.compose(res.cur);
    let finIdx = -1, nextIdx, passed = false;
    if (S.pt) {
      const end = S.pt.e >= 0 ? S.pt.e : w.len;
      let m = -1;
      for (let k = S.pt.lock; k < end; k++) if (isLocked(w.cells[k]) && w.chars[k] === fin) { m = k; break; }
      if (m >= 0) { passed = true; nextIdx = m + 1; }
      else { if (S.pt.e < 0) return; finIdx = S.pt.e; nextIdx = S.pt.e + 1; }
    } else { finIdx = curIdx(); nextIdx = finIdx + 1; }
    if (nextIdx >= w.len && !passed) { if (isFull(w) && !isCorrect(w)) wrongFeedback(w); return; }

    const changed = [];
    if (passed) { if (S.pt.e >= 0) { const rc = w.cells[S.pt.e]; setCell(rc, S.pt.prev); changed.push(rc); } }
    else { setCell(w.cells[finIdx], fin); changed.push(w.cells[finIdx]); }
    S.pt = null;
    if (nextIdx >= w.len) { S.comp = H.empty(); afterChange(changed); return; }
    S.comp = res.next;
    setCursor(w.cells[nextIdx]);
    if (isLocked(S.cur)) beginPassThrough(w, nextIdx);
    const t = renderComp();
    if (t) changed.push(t);
    afterChange(changed);
  }

  function backspace() {
    const w = wordById(S.active);
    if (!H.isEmpty(S.comp)) {
      S.comp = H.back(S.comp);
      let t = compTarget();
      if (H.isEmpty(S.comp) && S.pt) { if (t) setCell(t, S.pt.prev); S.pt = null; }
      else t = renderComp();
      afterChange(t ? [t] : []);
      return;
    }
    S.pt = null;
    if (!isLocked(S.cur) && S.values[S.cur[0]][S.cur[1]]) {
      setCell(S.cur, '');
    } else {
      for (let k = curIdx() - 1; k >= 0; k--) {
        if (!isLocked(w.cells[k])) { setCursor(w.cells[k]); setCell(S.cur, ''); break; }
      }
    }
    highlight();
    scheduleSave();
  }

  function deleteCell() {
    endComp();
    if (!isLocked(S.cur)) setCell(S.cur, '');
    highlight(); scheduleSave();
  }

  function stepCursor() {
    endComp();
    const w = wordById(S.active);
    const i = curIdx();
    if (i < w.len - 1) setCursor(w.cells[i + 1]); else highlight();
  }

  function submitWord(back) {
    endComp();
    const w = wordById(S.active);
    if (!S.solved.has(w.id) && isFull(w) && !isCorrect(w)) wrongFeedback(w);
    goNext(back);
  }

  function moveCursor(dr, dc) {
    const p = S.p;
    let rr = S.cur[0] + dr, cc = S.cur[1] + dc;
    while (rr >= 0 && cc >= 0 && rr < p.rows && cc < p.cols) {
      if (p.grid[rr][cc]) {
        const own = S.owners[rr][cc];
        const pref = dr !== 0 ? 'down' : 'across';
        const id = own[pref] !== undefined ? own[pref] : (own.across !== undefined ? own.across : own.down);
        const w = wordById(id);
        const changed = S.active !== id;
        S.active = id;
        setCursor([rr, cc]);
        if (changed) showCurrentClue(true);
        return;
      }
      rr += dr; cc += dc;
    }
    highlight();
  }

  function isCorrect(w) { return w.cells.every(function (rc, k) { return S.values[rc[0]][rc[1]] === w.chars[k]; }); }
  function isFull(w) { return w.cells.every(function (rc) { return S.values[rc[0]][rc[1]] !== ''; }); }

  function afterChange(cells) {
    const ids = new Set();
    cells.forEach(function (rc) {
      const o = S.owners[rc[0]][rc[1]];
      if (o.across !== undefined) ids.add(o.across);
      if (o.down !== undefined) ids.add(o.down);
    });
    let activeSolved = false;
    ids.forEach(function (id) {
      const x = wordById(id);
      if (!S.solved.has(id) && isCorrect(x)) { solveWord(x); if (id === S.active) activeSolved = true; }
    });
    if (S.won) return;
    // 단어가 끝까지 입력되기 전에 정답이 되면(뒤쪽 글자가 이미 잠긴 경우),
    // 사용자가 이어서 치는 그 잠긴 글자들이 다음 낱말로 넘어가지 않도록 잠시 흡수한다.
    let spill = null;
    if (activeSolved) {
      const w = wordById(S.active);
      const t = compTarget() || S.cur;
      const i = w.cells.findIndex(function (rc) { return rc[0] === t[0] && rc[1] === t[1]; });
      const rest = w.chars.slice(i + 1).join('');
      if (rest && !H.isEmpty(S.comp)) {
        const jamo = [];
        Array.from(rest).forEach(function (ch) { H.syllableToJamo(ch).forEach(function (x) { jamo.push(x); }); });
        spill = { jamo: jamo, buf: [], until: Date.now() + 1500 };
      }
    }
    { const ct = compTarget(); if (!H.isEmpty(S.comp) && (!ct || isLocked(ct))) endComp(); }   // 조합 중인 칸이 정답으로 잠기면 조합 종료
    if (activeSolved) { goNext(); S.spill = spill; } else highlight();
    scheduleSave();
  }

  // 정답 직후 흡수 중인 키라면 true
  function absorbSpill(j) {
    const sp = S.spill;
    if (!sp) return false;
    if (Date.now() > sp.until) { S.spill = null; return false; }
    sp.buf.push(j);
    const ok = sp.buf.every(function (x, i) { return sp.jamo[i] === x; });
    if (ok) {
      if (sp.buf.length >= sp.jamo.length) S.spill = null; else sp.until = Date.now() + 1500;
      return true;
    }
    S.spill = null;
    sp.buf.forEach(function (x) { inputJamo(x); });  // 다른 글자를 치려던 것이면 그대로 다시 입력
    return true;
  }

  function goNext(back) {
    if (!S || S.won) return;
    const n = S.p.words.length;
    const cur = S.active === null ? -1 : S.active;
    for (let i = 1; i <= n; i++) {
      const id = ((cur + (back ? -i : i)) % n + n) % n;
      if (!S.solved.has(id)) { selectWord(id, cursorStart(wordById(id))); return; }
    }
  }

  /* ================= 망치 아이템 ================= */
  el.hammerBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  el.hammerBtn.addEventListener('click', useHammer);

  function useHammer() {
    if (!S || S.won || S.active === null) return;
    if (S.hammers <= 0) { toast('망치가 없어요', 'bad'); return; }
    const w = wordById(S.active);
    let target = null;
    if (!isLocked(S.cur) && S.values[S.cur[0]][S.cur[1]] !== S.p.grid[S.cur[0]][S.cur[1]]) target = S.cur;
    if (!target) target = w.cells.find(function (rc) { return !isLocked(rc) && S.values[rc[0]][rc[1]] !== S.p.grid[rc[0]][rc[1]]; });
    if (!target) target = w.cells.find(function (rc) { return !isLocked(rc); });
    if (!target) { toast('이 낱말에는 공개할 칸이 없어요'); return; }
    S.hammers--; S.hammersUsed++;
    updateHammers(true);
    const rc = [target[0], target[1]];
    hammerAnim(rc, function () {
      if (!S) return;
      { const ct = compTarget(); if (ct && ct[0] === rc[0] && ct[1] === rc[1]) endComp(); }
      reveal(rc[0], rc[1], 'hammer');
      paintCell(rc[0], rc[1], true);
      const d = S.cellEls[rc[0]][rc[1]];
      d.classList.remove('smash'); void d.offsetWidth; d.classList.add('smash');
      sparks(d, ['#e3a92b', '#fff1bf', '#d9583b'], 18);
      toast('🔨 한 글자 공개! 남은 망치 ' + S.hammers + '개');
      afterChange([rc]);
    });
  }

  function hammerAnim(rc, done) {
    if (S.testing) { done(); return; }
    const d = S.cellEls[rc[0]][rc[1]];
    const h = document.createElement('div');
    h.className = 'hammer-fly'; h.textContent = '🔨';
    const from = el.hammerBtn.getBoundingClientRect(), to = d.getBoundingClientRect();
    h.style.left = from.left + 'px'; h.style.top = from.top + 'px';
    document.body.appendChild(h);
    requestAnimationFrame(function () {
      h.style.transform = 'translate(' + (to.left - from.left + to.width * 0.25) + 'px,' + (to.top - from.top - to.height * 0.6) + 'px) rotate(-40deg)';
    });
    setTimeout(function () { h.classList.add('hit'); }, 380);
    setTimeout(function () { done(); }, 520);
    setTimeout(function () { h.remove(); }, 800);
  }

  /* ================= 타임 어택 낱말 (망치 획득 기회: 한 판에 한 번) =================
   * 판마다 낱말 하나가 몰래 타임 어택 낱말로 정해진다. 화면에는 표시되지 않다가
   * 그 낱말에 포커스가 처음 가는 순간 알림이 뜨고 10초 타이머가 시작된다.
   * 10초 안에 낱말을 맞히면 망치 +1, 못 맞히면 기회가 사라진다.
   */
  let bonusTimer = null;
  function startBonus() {
    const b = S.bonus;
    b.state = 'running';
    b.deadline = Date.now() + BONUS_MS;
    paintBonus();
    stopBonusTimer();
    el.bonusBar.classList.add('show');
    el.bonusBar.classList.remove('alert'); void el.bonusBar.offsetWidth; el.bonusBar.classList.add('alert');
    toast('⏱ 타임 어택 낱말! ' + (BONUS_MS / 1000) + '초 안에 맞히면 망치 +' + BONUS_HAMMERS);
    bonusTimer = setInterval(updateBonus, 50);
    updateBonus();
  }
  function updateBonus() {
    if (!S || !S.bonus || S.bonus.state !== 'running') { stopBonusTimer(); return; }
    const left = S.bonus.deadline - Date.now();
    const f = Math.max(0, left / BONUS_MS);
    el.bonusBar.querySelector('.bonus-fill').style.width = (f * 100) + '%';
    el.bonusBar.querySelector('.bonus-sec').textContent = (Math.max(0, left) / 1000).toFixed(1) + '초';
    el.bonusBar.classList.toggle('hurry', left < 3000);
    if (left <= 0) endBonus(false);
  }
  function stopBonusTimer() { if (bonusTimer) { clearInterval(bonusTimer); bonusTimer = null; } el.bonusBar.classList.remove('show', 'hurry'); }
  // 낱말이 정답 처리될 때 호출
  function bonusOnSolved(w) {
    const b = S.bonus;
    if (!b || b.wordId !== w.id) return;
    if (b.state === 'running') endBonus(true);
    else if (b.state === 'idle') { b.state = 'lost'; }   // 포커스 없이(교차로) 풀리면 기회 소멸 (알림 없음)
  }
  function endBonus(success, silent) {
    const b = S.bonus;
    b.state = success ? 'won' : 'lost';
    stopBonusTimer();
    paintBonus();
    if (success) {
      S.hammers += BONUS_HAMMERS;
      updateHammers(true);
      const w = wordById(b.wordId);
      w.cells.forEach(function (rc, k) { sparks(S.cellEls[rc[0]][rc[1]], ['#e3a92b', '#2f9d6a', '#fff1bf'], 10, k * 3); });
      flyToHammer(S.cellEls[w.cells[0][0]][w.cells[0][1]]);
      toast('🎉 타임 어택 성공! 망치 +' + BONUS_HAMMERS, 'ok');
    } else if (!silent) {
      toast('⏱ 시간 초과! 이번 판의 망치 획득 기회가 지나갔어요', 'bad');
    }
    scheduleSave();
  }
  function flyToHammer(d) {
    if (S.testing) return;
    const h = document.createElement('div');
    h.className = 'hammer-fly gain'; h.textContent = '🔨';
    const from = d.getBoundingClientRect(), to = el.hammerBtn.getBoundingClientRect();
    h.style.left = from.left + 'px'; h.style.top = from.top + 'px';
    document.body.appendChild(h);
    requestAnimationFrame(function () { h.style.transform = 'translate(' + (to.left - from.left) + 'px,' + (to.top - from.top) + 'px) scale(.6) rotate(360deg)'; });
    setTimeout(function () { h.remove(); }, 800);
  }

  /* ================= 정답 / 오답 효과 ================= */
  function solveWord(w, quiet) {
    S.solved.add(w.id);
    w.cells.forEach(function (rc, k) {
      S.values[rc[0]][rc[1]] = w.chars[k];
      S.locked[rc[0]][rc[1]] = true;
      paintCell(rc[0], rc[1]);
    });
    markSolvedUi(w, quiet);
    updateScore();
    if (!quiet) {
      burst(w);
      toast(pick(['정답!', '좋아요!', '훌륭해요!', '딱 맞았어요!', '척척박사!']) + ' · ' + w.word, 'ok');
    }
    bonusOnSolved(w);
    if (S.active === w.id) showCurrentClue(false);
    if (S.solved.size === S.p.words.length) win();
  }

  function markSolvedUi(w, quiet) {
    w.cells.forEach(function (rc, k) {
      const d = S.cellEls[rc[0]][rc[1]];
      d.classList.add('solved');
      if (!quiet) setTimeout(function () { d.classList.remove('wave'); void d.offsetWidth; d.classList.add('wave'); }, k * 70);
    });
    const li = w.li;
    li.classList.remove('nohint');
    li.classList.add('solved');
    const fill = function () {
      li.querySelector('.clue-body').innerHTML =
        '<span class="clue-answer">' + w.word + '</span><span class="clue-def">' + escapeHtml(w.def) + '</span>';
    };
    if (quiet || S.testing) fill(); else { li.classList.add('flip'); setTimeout(fill, 300); }
  }

  function wrongFeedback(w) {
    w.cells.forEach(function (rc) {
      const d = S.cellEls[rc[0]][rc[1]];
      if (isLocked(rc)) return;
      d.classList.remove('wrong'); void d.offsetWidth; d.classList.add('wrong');
      setTimeout(function () { d.classList.remove('wrong'); }, 500);
    });
    toast('다시 생각해 보세요', 'bad');
  }

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  let toastT = null;
  function toast(msg, kind) {
    el.toast.textContent = msg;
    el.toast.className = 'toast show ' + (kind || '');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.toast.className = 'toast'; }, 1800);
  }

  /* ---- 파티클 ---- */
  const fxCtx = el.fx.getContext('2d');
  let parts = [], fxRunning = false;
  function sizeFx() {
    const r = el.boardOuter.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    el.fx.width = r.width * dpr; el.fx.height = r.height * dpr;
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function sparks(d, colors, n, delay) {
    const x = d.offsetLeft + d.offsetWidth / 2, y = d.offsetTop + d.offsetHeight / 2;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 3.5;
      parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5, life: 40 + Math.random() * 25,
        max: 65, c: colors[i % colors.length], r: 2 + Math.random() * 3, delay: delay || 0 });
    }
    if (!fxRunning) { fxRunning = true; requestAnimationFrame(fxLoop); }
  }
  function burst(w) {
    const colors = ['#2f9d6a', '#e3a92b', '#d9583b', '#2f6f8f', '#9fe0bd'];
    w.cells.forEach(function (rc, k) { sparks(S.cellEls[rc[0]][rc[1]], colors, 9, k * 4); });
  }
  function fxLoop() {
    fxCtx.clearRect(0, 0, el.fx.width, el.fx.height);
    parts = parts.filter(function (p) { return p.life > 0; });
    parts.forEach(function (p) {
      if (p.delay > 0) { p.delay--; return; }
      p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life--;
      fxCtx.globalAlpha = Math.max(0, p.life / p.max);
      fxCtx.fillStyle = p.c;
      fxCtx.beginPath(); fxCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2); fxCtx.fill();
    });
    fxCtx.globalAlpha = 1;
    if (parts.length) requestAnimationFrame(fxLoop); else fxRunning = false;
  }

  /* ================= 화면 키보드 ================= */
  (function buildKeyboard() {
    const rows = [
      ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
      ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'],
      ['Shift', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Back'],
      ['Hammer', 'Space', 'Enter']
    ];
    let shift = false;
    function label() {
      el.kbd.querySelectorAll('[data-code]').forEach(function (b) {
        const c = b.dataset.code;
        if (H.KEYMAP[c]) b.textContent = H.keyToJamo(c, shift);
      });
      el.kbd.querySelector('[data-code=Shift]').classList.toggle('on', shift);
    }
    rows.forEach(function (row) {
      const rd = document.createElement('div'); rd.className = 'krow';
      row.forEach(function (code) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'key'; b.dataset.code = code;
        if (code === 'Shift') { b.textContent = '⇧'; b.classList.add('wide'); }
        else if (code === 'Back') { b.textContent = '⌫'; b.classList.add('wide'); }
        else if (code === 'Space') { b.textContent = '칸 이동'; b.classList.add('space'); }
        else if (code === 'Enter') { b.textContent = '다음 낱말'; b.classList.add('wide2'); }
        else if (code === 'Hammer') { b.textContent = '🔨 망치'; b.classList.add('wide2'); }
        else if (H.isVowel(H.keyToJamo(code))) b.classList.add('vowel');
        b.addEventListener('pointerdown', function (e) {
          e.preventDefault();
          if (S && S.suppressBonus) setTimeout(userActed, 0);
          b.classList.remove('press'); void b.offsetWidth; b.classList.add('press');
          if (code === 'Shift') { shift = !shift; label(); return; }
          if (code === 'Hammer') { useHammer(); return; }
          if (!gameAcceptsKeys()) return;
          if (code === 'Back') backspace();
          else if (code === 'Space') stepCursor();
          else if (code === 'Enter') submitWord(false);
          else { inputJamo(H.keyToJamo(code, shift)); if (shift) { shift = false; label(); } }
        });
        rd.appendChild(b);
      });
      el.kbd.appendChild(rd);
    });
    label();
    let showKbd = false;
    try { showKbd = localStorage.getItem('cw-kbd') === '1'; } catch (e) { /* 무시 */ }
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) showKbd = true;
    el.kbd.classList.toggle('hidden', !showKbd);
    el.kbdToggle.addEventListener('click', function () {
      const on = el.kbd.classList.toggle('hidden') === false;
      try { localStorage.setItem('cw-kbd', on ? '1' : '0'); } catch (e) { /* 무시 */ }
    });
  })();

  /* ================= 승리 ================= */
  async function win() {
    S.won = true;
    S.elapsedBase = elapsedMs(); S.resumeAt = 0;
    stopTimer(); stopBonusTimer();
    updateHammers();
    if (S.testing) return;
    const timeMs = S.elapsedBase;
    S.active = null;
    highlight();
    const p = S.p;
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
      if (!p.grid[r][c]) continue;
      const d = S.cellEls[r][c];
      setTimeout(function () { d.classList.add('party'); d.style.animationDelay = ((r + c) * 60) + 'ms'; }, 600);
    }
    $('#winText').innerHTML = '<b>' + MODE_NAME[mode] + '</b> 모드 문제 <b>' + p.id + '</b>의 낱말 <b>' + p.words.length +
      '개</b>를 모두 맞혔어요!<br>클리어 시간 <b>' + fmtTime(Math.floor(timeMs / 1000)) + '</b> · 사용한 망치 ' + S.hammersUsed + '개';
    $('#winRecord').textContent = '';
    if (online && !String(p.id).startsWith('LOCAL')) {
      try {
        await api('POST', '/api/records', { puzzleId: p.id, timeMs: timeMs, hammersUsed: S.hammersUsed });
        $('#winRecord').textContent = (ME ? ME.name : '') + ' 님의 기록으로 저장했어요.';
      } catch (e) { $('#winRecord').textContent = '기록 저장 실패: ' + e.message; }
    }
    setTimeout(function () { el.win.classList.add('show'); $('#resultBtn').classList.remove('hidden'); confetti(); }, 1100);
  }
  function hideWin() { el.win.classList.remove('show'); confettiStop = true; }

  let confettiStop = false;
  function confetti() {
    confettiStop = false;
    const cv = el.confetti, ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth, Hh = window.innerHeight;
    cv.width = W * dpr; cv.height = Hh * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#d9583b', '#e3a92b', '#2f9d6a', '#2f6f8f', '#f28fb1', '#8e6cd1'];
    const glyphs = ['축', '하', '해', '요', '★', '♥', '완', '성'];
    const P = [];
    function spawnBurst(x, y, n) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 7;
        P.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 4, rot: Math.random() * 6, vr: (Math.random() - .5) * .3,
          w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, c: colors[i % colors.length],
          g: Math.random() < .18 ? glyphs[Math.floor(Math.random() * glyphs.length)] : null, life: 160 + Math.random() * 80 });
      }
    }
    for (let i = 0; i < 140; i++) {
      P.push({ x: Math.random() * W, y: -20 - Math.random() * Hh * .6, vx: (Math.random() - .5) * 2, vy: 2 + Math.random() * 3,
        rot: Math.random() * 6, vr: (Math.random() - .5) * .2, w: 6 + Math.random() * 8, h: 4 + Math.random() * 6,
        c: colors[i % colors.length], g: Math.random() < .12 ? glyphs[i % glyphs.length] : null, life: 400 });
    }
    let frame = 0;
    (function loop() {
      if (confettiStop) { ctx.clearRect(0, 0, W, Hh); return; }
      frame++;
      if (frame < 240 && frame % 40 === 1) spawnBurst(W * (.15 + Math.random() * .7), Hh * (.15 + Math.random() * .35), 70);
      ctx.clearRect(0, 0, W, Hh);
      for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        p.vy += 0.09; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--;
        if (p.life <= 0 || p.y > Hh + 40) { P.splice(i, 1); continue; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, p.life / 60);
        ctx.fillStyle = p.c;
        if (p.g) { ctx.font = 'bold 20px "Noto Sans KR", sans-serif'; ctx.fillText(p.g, -10, 7); }
        else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)) + 1);
        ctx.restore();
      }
      if (P.length || frame < 240) requestAnimationFrame(loop);
    })();
  }

  window.addEventListener('resize', function () {
    if (!S || el.game.classList.contains('hidden')) return;
    el.board.style.setProperty('--cs', cellSize() + 'px');
    sizeFx();
  });

  /* ================= 검증 모드 ================= */
  // 실제 키보드 이벤트(두벌식 키 코드)를 문서에 보내 입력 경로 전체를 검증한다
  function pressKey(code, shift, key) {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: code || '', key: key || code || '', shiftKey: !!shift, bubbles: true, cancelable: true }));
  }
  function typeText(text) { H.textToKeys(text).forEach(function (k) { pressKey(k[0], k[1], 'Process'); }); }
  // how: 'full' = 잠긴 글자까지 단어 전체를 침, 'missing' = 빈 칸 글자만 침
  function typeWordForTest(id, how) {
    const w = wordById(id);
    selectWord(id, cursorStart(w), true);
    const text = how === 'full' ? w.word : w.cells.map(function (rc, k) { return isLocked(rc) ? '' : w.chars[k]; }).join('');
    typeText(text);
  }

  function runVerifyMode() {
    el.verify.classList.add('show');
    const body = $('#verifyBody');
    body.textContent = '검증 중…';
    setTimeout(function () {
      const sections = [];
      let allPass = true;
      const TRIALS = 30;

      // (A) 생성기 + 난이도 로직 반복 검증
      ['easy', 'normal', 'hard'].forEach(function (m) {
        const agg = {};
        for (let t = 0; t < TRIALS; t++) {
          const seed = 1000 + t * 7919 + m.length;
          const p = Gen.applyDifficulty(Gen.generate(DB, { target: 30, attempts: 80, seed: seed }), m, seed);
          V.verifyLayout(p, DB).concat(V.verifyDifficulty(p)).forEach(function (it) {
            const a = agg[it.name] = agg[it.name] || { pass: 0, fail: 0, details: [] };
            if (it.pass) a.pass++; else { a.fail++; if (a.details.length < 3) a.details.push('seed ' + seed + ': ' + it.detail); }
          });
        }
        sections.push({ title: MODE_NAME[m] + ' 모드 — 퍼즐 ' + TRIALS + '개 자동 생성 검증', rows: Object.keys(agg).map(function (k) {
          const a = agg[k];
          if (a.fail) allPass = false;
          return { name: k, pass: a.fail === 0, detail: a.pass + '/' + TRIALS + ' 통과' + (a.details.length ? ' · ' + a.details.join(' / ') : '') };
        }) });
      });

      // (B) 한글 조합기: 사전의 모든 단어를 두벌식 키 입력으로 쳐서 칸마다 정확히 들어가는지
      const bad = DB.filter(function (w) { return H.simulate(w.word, Array.from(w.word).length).join('') !== w.word; });
      if (bad.length) allPass = false;
      sections.push({ title: '한글 입력 (덮어쓰기 방지)', rows: [{ name: '사전 단어 ' + DB.length + '개를 키 입력하면 글자가 한 칸씩 정확히 들어감', pass: bad.length === 0,
        detail: bad.length ? bad.slice(0, 5).map(function (w) { return w.word; }).join(', ') : '오류 0건' }] });

      // (C) 실제 화면(DOM) 검증
      const domRows = [];
      let sample = null;
      ['easy', 'normal'].forEach(function (m) {
        startPuzzle(localPuzzle(m, 4242 + m.length), null, { test: true });
        const p = S.p;
        const ok = function (name, pass, detail) { domRows.push({ name: '[' + MODE_NAME[m] + '] ' + name, pass: !!pass, detail: detail || '' }); if (!pass) allPass = false; };

        const lis = Array.from(document.querySelectorAll('.clue'));
        const withHint = lis.filter(function (li) { const t = li.querySelector('.clue-text'); return t && !li.classList.contains('nohint') && t.textContent.trim(); });
        ok('화면의 모든 번호에 힌트 문구 표시', lis.length === p.words.length && withHint.length === lis.length, withHint.length + '/' + lis.length);
        const nums = lis.map(function (li) { return +li.querySelector('.clue-num').textContent; });
        ok('번호가 겹치지 않음 (가로 ' + el.across.children.length + ' · 세로 ' + el.down.children.length + ')', new Set(nums).size === nums.length, '');

        if (m === 'easy') {
          const shown = p.reveals.filter(function (x) { const d = S.cellEls[x.r][x.c]; return d.classList.contains('revealed') && d.querySelector('.ch').textContent === x.ch; });
          ok('힌트 글자 5개가 격자에 보임', shown.length === 5 && document.querySelectorAll('.cell.revealed').length === 5,
            p.reveals.map(function (x) { return '(' + (x.r + 1) + '행 ' + (x.c + 1) + '열) ' + x.ch; }).join(', '));
          sample = { rows: p.rows, cols: p.cols, grid: p.grid, reveals: p.reveals, bonusCells: p.bonusWordId != null ? p.words[p.bonusWordId].cells.map(function (rc) { return rc[0] + ',' + rc[1]; }) : [] };
        } else {
          ok('공개 글자 없음', document.querySelectorAll('.cell.revealed').length === 0, '');
        }

        ok('시작 망치 ' + START_HAMMERS + '개', S.hammers === START_HAMMERS, el.hammerCount.textContent + '개 표시');

        // 타임 어택 낱말: 숨겨져 있다가 포커스 시 알림 + 10초 타이머, 한 판에 한 번
        if (S.bonus) {
          const bw = wordById(S.bonus.wordId);
          if (S.active !== bw.id) {
            ok('타임 어택 낱말은 포커스 전에는 표시되지 않음', S.bonus.state === 'idle' && !document.querySelector('.bonus-run') && !el.bonusBar.classList.contains('show'), '');
            const other = p.words.find(function (w) { return w.id !== bw.id && !S.solved.has(w.id); });
            selectWord(other.id, 0, true);
            ok('다른 낱말에 포커스해도 타이머가 시작되지 않음', S.bonus.state === 'idle', '');
          }
          S.suppressBonus = true;
          selectWord(bw.id, cursorStart(bw), true);
          ok('시작·이어하기 때의 자동 포커스로는 타이머가 시작되지 않음', S.bonus.state === 'idle' && !el.bonusBar.classList.contains('show'), '');
          // 이지: 힌트 목록 클릭으로 포커스 / 일반: 자동 포커스 상태에서 첫 키 입력
          if (m === 'easy') bw.li.click(); else { pressKey('Space', false, ' '); userActed(); }
          const left = S.bonus.deadline - Date.now();
          ok('타임 어택 낱말에 포커스하면 알림과 10초 타이머 시작 (' + bw.num + '번 ' + bw.word + ')',
            S.bonus.state === 'running' && el.bonusBar.classList.contains('show') && /타임 어택/.test(el.toast.textContent) && left > 9000 && left <= 10000 &&
            bw.cells.every(function (rc) { return S.cellEls[rc[0]][rc[1]].classList.contains('bonus-run'); }),
            '남은 시간 ' + (left / 1000).toFixed(1) + '초 · 알림 "' + el.toast.textContent + '"');
          const before = S.hammers;
          if (m === 'easy') {
            typeWordForTest(bw.id, 'full');
            ok('10초 안에 낱말을 맞히면 망치 +' + BONUS_HAMMERS, S.bonus.state === 'won' && S.hammers === before + BONUS_HAMMERS, '망치 ' + before + ' → ' + S.hammers);
          } else {
            S.bonus.deadline = Date.now() - 1; updateBonus();
            ok('10초가 지나면 실패 처리, 망치 변화 없음', S.bonus.state === 'lost' && S.hammers === before && !el.bonusBar.classList.contains('show'), '망치 ' + before + ' → ' + S.hammers);
          }
          const st = S.bonus.state;
          const other2 = p.words.find(function (w) { return w.id !== bw.id; });
          selectWord(other2.id, 0, true); selectWord(bw.id, 0, true);
          ok('기회는 한 판에 한 번 (다시 포커스해도 재시작 안 됨)', S.bonus.state === st && !el.bonusBar.classList.contains('show') && !document.querySelector('.bonus-run'), '');
        }

        // 망치: 한 글자 공개 + 개수 감소
        const hw = p.words.find(function (w) { return !S.solved.has(w.id) && w.cells.some(function (rc) { return !isLocked(rc); }); });
        selectWord(hw.id, firstEditable(hw), true);
        const hc = S.cur.slice();
        const hBefore = S.hammers;
        useHammer();
        ok('망치 사용 시 커서 칸 한 글자 공개, 망치 1개 감소',
          S.values[hc[0]][hc[1]] === p.grid[hc[0]][hc[1]] && isLocked(hc) && S.hammers === hBefore - 1 && S.cellEls[hc[0]][hc[1]].classList.contains('hammered'),
          '공개 글자 ' + S.values[hc[0]][hc[1]] + ' · 남은 망치 ' + S.hammers);

        // 방향키로 잠긴 칸을 지나갈 수 있는지
        const lw = p.words.find(function (w) { return w.cells.some(function (rc, k) { return k > 0 && k < w.len - 1 && isLocked(rc); }); }) ||
          (function () { const w = p.words.find(function (x) { return x.len >= 3; }); reveal(w.cells[1][0], w.cells[1][1], 'hammer'); paintCell(w.cells[1][0], w.cells[1][1]); return w; })();
        const li2 = lw.cells.findIndex(function (rc, k) { return k > 0 && isLocked(rc); });
        selectWord(lw.id, li2 - 1, true);
        const key = lw.dir === 'across' ? 'ArrowRight' : 'ArrowDown';
        pressKey(key, false, key);
        const onLocked = S.cur[0] === lw.cells[li2][0] && S.cur[1] === lw.cells[li2][1];
        pressKey(key, false, key);
        const passed = li2 + 1 >= lw.len || (S.cur[0] === lw.cells[li2 + 1][0] && S.cur[1] === lw.cells[li2 + 1][1]);
        ok('방향키 커서가 잠긴 칸 위로 올라가고 지나감 (' + lw.num + '번)', onLocked && passed, '');

        // 저장/복원 왕복
        const snap = JSON.stringify(serializeState());
        const pz = S.p;
        startPuzzle(pz, JSON.parse(snap), { test: true });
        const snap2 = serializeState();
        ok('진행 상태 저장 후 이어하기 시 동일하게 복원', JSON.stringify(snap2.values) === JSON.stringify(JSON.parse(snap).values) && snap2.hammers === JSON.parse(snap).hammers && snap2.solved.length === JSON.parse(snap).solved.length,
          '맞힌 낱말 ' + snap2.solved.length + ' · 망치 ' + snap2.hammers);

        // 실제 키 입력으로 모든 단어 풀기
        const fw = p.words.find(function (w) { return !S.solved.has(w.id); });
        typeWordForTest(fw.id);
        ok('키 입력으로 정답 시 단어 정답 처리 + 칸 초록색 (' + fw.num + '번 ' + fw.word + ')', S.solved.has(fw.id) && fw.cells.every(function (rc) { return S.cellEls[rc[0]][rc[1]].classList.contains('solved'); }), '');
        let fullLocked = 0, missLocked = 0, fullOk = 0, missOk = 0;
        p.words.forEach(function (w, i) {
          if (S.solved.has(w.id)) return;
          const hasLock = w.cells.some(isLocked);
          const how = i % 2 ? 'missing' : 'full';
          typeWordForTest(w.id, how);
          if (hasLock) {
            if (how === 'full') { fullLocked++; if (S.solved.has(w.id)) fullOk++; }
            else {
              missLocked++;
              if (S.solved.has(w.id)) missOk++;
              else console.warn('missing-fail', w.word, JSON.stringify(w.cells.map(function (rc) { return S.values[rc[0]][rc[1]] + (isLocked(rc) ? '*' : ''); })));
            }
          }
        });
        ok('이미 맞힌 칸이 있는 낱말: 단어 전체를 입력해도 정답', fullLocked > 0 && fullOk === fullLocked, fullOk + '/' + fullLocked + '개');
        ok('이미 맞힌 칸이 있는 낱말: 빈 칸 글자만 입력해도 정답', missLocked > 0 && missOk === missLocked, missOk + '/' + missLocked + '개');
        const answersOnBoard = p.words.every(function (w) { return w.cells.every(function (rc, k) { return S.cellEls[rc[0]][rc[1]].querySelector('.ch').textContent === w.chars[k]; }); });
        ok('모든 단어를 키 입력한 뒤 격자에 정답이 올바르게 채워짐 (덮어쓰기 없음)', S.solved.size === p.words.length && answersOnBoard, S.solved.size + '/' + p.words.length);
        ok('입력칸 색상이 모두 정답 상태로 전환', document.querySelectorAll('.cell.white.solved').length === document.querySelectorAll('.cell.white').length, '');
        ok('힌트칸이 정답 단어로 바뀜', p.words.every(function (w) { return w.li.classList.contains('solved') && w.li.querySelector('.clue-answer').textContent === w.word; }), '');
        ok('승리 처리됨', S.won === true, '');
      });
      sections.push({ title: '실제 게임 화면(DOM) 검증', rows: domRows });

      let html = '<div class="v-summary ' + (allPass ? 'pass' : 'fail') + '">' + (allPass ? '✅ 모든 검증 항목 통과' : '❌ 실패한 항목이 있습니다') + '</div>';
      sections.forEach(function (s) {
        html += '<div class="v-section"><h3>' + s.title + '</h3>';
        s.rows.forEach(function (r) {
          html += '<div class="v-row"><span class="v-mark ' + (r.pass ? 'pass' : 'fail') + '">' + (r.pass ? '통과' : '실패') +
            '</span><span>' + escapeHtml(r.name) + '<br><span class="v-detail">' + escapeHtml(r.detail) + '</span></span></div>';
        });
        html += '</div>';
      });
      if (sample) {
        html += '<div class="v-section"><h3>이지 모드 표본 퍼즐의 정답 배치 (노랑: 공개 글자 · 파랑: 숨은 타임 어택 낱말)</h3><div class="v-grid" style="grid-template-columns:repeat(' + sample.cols + ',24px)">';
        const rk = new Set(sample.reveals.map(function (x) { return x.r + ',' + x.c; }));
        for (let r = 0; r < sample.rows; r++) for (let c = 0; c < sample.cols; c++) {
          const ch = sample.grid[r][c];
          const cls = rk.has(r + ',' + c) ? 'r' : (sample.bonusCells.indexOf(r + ',' + c) >= 0 ? 'b' : 'w');
          html += ch ? '<span class="' + cls + '">' + ch + '</span>' : '<span></span>';
        }
        html += '</div></div>';
      }
      body.innerHTML = html;
      window.__verifyResult = { allPass: allPass, sections: sections };
      S = null;
      el.game.classList.add('hidden');
      el.start.classList.add('show');
    }, 50);
  }

  window.__crossword = {
    get state() { return S; },
    typeWord: typeWordForTest, typeText: typeText, pressKey: pressKey, useHammer: useHammer,
    serialize: function () { return serializeState(); }
  };

  /* ================= 부팅 ================= */
  async function boot() {
    await refreshMe();
    const m = location.pathname.match(/^\/p\/([A-Za-z0-9]+)/);
    if (/[?&]verify\b/.test(location.search)) { runVerifyMode(); return; }
    if (m && online) { await openPuzzleById(m[1].toUpperCase()); return; }
    if (S) { stopTimer(); stopBonusTimer(); S = null; }
    el.game.classList.add('hidden');
    el.start.classList.add('show');
  }
  boot();
})();

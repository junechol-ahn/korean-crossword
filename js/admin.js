/*
 * 관리자 화면 (/admin)
 * - 관리자 토큰은 sessionStorage 에만 둔다 (탭을 닫으면 사라짐)
 * - 모든 요청에 Authorization: Bearer <토큰> 헤더를 붙인다
 */
(function () {
  'use strict';
  const $ = function (s) { return document.querySelector(s); };
  const KEY = 'cw_admin_token';
  const PAGE = 50;
  const MODE_NAME = { easy: '이지', normal: '일반', hard: '하드' };

  let token = '';
  try { token = sessionStorage.getItem(KEY) || ''; } catch (e) { /* 저장소 사용 불가 */ }
  const st = { q: '', mode: '', user: '', offset: 0, total: 0, loading: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
  }
  function fmtDate(t) {
    const d = new Date(t), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  let toastT = null;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg; el.className = 'toast show ' + (kind || '');
    clearTimeout(toastT); toastT = setTimeout(function () { el.className = 'toast'; }, 2200);
  }

  async function api(method, url) {
    const r = await fetch(url, { method: method, headers: { Authorization: 'Bearer ' + token } });
    const body = await r.json().catch(function () { return {}; });
    if (r.status === 401) { logout(body.error); throw new Error(body.error || '인증 실패'); }
    if (!r.ok) throw new Error(body.error || ('오류 ' + r.status));
    return body;
  }

  /* ---------- 로그인 ---------- */
  function showLogin(msg) {
    $('#recordsBox').classList.add('hidden'); $('#logoutBtn').classList.add('hidden');
    $('#loginBox').classList.remove('hidden');
    const m = $('#loginMsg'); m.textContent = msg || ''; m.classList.toggle('hidden', !msg);
    $('#tokenInput').focus();
  }
  function logout(msg) {
    token = '';
    try { sessionStorage.removeItem(KEY); } catch (e) { /* 무시 */ }
    showLogin(msg);
  }
  async function login(t) {
    token = t;
    try {
      const r = await fetch('/api/admin/session', { headers: { Authorization: 'Bearer ' + token } });
      const body = await r.json().catch(function () { return {}; });
      if (!r.ok) { token = ''; return showLogin(body.error || ('오류 ' + r.status)); }
    } catch (e) { token = ''; return showLogin('서버에 연결할 수 없어요.'); }
    try { sessionStorage.setItem(KEY, token); } catch (e) { /* 무시 */ }
    $('#loginBox').classList.add('hidden');
    $('#recordsBox').classList.remove('hidden'); $('#logoutBtn').classList.remove('hidden');
    load(true);
  }
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const t = $('#tokenInput').value.trim();
    $('#tokenInput').value = '';
    if (t) login(t);
  });
  $('#logoutBtn').addEventListener('click', function () { logout(); });

  /* ---------- 기록 목록 ---------- */
  async function load(reset) {
    if (st.loading) return;
    st.loading = true;
    if (reset) st.offset = 0;
    const qs = new URLSearchParams({ limit: PAGE, offset: st.offset });
    if (st.q) qs.set('q', st.q);
    if (st.mode) qs.set('mode', st.mode);
    if (st.user) qs.set('user', st.user);
    try {
      const r = await api('GET', '/api/admin/records?' + qs);
      if (reset) $('#rows').innerHTML = '';
      $('#rows').insertAdjacentHTML('beforeend', r.records.map(rowHtml).join(''));
      st.total = r.total; st.offset += r.records.length;
      $('#totalInfo').textContent = '전체 ' + r.total + '건' + (st.offset < r.total ? ' · ' + st.offset + '건 표시' : '');
      $('#emptyNote').classList.toggle('hidden', r.total > 0);
      $('#moreBtn').classList.toggle('hidden', st.offset >= r.total);
      const uf = $('#userFilter');
      uf.classList.toggle('hidden', !st.user);
      if (st.user) {
        $('#ufName').textContent = r.user ? r.user.name : '(삭제된 사용자)';
        $('#ufCount').textContent = r.total + '건';
        $('#ufDeleteAll').disabled = r.total === 0;
      }
    } catch (e) {
      if (token) toast(e.message, 'bad');
    } finally { st.loading = false; }
  }
  function rowHtml(x) {
    const renamed = x.nameAtClear && x.nameAtClear !== x.userName;
    return '<tr data-id="' + x.id + '">' +
      '<td>' + fmtDate(x.at) + '</td>' +
      '<td><a class="pid" href="/p/' + esc(x.puzzleId) + '" target="_blank" rel="noopener">' + esc(x.puzzleId) + '</a></td>' +
      '<td><span class="badge sm ' + esc(x.mode) + '">' + (MODE_NAME[x.mode] || esc(x.mode)) + '</span></td>' +
      '<td><button class="link-btn user-link" data-user="' + esc(x.userId) + '" title="이 사용자의 기록만 보기 (사용자 ID ' + esc(String(x.userId).slice(0, 8)) + '…)">' + esc(x.userName) + '</button>' +
        (renamed ? '<small class="muted"> (당시 ' + esc(x.nameAtClear) + ')</small>' : '') + '</td>' +
      '<td>' + fmtTime(x.timeMs) + '</td>' +
      '<td>' + (x.hammersUsed || 0) + '</td>' +
      '<td><button class="btn danger sm del-btn" data-id="' + x.id + '">삭제</button></td>' +
    '</tr>';
  }

  $('#rows').addEventListener('click', async function (e) {
    const ub = e.target.closest('.user-link');
    if (ub) { st.user = ub.dataset.user; load(true); window.scrollTo({ top: 0 }); return; }
    const db = e.target.closest('.del-btn');
    if (!db) return;
    const tr = db.closest('tr');
    const cells = tr.querySelectorAll('td');
    const desc = cells[3].textContent + ' · 문제 ' + cells[1].textContent + ' · ' + cells[4].textContent + ' (' + cells[0].textContent + ')';
    if (!confirm('이 기록을 삭제할까요? 되돌릴 수 없어요.\n\n' + desc)) return;
    db.disabled = true;
    try {
      await api('DELETE', '/api/admin/records/' + db.dataset.id);
      tr.remove();
      st.total--; st.offset--;
      $('#totalInfo').textContent = '전체 ' + st.total + '건';
      if (st.user) $('#ufCount').textContent = st.total + '건';
      $('#emptyNote').classList.toggle('hidden', st.total > 0);
      toast('기록을 삭제했어요.', 'ok');
    } catch (err) { db.disabled = false; if (token) toast(err.message, 'bad'); }
  });

  $('#ufClear').addEventListener('click', function () { st.user = ''; load(true); });
  $('#ufDeleteAll').addEventListener('click', async function () {
    const name = $('#ufName').textContent;
    if (!confirm(name + ' 님의 기록 ' + st.total + '건을 모두 삭제할까요? 되돌릴 수 없어요.')) return;
    try {
      const r = await api('DELETE', '/api/admin/users/' + encodeURIComponent(st.user) + '/records');
      toast(name + ' 님의 기록 ' + r.deleted + '건을 삭제했어요.', 'ok');
      load(true);
    } catch (err) { if (token) toast(err.message, 'bad'); }
  });

  let qt = null;
  $('#q').addEventListener('input', function (e) {
    clearTimeout(qt);
    qt = setTimeout(function () { st.q = e.target.value.trim(); load(true); }, 250);
  });
  $('#mode').addEventListener('change', function (e) { st.mode = e.target.value; load(true); });
  $('#moreBtn').addEventListener('click', function () { load(false); });

  if (token) login(token); else showLogin();
})();

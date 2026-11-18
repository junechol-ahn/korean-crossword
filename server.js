/*
 * 낱말 크로스워드 서버 (외부 의존성 없음)
 *   node server.js [포트] [데이터 폴더]      기본: 8765, data/
 *
 * - 접속 IP로 사용자를 구분하고 "사용자 #NNNN" 이름을 무작위로 부여
 * - 문제(퍼즐)를 생성할 때마다 문제 ID를 부여해 저장 → /p/<ID> 로 다시 접근
 * - 진행 중인 게임 저장/이어하기, 클리어 기록(문제 ID·클리어 시간) 보관
 * 데이터는 SQLite(data/crossword.db, Node 내장 node:sqlite)에 저장된다. → db.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB = require('./js/words.js');
const Gen = require('./js/generator.js');
const Store = require('./db.js');

const PORT = +process.argv[2] || +process.env.PORT || 8765;
const ROOT = __dirname;
const DATA_DIR = process.env.CROSSWORD_DATA || (require.main === module && process.argv[3]) || path.join(ROOT, 'data');
const MODES = ['easy', 'normal', 'hard'];

/* ---------------- 저장소 ---------------- */
const store = Store.open(DATA_DIR);

/*
 * 접속 IP
 *   TRUST_PROXY 미설정 : 소켓 주소만 사용 (헤더 위조 방지)
 *   TRUST_PROXY=fly    : Fly.io 프록시가 넣어 주는 Fly-Client-IP 사용
 *   TRUST_PROXY=1      : 앞단 프록시의 X-Forwarded-For 첫 값 사용 (테스트·일반 리버스 프록시)
 */
function clientIp(req) {
  const trust = process.env.TRUST_PROXY || '';
  let ip = req.socket.remoteAddress || '';
  if (trust === 'fly' && req.headers['fly-client-ip']) ip = String(req.headers['fly-client-ip']);
  else if (trust === '1' && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0];
  ip = ip.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip || 'unknown';
}

function randomName() {
  for (let i = 0; i < 200; i++) {
    const n = '사용자 #' + String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!store.isNameUsed(n)) return n;
  }
  return '사용자 #' + crypto.randomBytes(3).toString('hex');
}

/*
 * 사용자 구분
 *  1) 쿠키(cw_uid)의 비밀 토큰으로 찾는다 → IP가 바뀌어도(휴대폰 등) 같은 사용자
 *  2) 쿠키가 없으면, 쿠키 도입 전에 같은 IP로 만들어진 사용자를 이어받는다
 *  3) 그래도 없으면 새 사용자("사용자 #NNNN")를 만든다 → 같은 와이파이의 다른 사람은 다른 사용자
 */
const COOKIE = 'cw_uid';
function parseCookies(h) {
  const out = {};
  String(h || '').split(';').forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) {
  return !!process.env.TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function getUser(req, res) {
  const ip = clientIp(req);
  let u = store.getUserByToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (!u) {
    const token = crypto.randomBytes(24).toString('base64url');
    u = store.getLegacyUserByIp(ip);
    if (u) store.setToken(u.id, token);
    else u = store.createUser({ id: crypto.randomUUID(), ip: ip, token: token, name: randomName(), createdAt: Date.now() });
    res.setHeader('Set-Cookie', COOKIE + '=' + token + '; Path=/; Max-Age=' + (60 * 60 * 24 * 730) + '; HttpOnly; SameSite=Lax' + (isHttps(req) ? '; Secure' : ''));
  }
  if (u.ip !== ip) store.touchUser(u.id, ip);
  return u;
}

function newPuzzleId() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = '';
    for (let i = 0; i < 6; i++) s += A[crypto.randomInt(0, A.length)];
    if (!store.puzzleExists(s)) return s;
  }
}

function makePuzzle(mode, user) {
  const seed = crypto.randomInt(0, 2 ** 31);
  const p = Gen.applyDifficulty(Gen.generate(DB, { target: 30, attempts: 80, seed: seed }), mode, seed);
  const rec = {
    id: newPuzzleId(), mode: mode, seed: seed, createdAt: Date.now(), createdBy: user.id,
    rows: p.rows, cols: p.cols, grid: p.grid, reveals: p.reveals, bonus: p.bonus,
    words: p.words.map(function (w) {
      return { num: w.num, word: w.word, def: w.def, hint: w.hint, hasHint: w.hasHint, dir: w.dir, r: w.r, c: w.c, len: w.len };
    })
  };
  store.savePuzzle(rec);
  return rec;
}

function progressSummary(pr) {
  if (!pr) return null;
  const pz = store.getPuzzle(pr.puzzleId);
  if (!pz) return null;
  return { puzzleId: pr.puzzleId, mode: pz.mode, savedAt: pr.savedAt, solved: pr.solved, total: pz.words.length, elapsedMs: pr.elapsedMs };
}

/* ---------------- HTTP ---------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveFile(res, rel) {
  const file = path.normalize(path.join(ROOT, rel));
  const okDir = ['css', 'js'].some(function (d) { return file.startsWith(path.join(ROOT, d) + path.sep); }) || file === path.join(ROOT, 'index.html');
  if (!okDir) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function handleApi(req, res, url) {
  const u = getUser(req, res);
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/me' && m === 'GET') {
    return send(res, 200, { user: { id: u.id, name: u.name }, progress: progressSummary(store.getProgress(u.id)), records: store.userRecords(u.id) });
  }
  if (p === '/api/me' && m === 'PUT') {
    const b = await readBody(req, 4096);
    const name = String(b.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
    if (name.length < 1 || Array.from(name).length > 20) return send(res, 400, { error: '이름은 1~20자로 입력해 주세요.' });
    store.renameUser(u.id, name);
    return send(res, 200, { user: { id: u.id, name: name } });
  }
  /* ---- 통계 ---- */
  const intParam = function (k, def, max) { const v = parseInt(url.searchParams.get(k), 10); return Math.max(0, Math.min(max, isNaN(v) ? def : v)); };
  if (p === '/api/me/records' && m === 'GET') {
    const r = store.myRecords(u.id, intParam('limit', 20, 100), intParam('offset', 0, 1e9));
    return send(res, 200, { summary: store.mySummary(u.id), records: r.rows, total: r.total });
  }
  if (p === '/api/stats/modes' && m === 'GET') {
    return send(res, 200, { modes: store.modeStats(intParam('limit', 10, 50), u.id) });
  }
  if (p === '/api/stats/puzzles' && m === 'GET') {
    const q = String(url.searchParams.get('q') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const r = store.puzzleStats({ sort: url.searchParams.get('sort'), q: q, limit: intParam('limit', 20, 100), offset: intParam('offset', 0, 1e9) }, u.id);
    return send(res, 200, r);
  }
  const pb = p.match(/^\/api\/stats\/puzzles\/([A-Z0-9]{4,12})$/);
  if (pb && m === 'GET') {
    if (!store.puzzleExists(pb[1])) return send(res, 404, { error: '문제를 찾을 수 없어요.' });
    return send(res, 200, { board: store.puzzleBoard(pb[1], intParam('limit', 10, 50), u.id) });
  }
  if (p === '/api/stats/users' && m === 'GET') {
    return send(res, 200, store.userStats({ sort: url.searchParams.get('sort'), limit: intParam('limit', 50, 200) }, u.id));
  }

  if (p === '/api/puzzles' && m === 'POST') {
    const b = await readBody(req, 4096);
    const mode = MODES.indexOf(b.mode) >= 0 ? b.mode : 'normal';
    return send(res, 200, { puzzle: makePuzzle(mode, u) });
  }
  const mm = p.match(/^\/api\/puzzles\/([A-Z0-9]{4,12})$/);
  if (mm && m === 'GET') {
    const pz = store.getPuzzle(mm[1]);
    if (!pz) return send(res, 404, { error: '문제를 찾을 수 없어요.' });
    return send(res, 200, { puzzle: pz, best: store.bestRecord(pz.id) });
  }
  if (p === '/api/progress' && m === 'GET') {
    const pr = store.getProgress(u.id);
    const pz = pr ? store.getPuzzle(pr.puzzleId) : null;
    return send(res, 200, { progress: pz ? pr : null, puzzle: pz });
  }
  if (p === '/api/progress' && m === 'POST') {
    const b = await readBody(req, 256 * 1024);
    if (!b.puzzleId || !store.puzzleExists(b.puzzleId)) return send(res, 400, { error: 'bad puzzle' });
    store.saveProgress(u.id, { puzzleId: b.puzzleId, savedAt: Date.now(), solved: +b.solved || 0, elapsedMs: +b.elapsedMs || 0, state: b.state || null });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/progress' && m === 'DELETE') {
    store.clearProgress(u.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/records' && m === 'POST') {
    const b = await readBody(req, 4096);
    const pz = store.getPuzzle(b.puzzleId);
    if (!pz) return send(res, 400, { error: 'bad puzzle' });
    const rec = store.addRecord({ userId: u.id, name: u.name, puzzleId: pz.id, mode: pz.mode, timeMs: Math.max(0, Math.round(+b.timeMs || 0)), hammersUsed: +b.hammersUsed || 0, at: Date.now() });
    return send(res, 200, { record: rec, records: store.userRecords(u.id) });
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(function (e) { send(res, 400, { error: e.message }); });
    return;
  }
  if (url.pathname === '/' || /^\/p\/[A-Za-z0-9]+\/?$/.test(url.pathname)) return serveFile(res, 'index.html');
  serveFile(res, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
});

if (require.main === module) {
  server.listen(PORT, function () { console.log('낱말 크로스워드 서버: http://localhost:' + PORT); });
}
module.exports = { server: server, store: store };
function shutdown() { server.close(); try { store.close(); } catch (e) { /* 이미 닫힘 */ } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

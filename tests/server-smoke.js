// 서버 API 스모크 테스트: node tests/server-smoke.js
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.CROSSWORD_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
process.env.TRUST_PROXY = '1';   // 테스트에서는 X-Forwarded-For 로 여러 접속 IP를 흉내 낸다
const ADMIN = 'test-admin-token-0123456789';
process.env.ADMIN_TOKEN = ADMIN;
const { server, store } = require('../server.js');

function check(name, cond, detail) {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  // 브라우저 하나 = 쿠키 저장소 하나 (기본: X-Forwarded-For 값별로 브라우저를 따로 둔다, 'none' = 쿠키 없이)
  const jars = {};
  const j = async (m, u, b, h, jarKey) => {
    h = Object.assign({}, h || {});
    const key = jarKey || h['X-Forwarded-For'] || h['Fly-Client-IP'] || 'me';
    if (jars[key] && key !== 'none') h.Cookie = jars[key];
    const r = await fetch(base + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc && key !== 'none') jars[key] = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null), setCookie: sc };
  };
  try {
    const me = await j('GET', '/api/me');
    check('새 사용자 생성 + "사용자 #NNNN" 이름', /^사용자 #\d{4}$/.test(me.body.user.name), me.body.user.name);
    const me2 = await j('GET', '/api/me');
    check('같은 브라우저(쿠키)는 같은 사용자', me2.body.user.id === me.body.user.id);
    const other = await j('GET', '/api/me', null, { 'X-Forwarded-For': '10.0.0.7' });
    check('다른 IP는 다른 사용자', other.body.user.id !== me.body.user.id, other.body.user.name);
    const ren = await j('PUT', '/api/me', { name: '단어왕' });
    check('사용자명 변경', ren.body.user.name === '단어왕' && (await j('GET', '/api/me')).body.user.name === '단어왕');
    check('빈 이름 거부', (await j('PUT', '/api/me', { name: '  ' })).status === 400);

    /* ---------- 사용자 구분 (쿠키 + IP) ---------- */
    const fresh = await j('GET', '/api/me', null, { 'X-Forwarded-For': '10.5.5.5' }, 'b1');
    check('새 사용자에게 쿠키 발급 (HttpOnly · SameSite=Lax · 2년)', /cw_uid=[\w-]{20,}/.test(fresh.setCookie) && /HttpOnly/.test(fresh.setCookie) && /SameSite=Lax/.test(fresh.setCookie) && /Max-Age=63072000/.test(fresh.setCookie));
    check('http 접속에는 Secure 를 붙이지 않음', !/Secure/.test(fresh.setCookie));
    const sameWifi = await j('GET', '/api/me', null, { 'X-Forwarded-For': '10.5.5.5' }, 'b2');
    check('같은 IP(공유 와이파이)라도 다른 브라우저는 다른 사용자', sameWifi.body.user.id !== fresh.body.user.id, fresh.body.user.name + ' / ' + sameWifi.body.user.name);
    const moved = await j('GET', '/api/me', null, { 'X-Forwarded-For': '172.16.0.9' }, 'b1');
    check('IP가 바뀌어도(휴대폰 이동) 쿠키로 같은 사용자 유지', moved.body.user.id === fresh.body.user.id && !moved.setCookie);
    const https = await j('GET', '/api/me', null, { 'X-Forwarded-For': '10.6.6.6', 'X-Forwarded-Proto': 'https' }, 'none');
    check('https 접속에는 Secure 쿠키', /Secure/.test(https.setCookie));
    check('위조된 쿠키는 무시하고 새 사용자', (await j('GET', '/api/me', null, { Cookie: 'cw_uid=forged-token-123' }, 'none')).body.user.id !== me.body.user.id);
    // 쿠키 도입 전(IP만으로 만들어진) 사용자 이어받기
    store.createUser({ id: 'legacy-1', ip: '10.9.9.9', name: '옛날사람', createdAt: 1 });
    process.env.TRUST_PROXY = '';
    const spoof = await j('GET', '/api/me', null, { 'X-Forwarded-For': '10.9.9.9' }, 'none');
    check('TRUST_PROXY 가 없으면 X-Forwarded-For 위조를 무시', spoof.body.user.name !== '옛날사람');
    process.env.TRUST_PROXY = 'fly';
    const flyIgnoresXff = await j('GET', '/api/me', null, { 'X-Forwarded-For': '10.9.9.9' }, 'none');
    check('Fly 모드에서는 X-Forwarded-For 를 믿지 않음', flyIgnoresXff.body.user.name !== '옛날사람');
    const legacy = await j('GET', '/api/me', null, { 'Fly-Client-IP': '10.9.9.9' }, 'fly1');
    check('Fly 모드: Fly-Client-IP 로 이전 IP 사용자를 이어받고 쿠키 발급', legacy.body.user.name === '옛날사람' && /cw_uid=/.test(legacy.setCookie));
    const legacy2 = await j('GET', '/api/me', null, { 'Fly-Client-IP': '10.9.9.9' }, 'fly2');
    check('이어받은 뒤에는 같은 IP의 다른 브라우저가 새 사용자', legacy2.body.user.name !== '옛날사람');
    process.env.TRUST_PROXY = '1';
    check('헬스 체크 /healthz', (await fetch(base + '/healthz')).status === 200);

    const pz = (await j('POST', '/api/puzzles', { mode: 'easy' })).body.puzzle;
    check('문제 생성 시 문제 ID 부여', /^[A-Z0-9]{6}$/.test(pz.id) && pz.words.length >= 28, pz.id + ' · ' + pz.words.length + '단어');
    const got = await j('GET', '/api/puzzles/' + pz.id);
    check('같은 ID로 같은 문제 조회', JSON.stringify(got.body.puzzle.grid) === JSON.stringify(pz.grid));
    const page = await fetch(base + '/p/' + pz.id);
    check('/p/<ID> URL이 게임 페이지를 돌려줌', page.status === 200 && (await page.text()).includes('낱말 크로스워드'));
    check('없는 ID는 404', (await j('GET', '/api/puzzles/ZZZZZZ')).status === 404);

    await j('POST', '/api/progress', { puzzleId: pz.id, solved: 4, elapsedMs: 61000, state: { v: 1, hammers: 2 } });
    const me3 = (await j('GET', '/api/me')).body;
    check('진행 중 게임 저장 → 이어하기 정보', me3.progress && me3.progress.puzzleId === pz.id && me3.progress.solved === 4);
    const pr = (await j('GET', '/api/progress')).body;
    check('이어하기 시 상태 복원 데이터 반환', pr.progress.state.hammers === 2 && pr.puzzle.id === pz.id);

    const rec = await j('POST', '/api/records', { puzzleId: pz.id, timeMs: 123456 });
    const me4 = (await j('GET', '/api/me')).body;
    check('클리어 기록(문제 ID·시간) 저장', me4.records[0].puzzleId === pz.id && me4.records[0].timeMs === 123456);
    check('클리어 후 진행 중 게임 비움', me4.progress === null);
    check('다른 사용자에게 내 기록이 보이지 않음', (await j('GET', '/api/me', null, { 'X-Forwarded-For': '10.0.0.7' })).body.records.length === 0);
    check('정적 파일 경로 탈출 차단', (await fetch(base + '/data/db.json')).status === 404 && (await fetch(base + '/server.js')).status === 404);

    /* ---------- 통계 ---------- */
    // 사용자 3명(나=127.0.0.1 '단어왕', A=10.0.0.1, B=10.0.0.2) · 문제 3개
    const A = { 'X-Forwarded-For': '10.0.0.1' }, B = { 'X-Forwarded-For': '10.0.0.2' };
    await j('PUT', '/api/me', { name: '에이' }, A);
    await j('PUT', '/api/me', { name: '비이' }, B);
    const easy2 = (await j('POST', '/api/puzzles', { mode: 'easy' })).body.puzzle;   // pz 는 이지(나: 123456)
    const hard1 = (await j('POST', '/api/puzzles', { mode: 'hard' })).body.puzzle;
    const addRec = async (h, id, t) => j('POST', '/api/records', { puzzleId: id, timeMs: t, hammersUsed: 1 }, h);
    await addRec(A, pz.id, 100000);      // A 가 pz 1등
    await addRec(B, pz.id, 150000);
    await addRec(null, easy2.id, 90000); // 나의 이지 최고 90초
    await addRec(A, easy2.id, 95000);
    await addRec(B, hard1.id, 300000);
    await addRec(B, hard1.id, 280000);   // B 같은 문제 두 번 → 최고 280초

    const ms = (await j('GET', '/api/stats/modes')).body.modes;
    check('[통계] 난이도별 순위: 사용자별 최고 기록 1위', ms.easy.top[0].name === '단어왕' && ms.easy.top[0].timeMs === 90000 && ms.easy.top[0].isMe === true,
      ms.easy.top.map((t) => t.rank + '.' + t.name + ' ' + t.timeMs).join(' / '));
    check('[통계] 난이도별 순위에 사용자 중복 없음', ms.easy.top.length === 3 && new Set(ms.easy.top.map((t) => t.name)).size === 3);
    check('[통계] 난이도별 요약(클리어 수·플레이어 수)', ms.easy.summary.clears === 5 && ms.easy.summary.players === 3 && ms.hard.summary.clears === 2 && ms.hard.summary.players === 1,
      `이지 ${ms.easy.summary.clears}회/${ms.easy.summary.players}명 · 하드 ${ms.hard.summary.clears}회/${ms.hard.summary.players}명`);
    check('[통계] 하드 최고 기록은 같은 사용자의 더 빠른 기록', ms.hard.top[0].name === '비이' && ms.hard.top[0].timeMs === 280000 && ms.hard.top[0].clears === 2);
    check('[통계] 기록 없는 난이도는 비어 있음', ms.normal.top.length === 0 && ms.normal.summary.clears === 0);

    const ps = (await j('GET', '/api/stats/puzzles?sort=clears')).body;
    const row = ps.rows.find((r) => r.puzzleId === pz.id);
    check('[통계] 게임별 최고 기록·보유자·클리어 수', row && row.bestMs === 100000 && row.bestName === '에이' && row.clears === 3 && row.players === 3 && row.myBestMs === 123456,
      row && `${row.puzzleId} 최고 ${row.bestMs} (${row.bestName}) · ${row.clears}회 · 내 기록 ${row.myBestMs}`);
    check('[통계] 게임별 목록: 기록 있는 문제만 + 클리어 많은 순', ps.total === 3 && ps.rows[0].puzzleId === pz.id);
    const q1 = (await j('GET', '/api/stats/puzzles?q=' + hard1.id.slice(0, 4).toLowerCase())).body;
    check('[통계] 게임별 문제 ID 검색', q1.rows.some((r) => r.puzzleId === hard1.id));
    const board = (await j('GET', '/api/stats/puzzles/' + pz.id)).body.board;
    check('[통계] 한 문제의 순위표', board.map((b) => b.name).join(',') === '에이,단어왕,비이' && board[1].isMe === true);

    const us = (await j('GET', '/api/stats/users')).body;
    const meRow = us.rows.find((r) => r.isMe);
    check('[통계] 사용자별 최고 기록 (난이도별 최고·클리어 수)', us.total === 3 && meRow.name === '단어왕' && meRow.bestEasy === 90000 && meRow.clears === 2 && meRow.bestHard === null,
      us.rows.map((r) => `${r.rank}.${r.name} ${r.clears}회`).join(' / '));
    const usHard = (await j('GET', '/api/stats/users?sort=hard')).body;
    check('[통계] 사용자별 정렬 (하드 최고 기록 순)', usHard.rows[0].name === '비이');
    check('[통계] 응답에 IP·내부 사용자 ID가 없음', !JSON.stringify([ms, ps, board, us]).match(/10\.0\.0\.|127\.0\.0\.1|"uid"|"userId"/));

    const mine = (await j('GET', '/api/me/records?limit=1')).body;
    check('[내 기록] 페이지 단위 조회 + 전체 개수', mine.total === 2 && mine.records.length === 1 && mine.records[0].puzzleId === easy2.id);
    check('[내 기록] 그 문제에서의 순위', mine.records[0].puzzleRank === 1);
    const sm = mine.summary;
    const se = sm.byMode.find((x) => x.mode === 'easy');
    check('[내 기록] 요약 (총 클리어·난이도별 최고·평균·순위)', sm.total.clears === 2 && sm.total.puzzles === 2 && se.bestMs === 90000 && se.avgMs === 106728 && se.rank === 1 && se.players === 3,
      JSON.stringify(se));
    // 이름을 바꾸면 순위표에도 새 이름
    await j('PUT', '/api/me', { name: '단어여왕' });
    check('[통계] 이름 변경이 순위표에 반영', (await j('GET', '/api/stats/modes')).body.modes.easy.top[0].name === '단어여왕');

    /* ---------- 관리자 ---------- */
    const adm = (m, u, ip, tok) => j(m, u, null, { 'X-Forwarded-For': ip || '10.8.0.1', Authorization: 'Bearer ' + (tok === undefined ? ADMIN : tok) }, 'none');
    const usersBefore = store.counts().users;
    const page2 = await fetch(base + '/admin');
    check('[관리자] /admin 페이지 제공', page2.status === 200 && (await page2.text()).includes('관리자 로그인'));
    check('[관리자] 토큰 없으면 401', (await j('GET', '/api/admin/records', null, { 'X-Forwarded-For': '10.8.0.2' }, 'none')).status === 401);
    check('[관리자] 틀린 토큰은 401', (await adm('GET', '/api/admin/session', '10.8.0.2', 'wrong-token-wrong-token')).status === 401);
    const sess = await adm('GET', '/api/admin/session');
    check('[관리자] 올바른 토큰으로 인증 + 쿠키·사용자를 만들지 않음', sess.status === 200 && !sess.setCookie && store.counts().users === usersBefore);
    const all = (await adm('GET', '/api/admin/records')).body;
    check('[관리자] 전체 기록 조회 (최근순, 기록 ID·사용자 포함)', all.total === 7 && all.records[0].id > all.records[1].id && all.records.every((r) => r.id && r.userId && r.userName),
      `${all.total}건`);
    const byPz = (await adm('GET', '/api/admin/records?q=' + pz.id.toLowerCase())).body;
    check('[관리자] 문제 ID로 검색 (대소문자 무관)', byPz.total === 3 && byPz.records.every((r) => r.puzzleId === pz.id));
    const byName = (await adm('GET', '/api/admin/records?q=' + encodeURIComponent('비이'))).body;
    check('[관리자] 사용자 이름으로 검색', byName.total === 3 && byName.records.every((r) => r.userName === '비이'));
    const byOld = (await adm('GET', '/api/admin/records?q=' + encodeURIComponent('단어왕'))).body;
    check('[관리자] 클리어 당시 이름으로도 검색 (현재 이름도 함께)', byOld.total === 2 && byOld.records.every((r) => r.userName === '단어여왕' && r.nameAtClear === '단어왕'));
    check('[관리자] 검색어의 % 는 와일드카드가 아님', (await adm('GET', '/api/admin/records?q=%25')).body.total === 0);
    check('[관리자] 난이도 필터', (await adm('GET', '/api/admin/records?mode=hard')).body.total === 2);

    // A(에이)의 pz 1등 기록(100초) 삭제 → 순위표에 바로 반영
    const aRec = byPz.records.find((r) => r.userName === '에이');
    const del = await adm('DELETE', '/api/admin/records/' + aRec.id);
    check('[관리자] 기록 한 건 삭제', del.status === 200 && del.body.deleted === 1);
    const board2 = (await j('GET', '/api/stats/puzzles/' + pz.id)).body.board;
    check('[관리자] 삭제가 문제 순위표에 바로 반영', board2.map((b) => b.name).join(',') === '단어여왕,비이', board2.map((b) => b.name).join(','));
    check('[관리자] 없는 기록 삭제는 404', (await adm('DELETE', '/api/admin/records/' + aRec.id)).status === 404);

    const bId = byName.records[0].userId;
    const bOnly = (await adm('GET', '/api/admin/records?user=' + bId)).body;
    check('[관리자] 사용자 한 명의 기록만 보기', bOnly.total === 3 && bOnly.user.name === '비이');
    const delAll = await adm('DELETE', '/api/admin/users/' + bId + '/records');
    check('[관리자] 사용자 기록 모두 삭제', delAll.body.deleted === 3 && (await adm('GET', '/api/admin/records?user=' + bId)).body.total === 0);
    check('[관리자] 다른 사용자 기록은 그대로', (await adm('GET', '/api/admin/records')).body.total === 3);
    check('[관리자] 없는 사용자는 404', (await adm('DELETE', '/api/admin/users/no-such-user/records')).status === 404);
    check('[관리자] 일반 API로는 관리자 기능에 접근 불가 (쿠키만으로는 401)', (await j('DELETE', '/api/admin/records/1')).status === 401);

    // 인증 실패 제한: 같은 IP에서 10번 틀리면 올바른 토큰도 429
    for (let i = 0; i < 10; i++) await adm('GET', '/api/admin/session', '10.8.9.9', 'bad-token-' + i);
    check('[관리자] 인증 실패 10번 뒤 차단 (429)', (await adm('GET', '/api/admin/session', '10.8.9.9')).status === 429);
    check('[관리자] 차단은 그 IP에만 적용', (await adm('GET', '/api/admin/session', '10.8.9.10')).status === 200);

    const saved = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'short';
    check('[관리자] ADMIN_TOKEN 이 16자 미만이면 기능 꺼짐 (404)', (await adm('GET', '/api/admin/session', null, 'short')).status === 404);
    delete process.env.ADMIN_TOKEN;
    check('[관리자] ADMIN_TOKEN 이 없으면 기능 꺼짐 (404)', (await adm('GET', '/api/admin/session')).status === 404);
    process.env.ADMIN_TOKEN = saved;
  } catch (e) {
    console.error(e); process.exitCode = 1;
  }
  server.close();
});

// 배포 이미지: 서버가 내주는 최상위 HTML 페이지가 모두 Dockerfile 에서 복사되는지
{
  const root = path.join(__dirname, '..');
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const copied = docker.split('\n').filter((l) => /^COPY\s/.test(l)).flatMap((l) => l.trim().split(/\s+/).slice(1, -1));
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const missing = pages.filter((f) => copied.indexOf(f) < 0);
  check('Dockerfile 이 모든 HTML 페이지를 이미지에 복사', pages.length >= 2 && missing.length === 0, missing.length ? '빠짐: ' + missing.join(', ') : pages.join(', '));
}

// db.json → SQLite 이전 테스트
{
  const Store = require('../db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mig-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: { '1.2.3.4': { id: 'u1', ip: '1.2.3.4', name: '옛사용자', createdAt: 1, progress: { puzzleId: 'OLD001', savedAt: 2, solved: 3, elapsedMs: 4000, state: { v: 1, hammers: 1 } } } },
    puzzles: { OLD001: { id: 'OLD001', mode: 'hard', seed: 7, createdAt: 1, createdBy: 'u1', rows: 1, cols: 3, grid: [['가', '나', '다']], reveals: [], bonus: null, words: [{ num: 1, word: '가나다', dir: 'across', r: 0, c: 0, len: 3 }] } },
    records: [{ userId: 'u1', name: '옛사용자', puzzleId: 'OLD001', mode: 'hard', timeMs: 9999, hammersUsed: 2, at: 5 }]
  }));
  const s = Store.open(dir);
  const c = s.counts();
  check('이전 db.json 데이터를 SQLite로 옮김', c.users === 1 && c.puzzles === 1 && c.progress === 1 && c.records === 1, JSON.stringify(c));
  check('옮긴 진행 상태·기록 내용이 같음', s.getProgress('u1').state.hammers === 1 && s.userRecords('u1')[0].timeMs === 9999 && s.getPuzzle('OLD001').grid[0][2] === '다');
  check('원본은 db.json.migrated 로 보관', fs.existsSync(path.join(dir, 'db.json.migrated')) && !fs.existsSync(path.join(dir, 'db.json')));
  s.close();
  const s2 = Store.open(dir);
  check('다시 열어도 데이터 유지(중복 이전 없음)', JSON.stringify(s2.counts()) === JSON.stringify(c));
  s2.close();
}

// 스키마 v1(ip UNIQUE) → v2(token) 이전 테스트: 기록·진행 상태가 지워지지 않아야 함
{
  const { DatabaseSync } = require('node:sqlite');
  const Store = require('../db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-v1-'));
  const old = new DatabaseSync(path.join(dir, 'crossword.db'));
  old.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, ip TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE puzzles (id TEXT PRIMARY KEY, mode TEXT NOT NULL, seed INTEGER, created_at INTEGER NOT NULL, created_by TEXT REFERENCES users(id) ON DELETE SET NULL, data TEXT NOT NULL);
    CREATE TABLE progress (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE, saved_at INTEGER NOT NULL, solved INTEGER NOT NULL DEFAULT 0, elapsed_ms INTEGER NOT NULL DEFAULT 0, state TEXT);
    CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE, mode TEXT NOT NULL, time_ms INTEGER NOT NULL, hammers_used INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
    INSERT INTO users VALUES ('u1', '127.0.0.1', '사용자 #2162', 1);
    INSERT INTO puzzles VALUES ('P1', 'easy', 1, 1, 'u1', '{"rows":1,"cols":3,"grid":[["가","나","다"]],"reveals":[],"bonus":null,"words":[]}');
    INSERT INTO progress VALUES ('u1', 'P1', 2, 1, 3000, '{"v":1}');
    INSERT INTO records (user_id, name, puzzle_id, mode, time_ms, hammers_used, at) VALUES ('u1', '사용자 #2162', 'P1', 'easy', 5000, 0, 3);
    PRAGMA user_version = 1;`);
  old.close();
  const s2 = Store.open(dir);
  const c = s2.counts();
  const cols = s2.raw.prepare('PRAGMA table_info(users)').all().map((x) => x.name);
  check('스키마 v1→v2 이전: 사용자·문제·진행·기록 모두 보존', c.users === 1 && c.puzzles === 1 && c.progress === 1 && c.records === 1, JSON.stringify(c));
  let multiOk = true;
  try { s2.createUser({ id: 'u2', ip: '127.0.0.1', token: 't2', name: 'x', createdAt: 1 }); } catch (e) { multiOk = false; }
  check('스키마 v2: token 열 추가 + 같은 IP에 여러 사용자 허용', cols.indexOf('token') >= 0 && multiOk);
  check('스키마 v2: 이전 사용자를 IP로 이어받을 수 있음', s2.getLegacyUserByIp('127.0.0.1').id === 'u1');
  check('스키마 버전 2', s2.raw.prepare('PRAGMA user_version').get().user_version === 2);
  s2.close();
}

/*
 * SQLite 저장소 (Node 내장 node:sqlite 사용, 외부 패키지 없음)
 * 파일: data/crossword.db  (환경 변수 CROSSWORD_DATA 로 폴더 변경 가능)
 *
 * 테이블
 *   users     사용자 (접속 IP 당 1명)
 *   puzzles   생성된 문제 (문제 ID → 격자·단어·힌트 JSON)
 *   progress  사용자별 진행 중인 게임 1개
 *   records   클리어 기록 (문제 ID · 클리어 시간)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// node:sqlite 의 "실험적 기능" 경고만 숨긴다 (다른 경고는 그대로 표시)
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite is an experimental feature/.test(msg)) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = origEmit;

const SCHEMA_VERSION = 2;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'crossword.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      ip          TEXT,                       -- 마지막 접속 IP (같은 IP에 여러 사용자 가능)
      token       TEXT UNIQUE,                -- 브라우저 쿠키에 저장되는 비밀 토큰
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER
    );
    CREATE TABLE IF NOT EXISTS puzzles (
      id          TEXT PRIMARY KEY,
      mode        TEXT NOT NULL,
      seed        INTEGER,
      created_at  INTEGER NOT NULL,
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      data        TEXT NOT NULL               -- rows, cols, grid, reveals, bonus, words (JSON)
    );
    CREATE TABLE IF NOT EXISTS progress (
      user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      puzzle_id   TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
      saved_at    INTEGER NOT NULL,
      solved      INTEGER NOT NULL DEFAULT 0,
      elapsed_ms  INTEGER NOT NULL DEFAULT 0,
      state       TEXT                        -- 칸 값·망치·타임 어택 상태 등 (JSON)
    );
    CREATE TABLE IF NOT EXISTS records (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,            -- 클리어 당시 이름
      puzzle_id     TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
      mode          TEXT NOT NULL,
      time_ms       INTEGER NOT NULL,
      hammers_used  INTEGER NOT NULL DEFAULT 0,
      at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_records_user   ON records(user_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_records_puzzle ON records(puzzle_id, time_ms);
    CREATE INDEX IF NOT EXISTS idx_records_mode   ON records(mode, time_ms);
  `);
  migrateUsersV2(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_ip ON users(ip)');
  db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);

  const q = {
    userByIp: db.prepare('SELECT id, ip, name, created_at AS createdAt FROM users WHERE ip = ? ORDER BY created_at LIMIT 1'),
    // 쿠키가 도입되기 전에 IP로만 만들어진 사용자 (토큰 없음)
    legacyUserByIp: db.prepare('SELECT id, ip, name, created_at AS createdAt FROM users WHERE ip = ? AND token IS NULL ORDER BY created_at LIMIT 1'),
    userByToken: db.prepare('SELECT id, ip, name, created_at AS createdAt FROM users WHERE token = ?'),
    setToken: db.prepare('UPDATE users SET token = ? WHERE id = ?'),
    touchUser: db.prepare('UPDATE users SET ip = ?, last_seen = ? WHERE id = ?'),
    nameUsed: db.prepare('SELECT 1 FROM users WHERE name = ?'),
    insertUser: db.prepare('INSERT INTO users (id, ip, token, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'),
    renameUser: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    puzzleExists: db.prepare('SELECT 1 FROM puzzles WHERE id = ?'),
    insertPuzzle: db.prepare('INSERT INTO puzzles (id, mode, seed, created_at, created_by, data) VALUES (?, ?, ?, ?, ?, ?)'),
    getPuzzle: db.prepare('SELECT id, mode, seed, created_at, created_by, data FROM puzzles WHERE id = ?'),
    getProgress: db.prepare('SELECT puzzle_id, saved_at, solved, elapsed_ms, state FROM progress WHERE user_id = ?'),
    upsertProgress: db.prepare(`INSERT INTO progress (user_id, puzzle_id, saved_at, solved, elapsed_ms, state) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET puzzle_id = excluded.puzzle_id, saved_at = excluded.saved_at,
        solved = excluded.solved, elapsed_ms = excluded.elapsed_ms, state = excluded.state`),
    deleteProgress: db.prepare('DELETE FROM progress WHERE user_id = ?'),
    deleteProgressFor: db.prepare('DELETE FROM progress WHERE user_id = ? AND puzzle_id = ?'),
    insertRecord: db.prepare('INSERT INTO records (user_id, name, puzzle_id, mode, time_ms, hammers_used, at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    userRecords: db.prepare(`SELECT user_id AS userId, name, puzzle_id AS puzzleId, mode, time_ms AS timeMs, hammers_used AS hammersUsed, at
      FROM records WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?`),
    bestRecord: db.prepare('SELECT name, time_ms AS timeMs FROM records WHERE puzzle_id = ? ORDER BY time_ms ASC LIMIT 1')
  };

  function rowToPuzzle(row) {
    if (!row) return null;
    return Object.assign({ id: row.id, mode: row.mode, seed: row.seed, createdAt: row.created_at, createdBy: row.created_by }, JSON.parse(row.data));
  }
  function rowToProgress(row) {
    if (!row) return null;
    return { puzzleId: row.puzzle_id, savedAt: row.saved_at, solved: row.solved, elapsedMs: row.elapsed_ms, state: row.state ? JSON.parse(row.state) : null };
  }
  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const api = {
    file: file,
    raw: db,
    getUserByIp: function (ip) { return q.userByIp.get(ip) || null; },
    isNameUsed: function (name) { return !!q.nameUsed.get(name); },
    createUser: function (u) { q.insertUser.run(u.id, u.ip || null, u.token || null, u.name, u.createdAt, u.createdAt); return u; },
    getUserByToken: function (t) { return t ? (q.userByToken.get(t) || null) : null; },
    getLegacyUserByIp: function (ip) { return q.legacyUserByIp.get(ip) || null; },
    setToken: function (id, token) { q.setToken.run(token, id); },
    touchUser: function (id, ip) { q.touchUser.run(ip, Date.now(), id); },
    renameUser: function (id, name) { q.renameUser.run(name, id); },
    puzzleExists: function (id) { return !!q.puzzleExists.get(id); },
    savePuzzle: function (p) {
      const data = { rows: p.rows, cols: p.cols, grid: p.grid, reveals: p.reveals, bonus: p.bonus, words: p.words };
      q.insertPuzzle.run(p.id, p.mode, p.seed == null ? null : p.seed, p.createdAt, p.createdBy || null, JSON.stringify(data));
    },
    getPuzzle: function (id) { return rowToPuzzle(q.getPuzzle.get(id)); },
    getProgress: function (userId) { return rowToProgress(q.getProgress.get(userId)); },
    saveProgress: function (userId, pr) {
      q.upsertProgress.run(userId, pr.puzzleId, pr.savedAt, pr.solved | 0, Math.round(pr.elapsedMs) || 0, pr.state == null ? null : JSON.stringify(pr.state));
    },
    clearProgress: function (userId) { q.deleteProgress.run(userId); },
    // 기록 저장 + 같은 문제의 진행 중 게임 삭제를 한 트랜잭션으로
    addRecord: function (r) {
      return tx(function () {
        q.insertRecord.run(r.userId, r.name, r.puzzleId, r.mode, r.timeMs, r.hammersUsed | 0, r.at);
        q.deleteProgressFor.run(r.userId, r.puzzleId);
        return r;
      });
    },
    userRecords: function (userId, limit) { return q.userRecords.all(userId, limit || 50); },
    bestRecord: function (puzzleId) { return q.bestRecord.get(puzzleId) || null; },
    /* ---------- 통계 ---------- */
    // 내 기록 (페이지 단위). puzzleRank = 그 문제에서 이 기록이 몇 위 수준인지 (사용자별 최고 기록 기준)
    myRecords: function (userId, limit, offset) {
      const rows = db.prepare(`SELECT puzzle_id AS puzzleId, mode, time_ms AS timeMs, hammers_used AS hammersUsed, at,
          (SELECT COUNT(*) + 1 FROM (SELECT MIN(time_ms) AS b FROM records r2 WHERE r2.puzzle_id = r.puzzle_id GROUP BY r2.user_id) WHERE b < r.time_ms) AS puzzleRank
        FROM records r WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(userId, limit, offset);
      const total = db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?').get(userId).n;
      return { rows: rows, total: total };
    },
    // 내 요약: 전체 + 난이도별 (클리어 수, 최고, 평균, 순위)
    mySummary: function (userId) {
      const byMode = db.prepare(`SELECT mode, COUNT(*) AS clears, MIN(time_ms) AS bestMs, CAST(AVG(time_ms) AS INTEGER) AS avgMs,
          SUM(hammers_used) AS hammers FROM records WHERE user_id = ? GROUP BY mode`).all(userId);
      const tot = db.prepare(`SELECT COUNT(*) AS clears, COUNT(DISTINCT puzzle_id) AS puzzles, COALESCE(SUM(time_ms), 0) AS totalMs,
          MIN(at) AS firstAt, MAX(at) AS lastAt FROM records WHERE user_id = ?`).get(userId);
      byMode.forEach(function (m) {
        m.rank = db.prepare('SELECT COUNT(*) + 1 AS rank FROM (SELECT MIN(time_ms) AS b FROM records WHERE mode = ? GROUP BY user_id) WHERE b < ?').get(m.mode, m.bestMs).rank;
        m.players = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM records WHERE mode = ?').get(m.mode).n;
      });
      return { total: tot, byMode: byMode };
    },
    // 난이도별: 요약 + 사용자별 최고 기록 순위
    modeStats: function (limit, meId) {
      const out = {};
      ['easy', 'normal', 'hard'].forEach(function (mode) {
        const sum = db.prepare(`SELECT COUNT(*) AS clears, COUNT(DISTINCT user_id) AS players, COUNT(DISTINCT puzzle_id) AS puzzles,
            MIN(time_ms) AS bestMs, CAST(AVG(time_ms) AS INTEGER) AS avgMs FROM records WHERE mode = ?`).get(mode);
        const top = db.prepare(`SELECT u.id AS uid, u.name AS name, MIN(r.time_ms) AS timeMs, COUNT(*) AS clears,
            (SELECT r2.puzzle_id FROM records r2 WHERE r2.user_id = u.id AND r2.mode = ? ORDER BY r2.time_ms, r2.at LIMIT 1) AS puzzleId
          FROM records r JOIN users u ON u.id = r.user_id WHERE r.mode = ? GROUP BY u.id ORDER BY timeMs ASC, MIN(r.at) ASC LIMIT ?`).all(mode, mode, limit);
        out[mode] = {
          summary: sum,
          top: top.map(function (t, i) { return { rank: i + 1, name: t.name, timeMs: t.timeMs, clears: t.clears, puzzleId: t.puzzleId, isMe: t.uid === meId }; })
        };
      });
      return out;
    },
    // 게임(문제)별 최고 기록
    puzzleStats: function (opts, meId) {
      const sort = { recent: 'lastAt DESC', clears: 'clears DESC, lastAt DESC', best: 'bestMs ASC' }[opts.sort] || 'lastAt DESC';
      const where = opts.q ? 'WHERE p.id LIKE ?' : '';
      const args = opts.q ? ['%' + opts.q + '%'] : [];
      const rows = db.prepare(`SELECT p.id AS puzzleId, p.mode AS mode, p.created_at AS createdAt, COUNT(r.id) AS clears,
          COUNT(DISTINCT r.user_id) AS players, MIN(r.time_ms) AS bestMs, MAX(r.at) AS lastAt,
          (SELECT u.name FROM records r2 JOIN users u ON u.id = r2.user_id WHERE r2.puzzle_id = p.id ORDER BY r2.time_ms, r2.at LIMIT 1) AS bestName,
          (SELECT r2.user_id FROM records r2 WHERE r2.puzzle_id = p.id ORDER BY r2.time_ms, r2.at LIMIT 1) AS bestUid,
          (SELECT MIN(r3.time_ms) FROM records r3 WHERE r3.puzzle_id = p.id AND r3.user_id = ?) AS myBestMs
        FROM puzzles p JOIN records r ON r.puzzle_id = p.id ${where} GROUP BY p.id ORDER BY ${sort} LIMIT ? OFFSET ?`)
        .all(...[meId].concat(args, [opts.limit, opts.offset]));
      const total = db.prepare(`SELECT COUNT(DISTINCT p.id) AS n FROM puzzles p JOIN records r ON r.puzzle_id = p.id ${where}`).get(...args).n;
      return {
        total: total,
        rows: rows.map(function (x) {
          return { puzzleId: x.puzzleId, mode: x.mode, createdAt: x.createdAt, clears: x.clears, players: x.players, bestMs: x.bestMs,
            bestName: x.bestName, bestIsMe: x.bestUid === meId, myBestMs: x.myBestMs, lastAt: x.lastAt };
        })
      };
    },
    // 한 문제의 순위표 (사용자별 최고 기록)
    puzzleBoard: function (puzzleId, limit, meId) {
      return db.prepare(`SELECT u.id AS uid, u.name AS name, MIN(r.time_ms) AS timeMs, COUNT(*) AS clears, r.hammers_used AS hammers /* SQLite: MIN() 과 함께 쓴 열은 최소값 행의 값 */
        FROM records r JOIN users u ON u.id = r.user_id WHERE r.puzzle_id = ? GROUP BY u.id ORDER BY timeMs ASC LIMIT ?`).all(puzzleId, limit)
        .map(function (t, i) { return { rank: i + 1, name: t.name, timeMs: t.timeMs, clears: t.clears, hammers: t.hammers, isMe: t.uid === meId }; });
    },
    // 사용자별 최고 기록
    userStats: function (opts, meId) {
      const sort = {
        clears: 'clears DESC, lastAt DESC', recent: 'lastAt DESC',
        easy: 'bestEasy IS NULL, bestEasy', normal: 'bestNormal IS NULL, bestNormal', hard: 'bestHard IS NULL, bestHard'
      }[opts.sort] || 'clears DESC, lastAt DESC';
      const rows = db.prepare(`SELECT u.id AS uid, u.name AS name, COUNT(r.id) AS clears, COUNT(DISTINCT r.puzzle_id) AS puzzles,
          MIN(CASE WHEN r.mode = 'easy' THEN r.time_ms END) AS bestEasy,
          MIN(CASE WHEN r.mode = 'normal' THEN r.time_ms END) AS bestNormal,
          MIN(CASE WHEN r.mode = 'hard' THEN r.time_ms END) AS bestHard,
          SUM(r.hammers_used) AS hammers, MAX(r.at) AS lastAt
        FROM users u JOIN records r ON r.user_id = u.id GROUP BY u.id ORDER BY ${sort} LIMIT ?`).all(opts.limit);
      const total = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM records').get().n;
      return {
        total: total,
        rows: rows.map(function (x, i) {
          return { rank: i + 1, name: x.name, clears: x.clears, puzzles: x.puzzles, bestEasy: x.bestEasy, bestNormal: x.bestNormal,
            bestHard: x.bestHard, hammers: x.hammers, lastAt: x.lastAt, isMe: x.uid === meId };
        })
      };
    },
    counts: function () {
      const c = function (t) { return db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; };
      return { users: c('users'), puzzles: c('puzzles'), progress: c('progress'), records: c('records') };
    },
    close: function () { db.close(); }
  };

  migrateFromJson(api, dataDir, tx);
  return api;
}

/*
 * 스키마 v1 → v2: users 테이블에서 ip UNIQUE 제약을 없애고 token·last_seen 열을 추가한다.
 * SQLite 는 제약을 직접 지울 수 없어 테이블을 다시 만든다. 이때 외래 키를 잠시 꺼서
 * 기록·진행 상태가 CASCADE 로 지워지지 않게 한다.
 */
function migrateUsersV2(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(function (c) { return c.name; });
  if (cols.indexOf('token') >= 0) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE users_v2 (
        id TEXT PRIMARY KEY, ip TEXT, token TEXT UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER
      );
      INSERT INTO users_v2 (id, ip, token, name, created_at, last_seen) SELECT id, ip, NULL, name, created_at, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;
    `);
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error('외래 키 검사 실패: ' + JSON.stringify(bad.slice(0, 3)));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/*
 * 이전 버전의 data/db.json 이 있으면 한 번만 SQLite 로 옮기고
 * 원본은 db.json.migrated 로 이름을 바꿔 보관한다.
 */
function migrateFromJson(api, dataDir, tx) {
  const json = path.join(dataDir, 'db.json');
  if (!fs.existsSync(json)) return;
  let old;
  try { old = JSON.parse(fs.readFileSync(json, 'utf8')); } catch (e) { console.warn('db.json 을 읽지 못해 이전을 건너뜁니다:', e.message); return; }
  const users = Object.values(old.users || {});
  const puzzles = Object.values(old.puzzles || {});
  const records = old.records || [];
  tx(function () {
    users.forEach(function (u) {
      if (api.getUserByIp(u.ip)) return;
      api.createUser({ id: u.id, ip: u.ip, name: u.name, createdAt: u.createdAt || Date.now() });
    });
    const userIds = new Set(users.map(function (u) { return u.id; }));
    puzzles.forEach(function (p) {
      if (api.puzzleExists(p.id)) return;
      api.savePuzzle(Object.assign({}, p, { createdBy: userIds.has(p.createdBy) ? p.createdBy : null }));
    });
    users.forEach(function (u) {
      if (u.progress && api.puzzleExists(u.progress.puzzleId)) api.saveProgress(u.id, u.progress);
    });
    records.forEach(function (r) {
      if (!userIds.has(r.userId) || !api.puzzleExists(r.puzzleId)) return;
      api.raw.prepare('INSERT INTO records (user_id, name, puzzle_id, mode, time_ms, hammers_used, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(r.userId, r.name, r.puzzleId, r.mode, r.timeMs | 0, r.hammersUsed | 0, r.at || Date.now());
    });
  });
  fs.renameSync(json, json + '.migrated');
  console.log('db.json → SQLite 이전 완료: 사용자 ' + users.length + ', 문제 ' + puzzles.length + ', 기록 ' + records.length);
}

module.exports = { open: open };

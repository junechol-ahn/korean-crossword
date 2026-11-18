// 통계 화면 확인용 데모 데이터 생성: node tests/seed-demo.js <데이터 폴더>
// (실제 data/ 폴더가 아닌 별도 폴더를 지정해서 사용)
const path = require('path');
const fs = require('fs');
const Store = require('../db.js');
const DB = require('../js/words.js');
const Gen = require('../js/generator.js');

const dir = process.argv[2];
if (!dir || path.resolve(dir) === path.resolve(__dirname, '..', 'data')) {
  console.error('데모용 폴더를 지정하세요 (실제 data 폴더는 사용할 수 없음)');
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
const s = Store.open(dir);
const names = ['낱말탐정', '한글사랑', '퍼즐왕', '새벽독서', '가나다라', '단어수집가', '초성천재'];
const users = [{ id: 'me', ip: '127.0.0.1', name: '나(데모)' }].concat(names.map((n, i) => ({ id: 'u' + i, ip: '10.1.0.' + i, name: n })));
users.forEach((u) => s.createUser({ id: u.id, ip: u.ip, name: u.name, createdAt: Date.now() - 864e5 * 10 }));

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const modes = ['easy', 'normal', 'hard'];
const puzzles = [];
for (let i = 0; i < 9; i++) {
  const mode = modes[i % 3];
  const p = Gen.applyDifficulty(Gen.generate(DB, { seed: 100 + i }), mode, 100 + i);
  const id = 'DEMO' + String.fromCharCode(65 + i) + (i + 2);
  s.savePuzzle({ id, mode, seed: 100 + i, createdAt: Date.now() - 864e5 * (9 - i), createdBy: 'me', rows: p.rows, cols: p.cols, grid: p.grid, reveals: p.reveals, bonus: p.bonus,
    words: p.words.map((w) => ({ num: w.num, word: w.word, def: w.def, hint: w.hint, hasHint: w.hasHint, dir: w.dir, r: w.r, c: w.c, len: w.len })) });
  puzzles.push({ id, mode });
}
const base = { easy: 240e3, normal: 420e3, hard: 780e3 };
let n = 0;
users.forEach((u, ui) => {
  puzzles.forEach((pz, pi) => {
    if (rnd() < 0.35) return;
    const times = rnd() < 0.2 ? 2 : 1;
    for (let k = 0; k < times; k++) {
      const t = Math.round(base[pz.mode] * (0.55 + rnd() * 0.9) * (1 + ui * 0.04));
      s.addRecord({ userId: u.id, name: u.name, puzzleId: pz.id, mode: pz.mode, timeMs: t, hammersUsed: Math.floor(rnd() * 4), at: Date.now() - 864e5 * (8 - pi) + ui * 6e5 + k * 3e6 });
      n++;
    }
  });
});
console.log('데모 데이터: 사용자 ' + users.length + ', 문제 ' + puzzles.length + ', 기록 ' + n + ' → ' + s.file);
s.close();

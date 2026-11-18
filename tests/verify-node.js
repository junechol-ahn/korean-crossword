// 사용법: node tests/verify-node.js [퍼즐 수]
const DB = require('../js/words.js');
const Gen = require('../js/generator.js');
const V = require('../js/verify.js');

const N = +process.argv[2] || 200;
let fail = 0;
const tally = {};
for (const mode of ['easy', 'normal', 'hard']) {
  for (let i = 0; i < N; i++) {
    const seed = i * 104729 + mode.length;
    const p = Gen.applyDifficulty(Gen.generate(DB, { target: 30, attempts: 80, seed }), mode, seed);
    for (const it of [...V.verifyLayout(p, DB), ...V.verifyDifficulty(p)]) {
      const k = it.name;
      tally[k] = tally[k] || { pass: 0, fail: 0, ex: [] };
      if (it.pass) tally[k].pass++;
      else { tally[k].fail++; fail++; if (tally[k].ex.length < 3) tally[k].ex.push(`${mode} seed=${seed}: ${it.detail}`); }
    }
  }
}
console.log(`단어 DB: ${DB.length}개 / 모드별 퍼즐 ${N}개 생성 검증\n`);
for (const [k, v] of Object.entries(tally)) {
  console.log(`${v.fail ? '❌' : '✅'} ${k}  (${v.pass}/${v.pass + v.fail})`);
  v.ex.forEach((e) => console.log('     ' + e));
}
// 한글 조합기: 사전의 모든 단어를 두벌식 키 입력으로 쳤을 때 한 칸씩 정확히 들어가는가
const H = require('../js/hangul.js');
const badIme = DB.filter((w) => H.simulate(w.word, [...w.word].length).join('') !== w.word);
console.log(`${badIme.length ? '❌' : '✅'} 한글 키 입력 시 덮어쓰기 없이 한 칸씩 입력  (${DB.length - badIme.length}/${DB.length})`);
fail += badIme.length;

console.log(fail ? `\n실패 ${fail}건` : '\n모든 항목 통과');
process.exit(fail ? 1 : 0);

/* 등록표 밖에 박힌 값 금지.
 *
 * 막는 사고
 *   1) 데이터 파일명을 storage 밖에서 직접 쓴다 → 파일 IO 관문이 둘이 되고,
 *      TODO_DATA_DIR 주입을 우회해 테스트가 실사용 %APPDATA%\TodoPopup\todos.json 을 덮어쓴다.
 *   2) 팔레트를 창에 복사해 둔다 → registry 에서 색을 바꿔도 사이드바·스와치만 옛날 색을 칠하고,
 *      캘린더 색이 목록과 캘린더에서 서로 다르게 보인다.
 *   3) 스누즈 분 배열을 팝업에 박아 둔다 → SNOOZE_PRESETS 에 항목을 더해도 메뉴가 그대로라,
 *      "등록했는데 안 보인다"를 코드에서 찾아 헤매게 된다.
 *
 * "문자열을 쓰지 말라"가 아니라 "그 값이 등록표에서 나와야 한다"는 뜻이다.
 */

import {
  APP_DIR, ROOT_DIR, collect, read, rel, lineOf,
  stripCommentsAndStrings, scriptsOfHtml, diffBothWays, report, loadRegistry
} from './_load.mjs';
import { join } from 'node:path';

const REG = await loadRegistry();

// ───────────────────────── 검사 대상 ─────────────────────────
// 배포되는 실행 코드만 본다.
//   scripts/ — lint 자신이 검사할 문자열(파일명·색·분)을 상수로 들고 있다. 자기 자신을 잡는다.
//   test/    — 픽스처를 직접 만들어 storage 의 왕복을 확인하는 것이 일이라 파일명이 나올 수 있다.
//   tools/cut/ — 통신 제거판 생성기. "어느 파일의 어느 줄을 지운다" 가 곧 그 일이라
//              파일명·경로가 데이터로 들어 있다. scripts/ 를 빼는 것과 같은 이유다.
const SOURCE_FILES = [
  ...collect(join(APP_DIR, 'main'), ['.js']),
  ...collect(join(APP_DIR, 'renderer'), ['.js', '.html']),
  ...collect(join(APP_DIR, 'shared'), ['.js']),
  join(APP_DIR, 'preload.js'),
  ...collect(join(ROOT_DIR, 'tools'), ['.js', '.mjs'], ['cut'])
];

const REGISTRY_FILE = join(APP_DIR, 'shared', 'registry.js');
const STORAGE_FILE = join(APP_DIR, 'main', 'storage.js');

// ───────────────────────── 예외(allowlist) ─────────────────────────
// registry.js  — 값의 원천. 여기 없으면 어디에도 없어야 한다.
// storage.js   — 파일 IO 유일 관문. 단 파일명도 DATA_STORES 에서 fileOf() 로 꺼내 쓰므로,
//                아래 양방향 대조가 "관문이 정말 등록표를 통해 파일명을 얻는가"를 따로 확인한다.
const FILENAME_ALLOW = new Set([REGISTRY_FILE, STORAGE_FILE]);
const PALETTE_ALLOW = new Set([REGISTRY_FILE]);
const MINUTES_ALLOW = new Set([REGISTRY_FILE]);

// 배열 하나에 색이 몇 개부터 "팔레트를 다시 적은 것"인가.
// 2개까지는 기본값·강조색 같은 단발 지정일 수 있어 넘긴다(UI 크롬 색은 CSS 라 애초에 대상이 아니다).
const PALETTE_MIN = 3;
// 스누즈 프리셋 분 값이 한 배열에 몇 개부터 "메뉴를 다시 적은 것"인가.
const MINUTES_MIN = 3;

const problems = [];

// ───────────────────────── 준비: 등록표에서 기대값을 뽑는다 ─────────────────────────
const STORE_BY_FILE = new Map(REG.DATA_STORES.map(d => [d.file, d]));
const REGISTRY_HEX = new Set(
  [...REG.CAL_PALETTE, ...REG.EVENT_COLORS.map(c => c.hex), REG.DEFAULT_EVENT_COLOR]
    .map(h => h.toLowerCase())
);
const SNOOZE_MINUTES = new Set(REG.SNOOZE_PRESETS.map(p => p.minutes));

/** 파일을 "JS 코드만 남긴" 형태로 읽는다(줄 번호 유지).
 *  문자열 리터럴 자체가 검사 대상이라 keepStrings:true — 대신 주석은 지워서 거짓 경보를 막는다. */
function codeOf(file) {
  const raw = read(file);
  const js = file.endsWith('.html') ? scriptsOfHtml(raw) : raw;
  return stripCommentsAndStrings(js, { keepStrings: true });
}

/** 최상위 배열 리터럴을 대괄호 짝을 세어 통째로 뽑는다.
 *  [[5,'5분 뒤'],[10,'10분 뒤'],…] 처럼 중첩된 메뉴 표를 안쪽 배열로 쪼개서 놓치지 않기 위함이다. */
function topLevelArrays(code) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '[') continue;
    let depth = 0;
    let j = i;
    for (; j < code.length; j++) {
      if (code[j] === '[') depth++;
      else if (code[j] === ']') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) break; // 짝이 안 맞으면 더 볼 것이 없다
    out.push({ index: i, text: code.slice(i, j + 1) });
    i = j; // 안쪽 배열은 바깥 것에 이미 포함돼 있다(같은 위반을 두 번 보고하지 않는다)
  }
  return out;
}

const HEX_LITERAL = /(['"])(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\1/g;
const NUMBER_LITERAL = /(?<![\w.$])\d{1,5}(?![\w.$])/g;

// ───────────────────────── (1) 데이터 파일명 리터럴 ─────────────────────────
// storage 가 유일한 파일 IO 관문이고, 파일명은 DATA_STORES 에서만 나온다.
for (const file of SOURCE_FILES) {
  if (FILENAME_ALLOW.has(file)) continue;
  const code = codeOf(file);
  for (const [fileName, row] of STORE_BY_FILE) {
    const re = new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      problems.push(
        `${rel(file)}:${lineOf(code, m.index)} — 데이터 파일명 '${fileName}' 이 박혀 있습니다. ` +
        `파일명은 registry 의 DATA_STORES('${row.key}') 에서만 나오고 파일 IO 는 app/main/storage.js 하나만 합니다. ` +
        `이 리터럴을 지우고 storage 의 load/save 함수를 부르세요(파일명이 꼭 필요하면 REG.DATA_STORES 에서 꺼내세요).`);
    }
  }
}

// ───────────────────────── (1-b) 양방향: DATA_STORES ↔ storage.fileOf() ─────────────────────────
// 위 검사는 "관문 밖 사용"만 잡는다. 반대쪽 — 등록해 놓고 아무도 안 읽는 죽은 저장소, 또는
// 등록 없이 fileOf() 에 넘긴 키 — 는 여기서 잡는다.
{
  const storageCode = codeOf(STORAGE_FILE);
  const registryCode = codeOf(REGISTRY_FILE);
  const usedKeys = [];
  const locOf = new Map();

  const callRe = /fileOf\(\s*(['"])([A-Za-z0-9_$]+)\1\s*\)/g;
  let m;
  while ((m = callRe.exec(storageCode)) !== null) {
    usedKeys.push(m[2]);
    if (!locOf.has(m[2])) locOf.set(m[2], `${rel(STORAGE_FILE)}:${lineOf(storageCode, m.index)}`);
  }

  const regKeys = REG.DATA_STORES.map(d => d.key);
  for (const d of regKeys) {
    const at = registryCode.indexOf(`key: '${d}'`);
    if (at >= 0 && !locOf.has(d)) locOf.set(d, `${rel(REGISTRY_FILE)}:${lineOf(registryCode, at)}`);
  }

  const A = `registry.DATA_STORES(${rel(REGISTRY_FILE)})`;
  const B = `storage.fileOf() 호출(${rel(STORAGE_FILE)})`;
  for (const msg of diffBothWays(A, regKeys, B, usedKeys)) {
    const hit = [...new Set([...regKeys, ...usedKeys])].find(k => msg.includes(`: ${k} —`));
    problems.push(hit && locOf.has(hit) ? `${locOf.get(hit)} — ${msg}` : msg);
  }
}

// ───────────────────────── (2) 색 팔레트 ─────────────────────────
// 대상은 JS 코드 안의 색 배열 리터럴뿐이다. CSS 의 UI 크롬 색(회색·테두리)은 등록표의 일이 아니라
// 창의 생김새라 검사하지 않는다(HTML 은 scriptsOfHtml 로 <script> 안쪽만 본다).
for (const file of SOURCE_FILES) {
  if (PALETTE_ALLOW.has(file)) continue;
  const code = codeOf(file);

  for (const arr of topLevelArrays(code)) {
    const hexes = arr.text.match(HEX_LITERAL) || [];
    if (hexes.length < PALETTE_MIN) continue;
    problems.push(
      `${rel(file)}:${lineOf(code, arr.index)} — 색 ${hexes.length}개짜리 배열이 박혀 있습니다(${hexes.slice(0, 3).join(', ')}…). ` +
      `팔레트는 registry 의 CAL_PALETTE / EVENT_COLORS 하나뿐입니다. ` +
      `이 배열을 지우고 창에서는 window.api.registry.CAL_PALETTE(또는 EVENT_COLORS)를, main 에서는 REG.CAL_PALETTE 를 쓰세요.`);
  }

  // 배열이 아니라 객체 목록([{id,hex},…] 을 손으로 푼 형태)으로 베껴 놓는 경우가 있어
  // 파일 전체에 등록 팔레트 색이 몇 개나 등장하는지도 센다.
  const found = new Map();
  let m;
  const re = new RegExp(HEX_LITERAL.source, 'g');
  while ((m = re.exec(code)) !== null) {
    const hex = m[2].toLowerCase();
    if (!REGISTRY_HEX.has(hex) || found.has(hex)) continue;
    found.set(hex, lineOf(code, m.index));
  }
  if (found.size >= PALETTE_MIN) {
    const where = [...found.entries()].map(([h, ln]) => `${h}(${rel(file)}:${ln})`).join(', ');
    problems.push(
      `${rel(file)}:${[...found.values()][0]} — 등록 팔레트의 색 ${found.size}개가 이 파일에 그대로 베껴져 있습니다: ${where}. ` +
      `색 목록은 registry 의 CAL_PALETTE / EVENT_COLORS 에서 읽어 쓰세요(창은 window.api.registry, main 은 require('../shared/registry.js')).`);
  }
}

// ───────────────────────── (3) 스누즈 분 배열 ─────────────────────────
// 미루기 메뉴는 SNOOZE_PRESETS 에서 나온다. [5,10,15,30,60,180,1440] 같은 표를 창에 다시 적으면
// 등록표에 항목을 더해도 메뉴가 늘지 않는다.
for (const file of SOURCE_FILES) {
  if (MINUTES_ALLOW.has(file)) continue;
  const code = codeOf(file);
  for (const arr of topLevelArrays(code)) {
    const hits = new Set();
    for (const num of arr.text.match(NUMBER_LITERAL) || []) {
      const n = parseInt(num, 10);
      if (SNOOZE_MINUTES.has(n)) hits.add(n);
    }
    if (hits.size < MINUTES_MIN) continue;
    problems.push(
      `${rel(file)}:${lineOf(code, arr.index)} — 스누즈 프리셋 분 값 ${[...hits].sort((a, b) => a - b).join('/')} 가 배열로 박혀 있습니다. ` +
      `미루기 메뉴는 registry 의 SNOOZE_PRESETS 에서 만듭니다. ` +
      `이 배열을 지우고 window.api.registry.SNOOZE_PRESETS 를 돌면서 {minutes, label} 로 항목을 그리세요.`);
  }
}

process.exit(report(
  'lint:hardcoding',
  problems,
  `데이터 파일명·색 팔레트·스누즈 분이 등록표 밖에 박혀 있지 않습니다 (실행 코드 ${SOURCE_FILES.length}개 파일)`
));

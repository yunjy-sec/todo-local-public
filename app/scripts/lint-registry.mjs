/* lint:registry — 등록표(registry.js) 자체의 건전성.
 *
 * 왜 있는가 = 이 lint 가 막는 사고
 *   verify() 는 main.js·preload.js 부팅 첫 줄에서 돌고 결과가 비지 않으면 throw 한다 —
 *   등록표를 잘못 고치면 창이 하나도 안 뜨는 앱이 되고, 그 사실을 사용자가 먼저 안다.
 *   EXPORTS 에 표를 슬쩍 더하거나 지우면(그룹·문서·다른 lint 는 그대로) 아무도 안 읽는 죽은 표나
 *   코드가 쓰는데 사라진 표가 조용히 생기고, position 의 선택지를 계약 대신 손으로 베껴 두면
 *   contracts 에 값을 더해도 설정 화면 select 에는 영영 안 나온다.
 *   등록표가 시각·난수·다른 모듈을 잡기 시작하면 main 과 창이 서로 다른 표를 들고 돈다.
 *
 *   ARCHITECTURE.services 는 스스로 "_global 서비스 등록의 미러"라고 선언하지만 지금까지
 *   그 선언을 확인하는 사람이 아무도 없었다. verify() 는 계약(healthPath·healthMatch)만 봤고,
 *   port·publicHost·command 는 어느 쪽이 바뀌어도 조용했다. 그 드리프트는 이렇게 끝난다:
 *   _global 이 포트나 publicHost 를 옮겼는데 등록표가 옛 값을 들고 있으면, 앱은 아무도 안 듣는
 *   포트로 동기화를 시도하고 "연결 실패"만 반복한다(사용자에겐 원인이 안 보인다).
 *   반대로 command 가 갈라지면 _global 이 띄우는 서버와 우리가 문서에 적은 서버가 달라져서,
 *   재현 안 되는 버그를 다른 실행본에서 쫓게 된다.
 *   그래서 아래 (6) 이 yaml 을 실제로 읽어 대조한다. yaml 은 _global 소유라 손대지 않는다 —
 *   갈라지면 언제나 등록표 쪽을 맞춘다.
 */

import {
  APP_DIR, ROOT_DIR, loadRegistry, loadContracts, read, rel, lineOf,
  stripCommentsAndStrings, diffBothWays, report
} from './_load.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY_FILE = APP_DIR + '/shared/registry.js';
const CONTRACTS_FILE = APP_DIR + '/shared/contracts.js';
const LINT_REL = 'app/scripts/lint-registry.mjs';

// verify() 를 실제로 돌리고 결과를 터뜨려야 하는 부팅 관문. 여기서 안 부르면 등록표 검증은 장식이다.
const BOOT_GATES = [
  { file: APP_DIR + '/main/main.js', who: 'main 프로세스' },
  { file: APP_DIR + '/preload.js', who: '창 부팅(preload)' }
];

// registry.js 가 읽어도 되는 유일한 모듈. 계약 하나뿐이다(소유권은 계약 → 등록 → 실행 한 방향).
const ALLOWED_REQUIRE = './contracts.js';

/* ARCHITECTURE.services[].yaml 을 어디를 기준으로 푸는가.
 * 같은 표의 ARCHITECTURE.files 가 'app/shared/contracts.js' 처럼 저장소 루트 기준이므로
 * yaml 경로도 루트 기준으로 읽는 것이 맞다(→ todo/../_global/...). app/ 기준으로 적어 둔
 * 체크아웃도 있을 수 있어 둘 다 시도하고, 어느 쪽으로 풀렸는지 통과 메시지에 남긴다. */
const YAML_BASES = [
  { dir: ROOT_DIR, label: '저장소 루트' },
  { dir: APP_DIR, label: 'app/' }
];

/* _global 파일명 규약: <포트>.<서비스id>.yaml — 파일명 자체가 포트와 id 를 선언한다.
 * 그래서 파일명·target·registry.port 세 곳을 서로 대조할 수 있다. */
const YAML_NAME = /^(\d+)\.([a-z0-9][a-z0-9-]*)\.yaml$/;

// ───────────────────────── 고정 목록 (이 lint 의 핵심 상수) ─────────────────────────

/* 현재 등록표가 내보내는 표 전부. 늘어도 줄어도 실패한다.
 *
 * ★ 새 등록표를 추가하면 (1) 이 목록에도 추가하고 (2) registry.js 의 REGISTRY_GROUPS 에도 넣어야 한다.
 *   (2)를 빼먹으면 verify() 가 "그룹 없는 export" 로 터지고, (1)을 빼먹으면 이 lint 가 터진다.
 *   두 곳을 다 거치게 해서 "문서에도 검사에도 안 잡힌 채 자라는 표"가 생기지 못하게 한다.
 *   표를 없앨 때도 같다 — 두 곳에서 함께 뺀다. */
const REQUIRED_EXPORTS = [
  'IPC_CHANNELS',
  'SETTINGS_FIELDS',
  'SETTINGS_SECTIONS',
  'POPUP_ACTIONS',
  'SNOOZE_PRESETS',
  'QUICK_CHIPS',
  'PRIVATE_FIELDS',
  'DATA_STORES',
  'EVENT_COLORS',
  'CAL_PALETTE',
  'CALENDAR_OPS',
  'HOTKEYS',
  'CLI_FLAGS',
  'RRULE_SUPPORT',
  'TESTING',
  'ARCHITECTURE',
  'SCENARIOS'
];

/* EXPORTS 의 표 말고, 모듈이 함께 내보내는 API 표면. preload(channelKeys)·storage(settingsDefaults)·
 * 다른 lint 들이 이 이름으로 등록표를 읽는다 — 이름 하나만 바뀌어도 그쪽은 예외 없이 undefined 를 받는다.
 * DEFAULT_EVENT_COLOR 는 표가 아니라 EVENT_COLORS 의 fallback 스칼라라 EXPORTS(= 그룹 배정 대상)
 * 밖에 있는 것이 맞다. 그래서 REGISTRY_GROUPS 가 아니라 이 목록이 그것을 붙잡는다. */
const REQUIRED_API = [
  'verify',
  'settingsDefaults',
  'settingField',
  'channelKeys',
  'privateKeys',
  'eventColorHex',
  'tableByName',
  'scenarioTargetExists',
  'DEFAULT_EVENT_COLOR',
  'REGISTRY_GROUPS',
  'EXPORTS'
];

// ───────────────────────── 준비 ─────────────────────────

const problems = [];

const regSrc = read(REGISTRY_FILE);
// 두 판본 모두 길이가 보존돼 원본과 줄 번호가 맞물린다.
const regStr = stripCommentsAndStrings(regSrc, { keepStrings: true }); // 리터럴(require 대상·values)이 검사 대상
const regCode = stripCommentsAndStrings(regSrc);                       // 식별자만 볼 때(주석 속 예시에 속지 않으려고)
const conStr = stripCommentsAndStrings(read(CONTRACTS_FILE), { keepStrings: true });

const REG_REL = rel(REGISTRY_FILE);
const CON_REL = rel(CONTRACTS_FILE);

/** registry.js 안에서 needle 이 처음 나오는 자리(파일:줄). 실패 메시지가 고칠 자리를 가리키게 한다. */
function regAt(needle) {
  const i = regStr.indexOf(needle);
  return REG_REL + ':' + (i < 0 ? 1 : lineOf(regStr, i));
}

/** contracts.js 안에서 어휘 선언이 있는 자리. */
function conAt(name) {
  const i = conStr.indexOf('var ' + name);
  return CON_REL + ':' + (i < 0 ? 1 : lineOf(conStr, i));
}

const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameSet = (a, b) => a.length === b.length && a.every(v => b.indexOf(v) >= 0);

// ───────────────────────── _global yaml 미니 리더 ─────────────────────────
/* 의존성 0 이 이 저장소의 규칙이라 YAML 파서를 넣지 않는다. 우리가 봐야 하는 값은
 *   ① 들여쓰기 0 의 `키: 값`  ② `app:` 블록 안의 `키: 값`  ③ `키:` 밑의 `- 문자열` 목록
 * 이 셋뿐이라 줄 단위로 충분하다. 대신 형태가 이 셋을 벗어나면(인라인 flow, 블록 스칼라 등)
 * 조용히 넘기지 않고 "못 읽었다"고 신고한다 — 못 읽은 것을 통과로 세면 이 검사도 장식이 된다. */

/** 따옴표를 벗기고 줄 끝 주석을 떼어 낸다. */
function yamlStrip(raw) {
  let s = String(raw).trim();
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  const hash = s.indexOf(' #');
  if (hash >= 0) s = s.slice(0, hash).trim();
  return s;
}

/** 들여쓰기 0 의 `key: 값`. 값이 비어 있으면 블록·목록의 머리라 value 가 '' 다. */
function yamlScalar(lines, key) {
  const re = new RegExp('^' + key + ':[ \\t]*(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) return { value: yamlStrip(m[1]), line: i + 1 };
  }
  return null;
}

/** 들여쓰기 0 의 `parent:` 블록 안쪽 줄들(원문·줄번호). 들여쓰기가 0 으로 돌아오면 끝. */
function yamlBlock(lines, parent) {
  const head = new RegExp('^' + parent + ':[ \\t]*$');
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (head.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i];
    if (/^[ \t]*$/.test(text)) continue;
    if (!/^[ \t]/.test(text)) break;
    out.push({ text, line: i + 1 });
  }
  return out;
}

/** 블록 안에서 들여쓰기 정확히 2 칸인 `key: 값`. (더 깊은 자식과 섞이지 않게 칸수를 고정한다.) */
function blockScalar(block, key) {
  const re = new RegExp('^  ' + key + ':[ \\t]*(.*)$');
  for (const b of block || []) {
    const m = re.exec(b.text);
    if (m) return { value: yamlStrip(m[1]), line: b.line };
  }
  return null;
}

/** 들여쓰기 0 의 `key:` 밑에 붙은 `- 값` 목록. 인라인 flow([a, b])면 items 를 주지 않는다. */
function yamlSeq(lines, key) {
  const head = new RegExp('^' + key + ':[ \\t]*(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    if (m[1].trim()) return { items: null, inline: m[1].trim(), line: i + 1 };
    const items = [];
    for (let j = i + 1; j < lines.length; j++) {
      const text = lines[j];
      if (/^[ \t]*$/.test(text) || /^[ \t]*#/.test(text)) continue;
      const im = /^[ \t]+-[ \t]*(.*)$/.exec(text);
      if (!im) break;
      items.push(yamlStrip(im[1]));
    }
    return { items, line: i + 1 };
  }
  return null;
}

// ───────────────────────── (1) 등록표 순수성 ─────────────────────────
// 로드 없이 소스만으로 되는 검사라 맨 앞에 둔다 — 등록표가 아예 로드되지 않는 원인이 대개 여기 있고,
// 그때도 이 메시지는 나와야 한다.
//
// DOM 전역·Node 전역(process/__dirname)·비상대 require(electron·fs·path…)는 lint:boundary 의
// shared 검사가, fetch/http/WebSocket 류는 lint:network 가 이미 파일 단위로 본다.
// 그래서 여기서는 그 둘이 안 보는 잔여분만 본다:
//   ① 계약 말고 다른 파일을 읽는가 (상대경로라 lint:boundary 는 통과시킨다)
//   ② UMD 파일에 ESM 문법이 섞였는가
//   ③ 로드 시각·난수에 따라 표의 값이 달라지는가

const reReq = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
let mq;
while ((mq = reReq.exec(regStr)) !== null) {
  if (mq[2] === ALLOWED_REQUIRE) continue;
  problems.push(
    `${REG_REL}:${lineOf(regStr, mq.index)} — 등록표가 '${mq[2]}' 를 require 합니다. ` +
    `registry.js 가 읽어도 되는 것은 ${ALLOWED_REQUIRE}(계약) 하나뿐입니다 — 창은 이 파일을 <script> 로도 읽으므로 ` +
    `다른 모듈을 끌어오면 그 자리에서 창 부팅이 멈춥니다. 그 코드는 app/main/ 으로 옮기고 등록표는 값만 들고 있게 하세요.`);
}

const ESM_SYNTAX = [
  { re: /^[ \t]*import[ \t]+[\w{*]/m, what: 'import 선언' },
  { re: /\bimport\s*\(/, what: '동적 import()' },
  { re: /^[ \t]*export[ \t]+(?:default|const|let|var|function|class|\{)/m, what: 'export 선언' }
];
for (const rule of ESM_SYNTAX) {
  const m = rule.re.exec(regCode);
  if (!m) continue;
  problems.push(
    `${REG_REL}:${lineOf(regCode, m.index)} — ${rule.what} 이 있습니다. registry.js 는 main 의 require 와 창의 <script> 가 ` +
    `같이 읽는 UMD 파일이라 ESM 문법을 쓰면 양쪽 다 파싱에서 죽습니다 — 파일 맨 아래 factory 반환값으로만 내보내세요.`);
}

const IMPURE = [
  { re: /\bDate\s*\.\s*now\s*\(/g, what: 'Date.now()' },
  { re: /\bnew\s+Date\s*\(/g, what: 'new Date()' },
  { re: /\bMath\s*\.\s*random\s*\(/g, what: 'Math.random()' },
  { re: /\bset(?:Timeout|Interval)\s*\(/g, what: '타이머(setTimeout/setInterval)' }
];
for (const rule of IMPURE) {
  rule.re.lastIndex = 0;
  let m;
  while ((m = rule.re.exec(regCode)) !== null) {
    problems.push(
      `${REG_REL}:${lineOf(regCode, m.index)} — 등록표 안에서 ${rule.what} 를 씁니다. ` +
      `main 과 창들이 이 파일을 각각 로드하므로 로드 시각에 따라 값이 달라지면 창마다 다른 표를 들고 돕니다(재현 불가능한 버그). ` +
      `시각·난수는 app/main/ 에서 계산해 인자로 넘기고, 등록표에는 상수와 순수 함수만 두세요.`);
  }
}

// ───────────────────────── 등록표·계약 로드 ─────────────────────────
// 로드가 실패하면 아래 검사는 전부 의미가 없다. 원인(대개 위 순수성 위반)과 함께 알려주고 그 부분만 건너뛴다.

let REG = null;
let C = null;
try {
  REG = await loadRegistry();
  C = await loadContracts();
} catch (e) {
  const why = String((e && e.message) || e).split('\n')[0];
  problems.push(
    `${REG_REL}:1 — 등록표를 불러오다 터졌습니다: ${why} · ` +
    `이 상태면 main 도 창도 부팅에서 같은 자리에서 죽습니다(앱이 아예 뜨지 않습니다). ` +
    `위의 순수성 위반부터 고치고, 없다면 node -e "require('./shared/registry.js')" 로 문법을 확인하세요.`);
}

let exportCount = 0;
let apiCount = 0;
let vocabCount = 0;
// 미러 대조 결과는 통과 메시지에 반드시 실린다 — "대조했다"와 "파일이 없어 건너뛰었다"가
// 똑같은 초록으로 보이면 안 된다(그게 이 검사가 막으려는 사고와 같은 종류의 사고다).
let mirrorNote = '_global yaml 미러 대조 못 함(등록표 로드 실패)';

if (REG && C) {
  // ───────────────────────── (2) verify() 가 깨끗한가 ─────────────────────────

  const VERIFY_AT = regAt('function verify(');
  const errs = REG.verify();

  if (!Array.isArray(errs)) {
    problems.push(
      `${VERIFY_AT} — verify() 가 배열이 아니라 ${typeof errs} 를 돌려줍니다. 부팅 코드는 결과의 .length 로만 판단하므로 ` +
      `true 를 돌려주면 문제가 있어도 undefined 로 어물쩍 통과합니다 — 문제 문자열 배열(문제 없으면 [])을 돌려주세요.`);
  } else {
    for (const e of errs) {
      problems.push(
        `${VERIFY_AT} — verify() 가 스스로 신고한 문제입니다: ${e} · ` +
        `이 상태로 두면 app/main/main.js 와 app/preload.js 의 부팅 첫 줄이 throw 해서 창이 하나도 뜨지 않습니다.`);
    }
  }

  // (2-b) 부팅 관문이 정말 verify() 를 부르고 결과를 터뜨리는가.
  // 안 부르면 위 검사가 CI 에서만 도는 장식이 되고, 배포본은 깨진 등록표로 조용히 오작동한다.
  for (const gate of BOOT_GATES) {
    const code = stripCommentsAndStrings(read(gate.file));
    const at = rel(gate.file);
    const m = /\.\s*verify\s*\(\s*\)/.exec(code);
    if (!m) {
      problems.push(
        `${at}:1 — ${gate.who} 부팅 코드가 registry.verify() 를 부르지 않습니다. ` +
        `파일 첫머리에 const problems = REG.verify(); if (problems.length) throw new Error('registry: ' + problems.join(' | ')); 를 두세요 ` +
        `(등록이 계약을 어긴 채로 창이 뜨면 잘못된 표가 그대로 사용자 데이터에 적용됩니다).`);
      continue;
    }
    const tail = code.slice(m.index, m.index + 400);
    if (!/\blength\b/.test(tail) || !/\bthrow\b|\breject\s*\(/.test(tail)) {
      problems.push(
        `${at}:${lineOf(code, m.index)} — verify() 를 부르고도 결과를 터뜨리지 않습니다. ` +
        `바로 뒤에서 if (<결과>.length) throw new Error(...) 로 부팅을 막으세요 ` +
        `(verify 는 절대 throw 하지 않으므로 여기서 막지 않으면 아무 일도 일어나지 않습니다).`);
    }
  }

  // ───────────────────────── (3) export 목록 고정 (양방향) ─────────────────────────

  const actualExports = Object.keys(REG.EXPORTS);
  const actualApi = Object.keys(REG).filter(k => !Object.prototype.hasOwnProperty.call(REG.EXPORTS, k));
  exportCount = actualExports.length;
  apiCount = actualApi.length;

  const FIX_EXPORTS =
    `— 표를 새로 만들었다면 ${LINT_REL} 의 REQUIRED_EXPORTS 와 ${regAt('var REGISTRY_GROUPS')} 의 REGISTRY_GROUPS 양쪽에 넣고, ` +
    `없앴다면 두 곳에서 함께 빼세요(한 곳만 고치면 죽은 등록이나 그룹 없는 export 가 남습니다).`;

  for (const p of diffBothWays(
    `${LINT_REL} 의 REQUIRED_EXPORTS(고정 목록)`, REQUIRED_EXPORTS,
    `${regAt('var EXPORTS')} 의 EXPORTS`, actualExports
  )) problems.push(`${p} ${FIX_EXPORTS}`);

  for (const p of diffBothWays(
    `${LINT_REL} 의 REQUIRED_API(고정 목록)`, REQUIRED_API,
    `${regAt('var api = {')} 가 내보내는 함수·값`, actualApi
  )) problems.push(
    `${p} — preload.js(channelKeys) · storage.js(settingsDefaults) · 각 lint 가 이 이름으로 등록표를 읽습니다. ` +
    `이름을 바꾸면 그쪽은 예외 없이 undefined 를 받습니다.`);

  // ───────────────────────── (4) 계약의 닫힌 어휘 ↔ 등록표 사용처 ─────────────────────────
  // verify() 가 이미 보는 것(POPUP_ACTIONS ↔ POPUP_ACTION_KEYS 양방향, kind/type 이 어휘 안인가,
  // ARCHITECTURE.services 의 health 미러)은 여기서 다시 보지 않는다. verify 가 못 보는 자리만 본다.

  const VOCABS = Object.keys(C).filter(k => Array.isArray(C[k]) && C[k].every(v => typeof v === 'string'));
  vocabCount = VOCABS.length;

  // (4-a) enum 설정 필드의 선택지는 계약의 어휘와 "같은 배열"이어야 한다.
  //       verify 는 values 가 비어 있지 않은 배열인지만 본다 — 내용이 계약과 갈라진 것은 못 본다.
  for (const f of REG.SETTINGS_FIELDS) {
    if (f.type !== 'enum') continue;
    const where = `${regAt("key: '" + f.key + "'")} SETTINGS_FIELDS '${f.key}'`;
    const values = Array.isArray(f.values) ? f.values : [];
    const match = VOCABS.find(v => sameSet(C[v], values));
    if (!match) {
      problems.push(
        `${where} — 선택지 [${values.join(', ')}] 와 같은 닫힌 어휘가 계약에 없습니다. ` +
        `${CON_REL} 에 어휘 배열을 만들고 여기서 values: C.<어휘이름> 으로 참조하세요 ` +
        `(등록표에 손으로 적은 선택지는 그 값으로 분기하는 main 코드와 조용히 갈라집니다).`);
      continue;
    }
    if (!sameOrder(C[match], values)) {
      problems.push(
        `${where} — values 가 contracts.${match}(${conAt(match)}) 와 다릅니다: ` +
        `[${values.join(', ')}] vs [${C[match].join(', ')}]. values: C.${match} 로 참조해 한 벌만 두세요 ` +
        `(순서는 설정 화면 select 의 표시 순서라 계약과 같아야 합니다).`);
    }
  }

  // (4-b) 어휘를 값으로 베껴 적지 않았는가 — 소스에서 직접 본다(리터럴이 검사 대상이라 keepStrings).
  const reValues = /values\s*:\s*([^,}\n]+)/g;
  let mv;
  while ((mv = reValues.exec(regStr)) !== null) {
    const rhs = mv[1].trim();
    if (/^C\.[A-Za-z_$][\w$]*$/.test(rhs)) continue;
    problems.push(
      `${REG_REL}:${lineOf(regStr, mv.index)} — 'values: ${rhs.slice(0, 40)}' 처럼 선택지를 등록표 안에 적었습니다. ` +
      `닫힌 어휘의 주인은 계약입니다 — ${CON_REL} 로 옮기고 values: C.<어휘이름> 으로 참조하세요 ` +
      `(계약에 값을 더해도 설정 화면 select 가 안 늘어나는 사고를 막습니다).`);
  }

  // (4-c) RRULE_SUPPORT.freqs 는 recurrence 가 전개할 수 있는 FREQ 목록 = 계약의 RECUR_FREQS.
  if (!sameOrder(C.RECUR_FREQS, REG.RRULE_SUPPORT.freqs || [])) {
    problems.push(
      `${regAt('var RRULE_SUPPORT')} RRULE_SUPPORT.freqs 가 contracts.RECUR_FREQS(${conAt('RECUR_FREQS')}) 와 다릅니다: ` +
      `[${(REG.RRULE_SUPPORT.freqs || []).join(', ')}] vs [${C.RECUR_FREQS.join(', ')}]. freqs: C.RECUR_FREQS 로 참조하세요 ` +
      `(둘이 갈라지면 상세 폼에서는 고를 수 있는데 recurrence 가 전개하지 못하는 반복이 생깁니다).`);
  }
  const mf = /freqs\s*:\s*([^,}\n]+)/.exec(regStr);
  if (mf && mf[1].trim() !== 'C.RECUR_FREQS') {
    problems.push(
      `${REG_REL}:${lineOf(regStr, mf.index)} — freqs 를 '${mf[1].trim().slice(0, 40)}' 로 적었습니다. ` +
      `freqs: C.RECUR_FREQS 로 참조하세요(FREQ 목록의 주인은 계약입니다).`);
  }

  // (4-d) 죽은 어휘 — 계약에는 있는데 등록표 어디서도 안 쓰는 값.
  //       반대 방향(등록표가 어휘 밖의 값을 쓰는 것)은 verify 의 validate*/POPUP 검사가 이미 본다.
  const COVERAGE = [
    {
      vocab: 'IPC_KINDS', where: 'IPC_CHANNELS 의 kind',
      used: [...new Set(REG.IPC_CHANNELS.map(c => c.kind))],
      fix: 'preload 는 kind 마다 관문 Set 을 하나씩 만듭니다 — 아무도 안 쓰는 kind 는 한 번도 검증된 적 없는 죽은 관문입니다. ' +
        '그 kind 의 채널을 등록하거나 계약에서 빼세요'
    },
    {
      vocab: 'SETTING_TYPES', where: 'SETTINGS_FIELDS 의 type',
      used: [...new Set(REG.SETTINGS_FIELDS.map(f => f.type))],
      fix: 'storage 의 clampSettings 가 type 마다 정규화 분기를 들고 있습니다 — 쓰이지 않는 type 은 한 번도 돌아본 적 없는 분기입니다. ' +
        '그 type 의 필드를 등록하거나 계약에서 빼세요'
    },
    {
      vocab: 'POPUP_KINDS', where: 'POPUP_ACTIONS 의 kinds',
      used: [...new Set(REG.POPUP_ACTIONS.reduce((a, r) => a.concat(r.kinds || []), []))],
      fix: '그 종류의 팝업은 버튼이 하나도 없이 떠서 사용자가 손댈 방법이 없습니다. 액션의 kinds 에 넣거나 계약에서 빼세요'
    }
  ];
  for (const cov of COVERAGE) {
    for (const v of C[cov.vocab]) {
      if (cov.used.indexOf(v) >= 0) continue;
      problems.push(
        `${conAt(cov.vocab)} — contracts.${cov.vocab} 의 '${v}' 를 ${REG_REL} 의 ${cov.where} 에서 아무도 쓰지 않습니다(죽은 어휘). ${cov.fix}.`);
    }
  }

  // (4-e) 등록표의 설명이 계약 어휘를 그대로 나열하는가.
  //       이 desc 가 그 키·채널이 받는 값의 유일한 문서다. 계약에 값이 늘어도 설명이 그대로면
  //       다음 사람이 없는 값을 저장하거나(private 키) 무시되는 scope 를 보낸다.
  const DESC_VOCAB = [];
  const todoStatusRow = REG.PRIVATE_FIELDS.find(f => f.key === 'todoStatus');
  if (todoStatusRow) {
    DESC_VOCAB.push({
      where: `${regAt("key: 'todoStatus'")} PRIVATE_FIELDS 'todoStatus' 의 desc`,
      text: todoStatusRow.desc, vocab: 'TODO_STATUS'
    });
  }
  for (const ch of REG.IPC_CHANNELS) {
    if (!/scope\s*:/.test(ch.desc || '')) continue;
    DESC_VOCAB.push({
      where: `${regAt("key: '" + ch.key + "'")} IPC_CHANNELS '${ch.key}' 의 desc`,
      text: ch.desc, vocab: 'SCOPES'
    });
  }
  for (const d of DESC_VOCAB) {
    const run = /([A-Za-z]+(?:\|[A-Za-z]+)+)/.exec(d.text || '');
    if (!run) {
      problems.push(
        `${d.where} — 받는 값이 무엇인지 적혀 있지 않습니다. contracts.${d.vocab}(${conAt(d.vocab)})를 ` +
        `"${C[d.vocab].join('|')}" 형태로 desc 에 그대로 나열하세요.`);
      continue;
    }
    for (const p of diffBothWays(`contracts.${d.vocab} (${conAt(d.vocab)})`, C[d.vocab], d.where, run[1].split('|'))) {
      problems.push(`${p} (설명이 계약과 갈라졌습니다 — ${d.where} 를 "${C[d.vocab].join('|')}" 로 고치세요.)`);
    }
  }

  // ───────────────────────── (5) verify 가 중복을 안 보는 표의 중복 키 ─────────────────────────
  // verify() 는 dupCheck(...) 로 몇몇 표만 본다. 어떤 표를 보는지 소스에서 읽어 와서
  // 나머지 배열 표를 여기서 마저 본다(verify 가 dupCheck 를 늘리면 이 검사는 저절로 물러난다).
  const dupChecked = new Set();
  const reDup = /dupCheck\s*\(\s*([A-Za-z_$][\w$]*)/g;
  let md;
  while ((md = reDup.exec(regCode)) !== null) dupChecked.add(md[1]);

  for (const name of actualExports) {
    const table = REG.EXPORTS[name];
    if (!Array.isArray(table) || dupChecked.has(name)) continue;
    const seen = new Map();
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      let id = null;
      if (typeof row === 'string') id = row;
      else if (row && row.key !== undefined) id = String(row.key);
      else if (row && row.id !== undefined) id = String(row.id);
      else if (row && row.minutes !== undefined) id = String(row.minutes);
      if (id === null) continue;
      if (seen.has(id)) {
        problems.push(
          `${regAt('var ' + name)} ${name}: '${id}' 가 두 번 등록돼 있습니다(${seen.get(id)}번째와 ${i}번째 행) — 하나를 지우세요. ` +
          `표에서 UI 를 만드는 자리(칩·팔레트·메뉴)는 같은 항목을 두 번 그리고, 키로 찾는 자리는 앞의 것만 보고 뒤의 것을 조용히 버립니다. ` +
          `(verify() 의 dupCheck 대상이 아닌 표라 이 lint 가 봅니다.)`);
      } else {
        seen.set(id, i);
      }
    }
  }

  // ───────────────────────── (6) ARCHITECTURE.services ↔ _global yaml 미러 ─────────────────────────
  // ARCHITECTURE 머리주석은 "_global 서비스 등록의 미러"라고 선언한다. 선언만 하고 대조하지 않으면
  // 그건 사실이 아니라 희망이다 — verify() 는 계약과 맞물리는 두 값(healthPath·healthMatch)만 보고,
  // port·publicHost·command·name 은 어느 쪽이 움직여도 조용했다. 여기서 실제 파일을 읽어 결박한다.
  const mirrorDone = [];
  const mirrorSkipped = [];


  mirrorNote = mirrorDone.length
    ? `_global yaml 미러 ${mirrorDone.length}개 대조(name·port·publicHost·healthPath·healthMatch·command): ${mirrorDone.join(', ')}`
    : '_global yaml 미러 대조 0건';
  if (mirrorSkipped.length) {
    mirrorNote += ` · 건너뜀 ${mirrorSkipped.length}개(파일 없음 — 다른 사람의 체크아웃이면 정상입니다): ${mirrorSkipped.join(', ')}`;
  }
}

process.exit(report(
  'lint:registry',
  problems,
  `verify() 0건 · export ${exportCount}개 + API ${apiCount}개 고정 · ` +
  `계약 어휘 ${vocabCount}개 대조(죽은 어휘·enum 선택지·desc) · 등록표 순수성(계약만 require, 시각·난수 없음) · ` +
  mirrorNote
));

/* 문서 검사 — 문서가 코드에 없는 것을 말하지 않는가.
 *
 * 막는 사고
 *   README 를 그대로 따라 친 사람에게 "Missing script" 만 뜨는 일(문서에만 있는 npm 명령),
 *   문서가 가리킨 파일이 이름만 바뀐 채 사라져 새로 온 사람이 없는 파일을 뒤지는 일,
 *   registry 의 TESTING.checks 에는 적어 놨는데 package.json 에 없어서 CI 가 그 검사를
 *   한 번도 돌리지 않는 일 — 셋 다 "문서는 멀쩡한데 실행할 수 없다" 는 같은 사고다.
 *   문서는 읽는 사람에게 계약이므로, 실행 가능한 주장만 남긴다.
 */

import {
  ROOT_DIR, APP_DIR, collect, read, rel, lineOf,
  stripCommentsAndStrings, diffBothWays, report, loadRegistry
} from './_load.mjs';

// ───────────────────────── 검사 범위 ─────────────────────────

// 저장소 최상위 문서(README.md·앞으로 생길 CLAUDE.md)와 docs/ 아래 전부.
// app/·src/ 안의 .md 는 코드 곁의 메모라 통치 문서가 아니다.
function isGovernedDoc(path) {
  return !path.includes('/') || path.startsWith('docs/');
}

// ───────────────────────── 예외 ─────────────────────────

// 미래 계획 절 — 여기 적힌 파일·명령은 "아직 없는 것이 정상"이라 통째로 검사에서 뺀다.
// 절 제목이 바뀌면 예외가 조용히 넓어지거나 사라지므로, 제목을 못 찾으면 실패로 알린다.
const FUTURE_SECTIONS = [
  {
    doc: 'docs/ARCHITECTURE.md',
    heading: /^##\s*1\.\s*파일 구조/,
    why: '§1 은 "목표" 구조 — R2~R4 에서 만들 파일까지 그려 둔 그림이다'
  },
  {
    doc: 'docs/PLAN.md',
    heading: /^##\s*6\.\s*P3\b/,
    why: '§6 은 다음 단계(P3 계정 연결) — 코드가 아직 없는 것이 정상이다'
  },
  {
    doc: 'docs/PLAN.md',
    heading: /^##\s*7\.\s*P5\b/,
    why: '§7 은 웹 버전(P5) 구상 — 아직 파일이 없다'
  },
  {
    doc: 'docs/PLAN.md',
    heading: /^##\s*8\.\s*이후/,
    why: '§8 은 그 뒤의 로드맵(P4)'
  }
];

// 문서에 나오지만 app/package.json 에 아직 없는 npm 이름 — "유예"다(영구 예외가 아니다).
// R2·R3 에서 명령이 전부 등록돼 유예가 비었다. 이 배열이 차 있으면 §1(문서 속 명령 실존)과
// §3(TESTING.checks ↔ package.json)이 그만큼 아무것도 검사하지 않는다는 뜻이다.
// 다시 넣게 되면 아래 "유예가 낡았는가" 대조가 근거가 사라진 항목을 실패로 보고한다.
const PENDING_NPM = [];

// 이 저장소의 package.json 에 있을 수 없는 npm 이름(영구 예외).
//   icons  ARCHITECTURE §4 의 "_global 등록 후 npm run icons" — 남의 저장소 명령이다.
const EXTERNAL_NPM = ['icons'];

// 문서가 안내하지만 우리 앱이 해석하는 인자가 아닌 플래그(영구 예외).
//   --remote-debugging-port  Chromium 내장 플래그. 스모크 테스트가 electron 에 넘길 뿐
//                            main.js 가 읽지 않는다(읽어서도 안 된다).
const NON_APP_FLAGS = ['--remote-debugging-port'];

// package.json 의 스크립트 중 "검사 명령"으로 보는 이름. start 같은 실행 명령은
// TESTING.checks 의 행이 아니므로 대조 대상에서 뺀다.
const CHECK_SCRIPT_RE = /^(?:lint|check)(?::|$)|^test(?::|$)/;

// 여러 검사를 한 번에 도는 묶음 명령. 개별 검사가 아니라 TESTING.checks 에 행이 없는 게 맞다.
const AGGREGATE_SCRIPTS = ['lint', 'check'];

// ───────────────────────── 패턴 ─────────────────────────

// `npm run <이름>` — 이름 뒤 백틱·괄호에서 끊긴다.
const NPM_RUN_RE = /npm\s+run\s+([A-Za-z0-9][A-Za-z0-9:_.-]*)/g;
// `npm <이름>` 중 스크립트로 이어지는 축약형만. install·ci 같은 npm 하위명령은 스크립트가 아니다.
const NPM_SHORTHAND_RE = /npm\s+(test|start|stop|restart)(?![A-Za-z0-9:_.-])/g;

// 백틱 코드 스팬 하나.
const SPAN_RE = /`([^`\n]+)`/g;
// 경로처럼 생긴 문자열(공백·꺾쇠·콜론이 있으면 경로가 아니라 설명문이다).
const PATHY_RE = /^[A-Za-z0-9._*/-]+$/;
const HAS_EXT_RE = /\.[A-Za-z0-9]{1,6}$/;

// CLI 플래그 토큰.
const FLAG_RE = /--[a-z][a-z0-9-]*/g;
const LONE_FLAG_RE = /^--[a-z][a-z0-9-]*$/;
// 우리 앱을 실행하는 스팬인가(그래야 그 안의 플래그가 우리 인자다).
const APP_INVOKE_RE = /electron\s+\.|TodoPopup\.exe/;
// main.js 안의 플래그 문자열 리터럴.
const FLAG_LITERAL_RE = /['"](--[a-z][a-z0-9-]*)['"]/g;

// ───────────────────────── 도우미 ─────────────────────────

const problems = [];
const warnings = [];

/** 미래 계획 절을 줄 번호를 유지한 채 지운다. */
function blankFutureSections(path, src) {
  const rules = FUTURE_SECTIONS.filter((r) => r.doc === path);
  if (!rules.length) return src;
  const lines = src.split('\n');
  for (const r of rules) {
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^(#+)\s/);
      if (h && r.heading.test(lines[i])) { start = i; level = h[1].length; break; }
    }
    if (start < 0) {
      problems.push(
        `${path}:1 — 검사에서 빼 둔 절(${r.heading}) 제목을 찾지 못했습니다. ` +
        `절을 지웠다면 app/scripts/lint-docs.mjs 의 FUTURE_SECTIONS 에서 그 항목을 빼고, ` +
        `제목만 바꿨다면 heading 정규식을 새 제목에 맞추세요 (예외 이유: ${r.why}).`);
      continue;
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const h = lines[i].match(/^(#+)\s/);
      if (h && h[1].length <= level) { end = i; break; }
    }
    for (let i = start; i < end; i++) lines[i] = '';
  }
  return lines.join('\n');
}

function* matches(re, src) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    yield m;
    if (m[0].length === 0) re.lastIndex++;
  }
}

// ───────────────────────── 문서 읽기 ─────────────────────────

const REG = await loadRegistry();

const docs = collect(ROOT_DIR, ['.md'])
  .map((f) => ({ path: rel(f), src: read(f) }))
  .filter((d) => isGovernedDoc(d.path))
  .map((d) => ({ path: d.path, src: blankFutureSections(d.path, d.src) }));

// ───────────────────────── (1) 문서 속 npm 명령이 실존하는가 ─────────────────────────

const pkg = JSON.parse(read(APP_DIR + '/package.json'));
const scripts = Object.keys(pkg.scripts || {});
const known = scripts.join(', ') || '(없음)';

let npmChecked = 0;
for (const d of docs) {
  for (const re of [NPM_RUN_RE, NPM_SHORTHAND_RE]) {
    for (const m of matches(re, d.src)) {
      const name = m[1];
      if (EXTERNAL_NPM.includes(name) || PENDING_NPM.includes(name)) continue;
      npmChecked++;
      if (scripts.includes(name)) continue;
      problems.push(
        `${d.path}:${lineOf(d.src, m.index)} — 문서가 안내한 'npm run ${name}' 가 ` +
        `app/package.json 의 scripts 에 없습니다(있는 것: ${known}). ` +
        `명령을 package.json 에 추가하거나, 이름이 바뀐 것이면 문서를 그 이름으로 고치세요.`);
    }
  }
}

// ───────────────────────── (2) 문서가 가리킨 파일이 있는가 ─────────────────────────

const cands = [];
for (const d of docs) {
  for (const m of matches(SPAN_RE, d.src)) {
    const t = m[1].trim();
    if (!t.includes('/') || !PATHY_RE.test(t) || !HAS_EXT_RE.test(t)) continue;
    // '../' 로 나가면 다른 저장소(_global 등)다. 이 저장소의 결함이 아니므로 따지지 않는다.
    if (t.startsWith('../')) continue;
    cands.push({ path: d.path, line: lineOf(d.src, m.index), p: t });
  }
}

// _load 의 collect 로만 파일 목록을 만든다(의존성 0 규약: fs 를 직접 열지 않는다).
// 후보에 쓰인 확장자만 훑으면 되므로 저장소 전체를 읽지 않는다.
const wantExts = [...new Set(cands.map((c) => c.p.slice(c.p.lastIndexOf('.'))))];
const universe = new Set(wantExts.length ? collect(ROOT_DIR, wantExts).map(rel) : []);

function existsAs(p) {
  // 문서는 저장소 기준(tools/…)으로도, 앱 기준(main/…)으로도 경로를 적는다. 둘 다 인정한다.
  for (const form of [p, 'app/' + p]) {
    if (form.includes('*')) {
      const re = new RegExp('^' + form.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
      for (const u of universe) if (re.test(u)) return true;
    } else if (universe.has(form)) return true;
  }
  return false;
}

for (const c of cands) {
  if (existsAs(c.p)) continue;
  // 아직 안 만든 파일을 미리 적어 둔 문서가 있으므로 실패가 아니라 경고다.
  // (계획 절은 위에서 이미 통째로 빠졌다 — 여기 남은 것은 "곧 만들 것" 이다.)
  warnings.push(
    `${c.path}:${c.line} — 문서가 가리키는 ${c.p} 가 아직 없습니다. ` +
    `계획한 파일이면 그대로 두고, 이름이 바뀐 것이면 문서를 실제 경로로 고치세요.`);
}

// ───────────────────────── (3) TESTING.checks ↔ package.json (양방향) ─────────────────────────

// 유예가 낡지 않았는가 — 근거(그 명령이 아직 없음)가 사라졌으면 실패시킨다.
// 유예가 방패로 굳지 않게 하는 장치다(CLAUDE.md "유예(allowlist)는 방패가 아니다").
for (const n of PENDING_NPM) {
  if (scripts.includes(n)) {
    problems.push(
      `app/scripts/lint-docs.mjs — '${n}' 는 이미 app/package.json 의 scripts 에 있습니다. ` +
      'PENDING_NPM 에서 빼세요(유예의 근거가 사라졌습니다).');
  }
}

const registeredChecks = (REG.TESTING.checks || [])
  .map((c) => c.npm)
  .filter((n) => !PENDING_NPM.includes(n));

const pkgChecks = scripts
  .filter((n) => CHECK_SCRIPT_RE.test(n))
  .filter((n) => !AGGREGATE_SCRIPTS.includes(n))
  .filter((n) => !PENDING_NPM.includes(n));

for (const msg of diffBothWays(
  'app/shared/registry.js 의 TESTING.checks', registeredChecks,
  'app/package.json 의 scripts', pkgChecks
)) {
  problems.push(msg + ' (검사 하나는 스크립트 파일·package.json·lint-all·TESTING.checks 네 자리에 함께 등록합니다)');
}

// ───────────────────────── (4) 문서에 적힌 CLI 플래그 ↔ 등록 ↔ main.js ─────────────────────────
// ARCHITECTURE §2 가 CLI_FLAGS 의 결박 대상으로 "README·main 인자 처리 대조" 를 지정한다.

const docFlags = [];
for (const d of docs) {
  for (const m of matches(SPAN_RE, d.src)) {
    const span = m[1].trim();
    // 플래그 하나만 적힌 스팬이거나, 우리 앱을 실행하는 스팬일 때만 우리 인자로 본다.
    // (`node --test` 같은 남의 도구 플래그를 우리 것으로 오해하지 않는다.)
    if (!LONE_FLAG_RE.test(span) && !APP_INVOKE_RE.test(span)) continue;
    for (const f of matches(FLAG_RE, span)) {
      if (!NON_APP_FLAGS.includes(f[0])) docFlags.push(f[0]);
    }
  }
}

const regFlags = (REG.CLI_FLAGS || []).map((f) => f.key);

// 인자 해석은 main.js 한 곳이 한다. 플래그는 문자열 리터럴이라 keepStrings 로 읽고,
// 주석 속 예시 문장은 지워 거짓 경보를 막는다.
const MAIN_JS = 'app/main/main.js';
const mainSrc = stripCommentsAndStrings(read(APP_DIR + '/main/main.js'), { keepStrings: true });
const codeFlags = [...matches(FLAG_LITERAL_RE, mainSrc)].map((m) => m[1]);

for (const msg of diffBothWays(
  '문서(README 등)가 안내한 CLI 플래그', docFlags,
  'app/shared/registry.js 의 CLI_FLAGS', regFlags
)) {
  problems.push(msg);
}
for (const msg of diffBothWays(
  'app/shared/registry.js 의 CLI_FLAGS', regFlags,
  `${MAIN_JS} 의 인자 처리`, codeFlags
)) {
  problems.push(msg);
}

// ───────────────────────── 보고 ─────────────────────────

if (warnings.length) {
  console.log(`  warn lint:docs — 아직 없는 파일을 가리키는 문서 참조 ${warnings.length}건 (그 파일을 만들면 사라집니다)`);
  for (const w of warnings) console.log(`       ${w}`);
}

process.exit(report(
  'lint:docs',
  problems,
  `문서 ${docs.length}개 — npm 명령 ${npmChecked}건 실존 · 경로 ${cands.length}건 대조(미존재 경고 ${warnings.length}) · ` +
  `CLI 플래그 ${regFlags.length}개 문서=등록=main.js · TESTING.checks 유예 ${PENDING_NPM.length}건`
));

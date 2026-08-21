/* 파일 IO 관문 검사 — storage.js 밖에서 파일을 직접 만지지 않는가.
 *
 * 막는 사고
 *   CLAUDE.md 는 app/main/storage.js 를 "파일 IO 유일 관문"이라고 선언한다. 그런데 그 선언을
 *   지키는 검사가 없었다 — 선언은 문서에만 있고, 코드는 아무나 fs 를 열 수 있었다.
 *
 *   관문이 둘이 되면 무슨 일이 생기는가.
 *   (1) storage.writeJson 은 tmp 에 쓰고 renameSync 로 갈아 끼운다(같은 볼륨 rename 은 원자적).
 *       다른 모듈이 fs.writeFileSync 로 todos.json 을 직접 덮으면, 그 순간 전원이 나가거나
 *       프로세스가 죽으면 원장이 반쯤 쓰인 채 남는다 — 다음 부팅에서 JSON.parse 가 터지고
 *       사용자의 일정 전체가 사라진다.
 *   (2) 데이터 디렉터리는 TODO_DATA_DIR 로 주입한다(storage.dataDir()). 직접 fs 를 쓰는 코드는
 *       그 주입을 모른 채 %APPDATA%\TodoPopup 을 잡는다 — 시험과 CI 가 실사용 원장을 덮어쓴다.
 *   (3) 저장 실패는 storage 의 onSaveFailed 로 사용자에게 올라간다. 관문 밖의 쓰기는 조용히
 *       실패하고, 사용자는 며칠 뒤 "일정이 없어졌다"로 알게 된다 — 그때는 원인을 짚을 수 없다.
 *   (4) 창(renderer)이 fs 를 잡으려면 nodeIntegration 을 켜야 하고, 켜는 순간 창에 끼어든
 *       코드가 원장을 통째로 읽고 지운다.
 *   실제로 R4 에서 동기화 비밀번호를 app/main/sync/ 가 직접 fs 로 저장하려던 것을 storage 로
 *   되돌렸다(storage.js 의 "원격 동기화 비밀번호" 절). 그 결정을 문서가 아니라 검사로 굳힌다.
 *
 * 검사 밖인 곳과 그 근거 (앱 런타임이 아니다 — 이 프로세스에 로드되지 않는다)
 *   tools/        서버·유틸. tools/sync-server.mjs 는 아예 다른 프로세스(원격 저장소)로,
 *                 자기 원장을 자기가 연다. 이 앱의 storage 관문 대상이 아니다.
 *   app/scripts/  검사·스모크 스크립트. 소스를 읽는 것이 그 일이다(_load.mjs 가 fs 로 읽는다).
 *   app/test/     시험. mkdtempSync 로 임시 디렉터리를 직접 만들고 지운다 —
 *                 그게 실사용 원장을 건드리지 않는 방법이다.
 *   이 셋은 "빼 둔 예외"가 아니라 애초에 범위 밖이다. 그래서 app/ 아래에 새 디렉터리가
 *   생기면 아래 (0)번이 "범위에 넣을지 정하라"고 실패시킨다 — 조용히 안 보게 두지 않는다.
 */

import {
  ROOT_DIR, collect, read, rel, lineOf,
  stripCommentsAndStrings, scriptsOfHtml, diffBothWays, report, loadRegistry
} from './_load.mjs';

// ───────────────────────── 검사 범위 ─────────────────────────

// 앱 런타임 = electron 이 실제로 로드하는 코드.
const RUNTIME_PREFIXES = ['app/main/', 'app/renderer/', 'app/shared/'];
const RUNTIME_FILES = ['app/preload.js'];

// app/ 아래지만 런타임이 아닌 곳. 각 항목은 실제로 파일이 하나 이상 있어야 한다 —
// 없으면 근거가 사라진 죽은 제외라 아래 (0)번이 실패로 알린다.
const NOT_RUNTIME = [
  { prefix: 'app/scripts/', why: '검사·스모크 스크립트 — 소스를 읽는 것이 그 일이고 앱 프로세스에 로드되지 않는다' },
  { prefix: 'app/test/', why: '시험 — 임시 디렉터리를 직접 만들어 쓴다(실사용 원장을 피하는 방법이다)' }
];

// must:true = 이 확장자로 파일을 한 개도 못 읽으면 그 자체가 위반이다.
// (검사 범위가 조용히 비어 아무것도 안 보고도 초록이 뜨는 사고를 막는다.)
const SCAN_EXTS = [
  { ext: '.js', must: true, why: 'main·shared·preload 와 창 스크립트' },
  { ext: '.html', must: true, why: '창 문서 — <script> 안쪽도 런타임 코드다' },
  { ext: '.mjs', must: false, why: '런타임은 아직 CommonJS 다. 생기면 자동으로 대상이 된다' },
  { ext: '.cjs', must: false, why: '이 저장소엔 아직 없다' }
];
const EXT_LIST = SCAN_EXTS.map((e) => e.ext);

// 파일 IO 가 허용되는 유일한 관문. registry.ARCHITECTURE.files 의 '관문(파일 IO)' 계층과
// 아래 (3)번에서 양방향 대조한다 — 한쪽만 옮기면 이 lint 가 먼저 터진다.
// '/' 로 끝나면 디렉터리 전체, 아니면 파일 하나.
const FS_GATEWAYS = ['app/main/storage.js'];

// ───────────────────────── 패턴 ─────────────────────────

const FIX =
  '파일 IO 는 app/main/storage.js 하나만 합니다. 읽고 쓸 것이 생겼으면 storage.js 에 ' +
  'load<이름>()/save<이름>() 를 만들고(파일명은 registry 의 DATA_STORES 에 등록) 그것을 부르세요. ' +
  '창이라면 registry.IPC_CHANNELS 에 채널을 하나 등록해 main 을 경유합니다 — 창은 경로를 몰라야 합니다.';

// 모듈 지정자 — 검사 대상이 문자열 리터럴 자체라 keepStrings 로 읽는다.
const MODULE_RULES = [
  {
    what: "require('fs') / require('node:fs') / fs/promises",
    re: /require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]/g,
    fix: FIX
  },
  {
    // Electron 의 original-fs 는 asar 를 우회하는 무패치 fs 다. 이름만 다른 같은 문이다.
    what: "require('original-fs')",
    re: /require\s*\(\s*['"]original-fs['"]/g,
    fix: FIX
  },
  {
    what: "import('fs') 동적 로드",
    re: /import\s*\(\s*['"](?:node:)?(?:fs(?:\/promises)?|original-fs)['"]/g,
    fix: FIX
  },
  {
    what: "from 'node:fs' 정적 import",
    re: /from\s*['"](?:node:)?(?:fs(?:\/promises)?|original-fs)['"]/g,
    fix: FIX
  },
  {
    // 내부 우회로. 이걸 쓰는 코드는 "검사를 피하려고" 쓰는 것이다.
    what: "process.binding('fs')",
    re: /process\s*\.\s*binding\s*\(\s*['"]fs['"]/g,
    fix: FIX
  }
];

// 호출 패턴 — 주석·문자열을 지운 코드에서 찾는다(주석 속 설명이 잡히지 않게).
// fs 를 어디서 받아 왔든(구조분해·재수출·remote) 결국 이 이름들로 부른다.
const FS_CALLS = [
  'readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync', 'mkdirSync', 'mkdtempSync',
  'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'cpSync', 'readdirSync',
  'statSync', 'lstatSync', 'fstatSync', 'accessSync', 'openSync', 'closeSync', 'readSync',
  'writeSync', 'truncateSync', 'ftruncateSync', 'chmodSync', 'chownSync', 'utimesSync',
  'realpathSync', 'readlinkSync', 'symlinkSync', 'linkSync', 'opendirSync', 'globSync',
  'createReadStream', 'createWriteStream', 'watchFile', 'unwatchFile'
];

const CODE_RULES = [
  {
    what: 'fs.* 직접 호출',
    re: /(?<![A-Za-z0-9_$])fs\s*\.\s*[A-Za-z_$]/g,
    fix: FIX
  },
  {
    // 앞에 '.' 이 있으면 위 규칙이 이미 잡았거나 남의 객체 메서드다 — 중복 보고를 막는다.
    what: 'fs 함수 직접 호출',
    re: new RegExp('(?<![A-Za-z0-9_$.])(?:' + FS_CALLS.join('|') + ')\\s*\\(', 'g'),
    fix: FIX
  }
];

// ───────────────────────── 도우미 ─────────────────────────

function gatewayOf(path) {
  for (const g of FS_GATEWAYS) {
    if (g.endsWith('/') ? path.startsWith(g) : path === g) return g;
  }
  return null;
}

function scan(src, rules, out, path, raw) {
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src)) !== null) {
      out.push({ path: path, line: lineOf(raw, m.index), what: rule.what, fix: rule.fix });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
}

function scanFile(e, out) {
  const raw = read(e.file);
  // HTML 은 <script> 안쪽만 코드로 본다(줄 번호는 그대로 유지된다).
  const body = e.path.endsWith('.html') ? scriptsOfHtml(raw) : raw;
  scan(stripCommentsAndStrings(body), CODE_RULES, out, e.path, raw);
  scan(stripCommentsAndStrings(body, { keepStrings: true }), MODULE_RULES, out, e.path, raw);
}

// ───────────────────────── 본체 ─────────────────────────

const REG = await loadRegistry();
const problems = [];

const appFiles = collect(ROOT_DIR, EXT_LIST)
  .map((f) => ({ file: f, path: rel(f) }))
  .filter((e) => e.path.startsWith('app/'));

const isRuntime = (p) =>
  RUNTIME_PREFIXES.some((r) => p.startsWith(r)) || RUNTIME_FILES.includes(p);

const files = appFiles.filter((e) => isRuntime(e.path));

// ---- (0) 범위가 조용히 비거나 조용히 새지 않았는가 ----

// (0-a) must 인 확장자를 한 개도 못 읽었으면, 규칙이 몇 개든 그 영역은 "통과"가 아니라 "미검사"다.
const countByExt = {};
for (const e of files) {
  const ext = e.path.slice(e.path.lastIndexOf('.'));
  countByExt[ext] = (countByExt[ext] || 0) + 1;
}
for (const spec of SCAN_EXTS) {
  if (!spec.must || countByExt[spec.ext]) continue;
  problems.push(
    `app/scripts/lint-fs-gateway.mjs:1 — SCAN_EXTS 의 '${spec.ext}' 로 읽은 파일이 0개입니다(${spec.why}). ` +
    `검사 범위가 비었는데 초록불이 뜰 뻔했습니다 — RUNTIME_PREFIXES(${RUNTIME_PREFIXES.join(' · ')}) 를 확인하고, ` +
    `정말 그 확장자를 더는 쓰지 않게 됐다면 SCAN_EXTS 에서 그 줄을 빼세요.`);
}

// (0-b) app/ 아래 코드는 전부 "런타임"이거나 "런타임이 아님(근거 있음)" 둘 중 하나여야 한다.
// 새 디렉터리(app/workers/ 같은)가 생기면 여기서 걸려 결정을 강제한다 — 조용히 안 보게 두지 않는다.
for (const e of appFiles) {
  if (isRuntime(e.path)) continue;
  if (NOT_RUNTIME.some((n) => e.path.startsWith(n.prefix))) continue;
  problems.push(
    `${e.path}:1 — app/ 아래인데 이 검사의 범위 안팎 어디에도 적혀 있지 않습니다. ` +
    `electron 이 로드하는 코드면 app/scripts/lint-fs-gateway.mjs 의 RUNTIME_PREFIXES/RUNTIME_FILES 에 넣고, ` +
    `아니면 NOT_RUNTIME 에 근거(why)와 함께 적으세요.`);
}

// (0-c) 죽은 제외 — NOT_RUNTIME 이 가리키는 곳에 파일이 없으면 근거가 사라진 것이다.
for (const n of NOT_RUNTIME) {
  if (appFiles.some((e) => e.path.startsWith(n.prefix))) continue;
  problems.push(
    `app/scripts/lint-fs-gateway.mjs:1 — NOT_RUNTIME 의 '${n.prefix}' 에 해당하는 파일이 하나도 없습니다(${n.why}). ` +
    `NOT_RUNTIME 에서 그 줄을 빼세요(죽은 제외는 다음 사람의 근거가 됩니다).`);
}

// ---- (1) 관문 밖의 파일 IO = 위반 ----

const hits = [];
for (const e of files) scanFile(e, hits);

const liveGateways = new Set();
for (const h of hits) {
  const g = gatewayOf(h.path);
  if (g) { liveGateways.add(g); continue; }
  problems.push(`${h.path}:${h.line} — ${h.what}. 파일 IO 는 ${FS_GATEWAYS.join(' · ')} 밖에서 할 수 없습니다. ${h.fix}`);
}

// ---- (2) 관문은 열어 뒀는데 정작 파일 IO 가 없으면 허용 구멍만 남는다 ----

for (const g of FS_GATEWAYS) {
  const present = files.filter((e) => gatewayOf(e.path) === g);
  if (present.length === 0) {
    problems.push(
      `${g}:1 — 파일 IO 관문으로 선언된 ${g} 가 검사 범위에 없습니다(사라졌거나 이름이 바뀌었습니다). ` +
      `app/scripts/lint-fs-gateway.mjs 의 FS_GATEWAYS 와 app/shared/registry.js 의 ARCHITECTURE.files 를 함께 고치세요.`);
    continue;
  }
  if (liveGateways.has(g)) continue;
  problems.push(
    `${present[0].path}:1 — 파일 IO 관문 ${g} 에 fs 사용이 한 줄도 없습니다. ` +
    `저장 방식이 바뀌었다면 app/scripts/lint-fs-gateway.mjs 의 FS_GATEWAYS 와 ` +
    `app/shared/registry.js 의 ARCHITECTURE.files 에서 함께 빼세요(죽은 허용은 다음 사람의 근거가 됩니다).`);
}

// ---- (3) 허용 목록 ↔ 등록표 미러. 한쪽만 고치면 경계가 조용히 벌어진다 ----

const registered = (REG.ARCHITECTURE.files || [])
  .filter((f) => /파일 IO/.test(f.layer || ''))
  .map((f) => f.path);
for (const p of diffBothWays(
  'lint-fs-gateway.mjs 의 FS_GATEWAYS', FS_GATEWAYS,
  "registry.js 의 ARCHITECTURE.files '관문(파일 IO)' 계층", registered
)) {
  problems.push(p);
}

process.exit(report(
  'lint:fs-gateway',
  problems,
  `관문 밖 fs 사용 0건 — 런타임 ${files.length}개 파일` +
  `(${SCAN_EXTS.map((s) => s.ext + ' ' + (countByExt[s.ext] || 0)).join(' · ')}), ` +
  `허용 관문 ${FS_GATEWAYS.join(' · ')}`
));

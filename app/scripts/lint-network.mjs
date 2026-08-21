/* 폐쇄망 불변식 검사 — 동기화 모듈 밖에서 네트워크를 쓰지 않는가.
 *
 * 막는 사고
 *   이 앱은 인터넷이 막힌 사내 PC 에서 도는 로컬 우선 도구다. 창이든 main 모듈이든
 *   fetch/http/WebSocket 이 한 줄 섞이면 그 PC 에서는 응답 없이 타임아웃까지 창이 얼고,
 *   최악에는 일정 본문이 바깥으로 새어 나간다. 원격 저장은 기본 꺼짐 옵션이고, 켰을 때만
 *   로드되는 app/main/sync/ 와 서버 tools/sync-server.mjs 만 네트워크를 안다 — 그 경계를
 *   문서가 아니라 검사로 굳힌다. (관문 밖에서는 0 건이 정상이다.)
 *
 *   그리고 네트워크는 JS 로만 나가지 않는다. 스타일시트 한 줄이면 충분하다 —
 *   `@import url(https://…)` 나 @font-face 의 `src: url(https://fonts.gstatic.com/…)`,
 *   `background: url(http://…)` 는 창이 뜨는 순간 바깥으로 요청을 던진다. 폐쇄망에서는
 *   그 요청이 타임아웃까지 매달려 글꼴 없는 창이 몇 초씩 하얗게 떠 있고, 사내망 프록시가
 *   있으면 어떤 PC 가 언제 이 앱을 켰는지가 바깥 로그에 남는다.
 *   실제로 이 검사는 오랫동안 SCAN_EXTS 에 '.css' 가 없어서 app/renderer/common.css 를
 *   한 번도 열어 보지 않았다 — 그 구간에서 이 lint 의 초록불은 "css 를 검사했다"가 아니라
 *   "css 를 읽지 않았다"는 뜻이었다. 그래서 아래 SCAN_EXTS 는 확장자마다 must 를 달고,
 *   must 인 확장자에서 파일을 하나도 못 읽으면 그 자체를 실패로 보고한다
 *   (검사 범위가 조용히 비는 것을 검사가 스스로 잡는다).
 */

import {
  ROOT_DIR, collect, read, rel, lineOf,
  stripCommentsAndStrings, scriptsOfHtml, diffBothWays, report, loadRegistry
} from './_load.mjs';

// ───────────────────────── 검사 범위 ─────────────────────────

// 앱과 도구 전부. main·renderer·shared·preload·test 가 여기 다 들어온다.
// web/ 이 빠져 있었다 — 그래서 web/app.js 의 생짜 fetch( 를 이 검사가 **한 번도 열어 본 적이 없다**.
// 브라우저에서 도는 코드라고 해서 폐쇄망 불변식 밖인 것이 아니다. 그 화면도 이 저장소가 배포한다.
const SCAN_ROOTS = ['app/', 'tools/'];

// must:true = "이 확장자 파일을 한 개도 못 읽었다"는 것 자체가 위반이다.
// 범위가 조용히 비어 아무것도 검사하지 않는 초록불을 막는 장치다(머리주석 참고).
const SCAN_EXTS = [
  { ext: '.js', must: true, why: 'main·renderer·shared·preload' },
  { ext: '.mjs', must: true, why: 'tools/ 서버와 러너' },
  { ext: '.cjs', must: false, why: '이 저장소엔 아직 없다 — 생기면 자동으로 대상이 된다(없다고 실패시킬 근거는 없다)' },
  { ext: '.html', must: true, why: '창 문서 — <script> 코드와 <link>·<style> 의 원격 참조' },
  { ext: '.css', must: true, why: '스타일시트 — @import·url() 은 창이 뜨는 순간 바깥으로 나간다' }
];
const EXT_LIST = SCAN_EXTS.map((e) => e.ext);

// 네트워크가 허용되는 유일한 관문. registry.ARCHITECTURE.files 의 네트워크 계층과
// 아래에서 양방향 대조한다 — 한쪽만 옮기면 이 lint 가 먼저 터진다.
// '/' 로 끝나면 디렉터리 전체, 아니면 파일 하나.
//   app/main/calendars/ics-fetch-url.js  원격 ICS 를 받아 오는 자리. 디렉터리 전체가 아니라
//                        **파일 하나**다 — 같은 디렉터리의 ics-file.js(디스크의 .ics 읽기)와
//                        subscriptions.js(캐시·갱신 절차)에는 네트워크가 없어야 하고,
//                        디렉터리로 묶어 두면 거기 통신이 새로 들어와도 이 검사가 못 잡는다.
//   app/main/calendars/google-api.js · google-auth.js  구글 REST 와 OAuth.
//                        google.js(수명주기)는 여기 없다 — 조율만 하고 소켓은 이 둘이 연다.
//                        이 검사가 "죽은 허용" 으로 그 사실을 먼저 알려 줬다.
//   tools/web-server.mjs  웹 버전 서버. 브라우저를 받는 쪽이라 당연히 네트워크다.
//                         데스크톱 앱과 같은 프로세스가 아니다(옵션으로 따로 띄운다).
//   web/app.js            브라우저 화면이 우리 서버를 부르는 유일한 자리(api() 함수 하나).
//                         데스크톱이 window.api(IPC)로 하는 일을 여기서는 HTTP 로 한다 —
//                         관문이 하나라는 규약은 같다. 이 파일 밖에서 fetch 하면 이 검사가 잡는다.
// 관문이 없다 — 이 빌드에는 네트워크를 쓰는 자리가 한 곳도 없어야 한다.
const NETWORK_GATEWAYS = [];

// allowlist(예외) — 검사에서 통째로 빼는 자리. 늘리기 전에 두 번 생각할 것.
//   app/scripts/          lint 스크립트 자신들. 'XMLHttpRequest' 같은 API 이름을 검사 패턴으로
//                         품고 있어 자기 자신을 위반으로 잡는다. 앱과 함께 로드되지 않는
//                         개발 도구라 폐쇄망 불변식의 대상이 아니다(런타임에 존재하지 않는다).
//   app/test/sync*.test.js  동기화 시험. 실제 서버를 띄워 HTTP 로 왕복을 확인한다 —
//                         네트워크를 흉내 내면 계약이 갈라져도 초록이 뜨므로 진짜로 부른다.
//                         (sync-server.test.js 는 Host/Origin 문지기를 헤더 위조로 두드린다.
//                          핸들러를 직접 부르면 헤더 검사 자체를 건너뛴 채 초록이 뜬다.)
//                         시험 코드는 앱과 함께 배포되지 않는다.
// 아래 "유예가 낡았는가" 대조가 이 목록을 지킨다 — 파일이 사라졌거나 그 파일에
// 네트워크 코드가 한 줄도 없으면(= 예외의 근거가 사라졌으면) 실패로 알린다.
//   tools/cut/            통신 제거판 생성기와 그 산출물 템플릿. 무엇이 통신인지 **판정하는**
//                         쪽이라 금지 낱말을 패턴·문자열로 품는다(app/scripts/ 와 같은 이유).
//                         앱과 함께 로드되지 않고, 생성된 트리에는 이 디렉터리가 아예 없다.
const EXEMPT_PREFIXES = ['app/scripts/', 'tools/cut/'];
//   app/test/google-*.test.js  구글 어댑터 시험. 실제 구글에 붙지 않으려고 127.0.0.1 에
//                         모의 서버를 띄워 왕복한다 — 네트워크를 흉내 내면 "2초에 끊고
//                         재시도하지 않는다"는 계약을 확인할 수 없다(그것이 이 시험의 요점이다).
const EXEMPT_FILES = [
];

// ───────────────────────── 패턴 ─────────────────────────

const FIX_API =
  '네트워크는 app/main/sync/ (기본 꺼짐 옵션) 안에서만 씁니다. ' +
  '이 코드를 sync 모듈로 옮기고, 창·다른 main 모듈은 IPC 채널 sync-now / sync-status 로 부르세요.';

// 식별자 패턴 — 문자열·주석을 지운 코드에서 찾는다(안내 문구 속 예시가 잡히지 않게).
const CODE_RULES = [
  { what: 'fetch(', re: /(?<![A-Za-z0-9_$])fetch\s*\(/g, fix: FIX_API },
  { what: 'XMLHttpRequest', re: /(?<![A-Za-z0-9_$])XMLHttpRequest/g, fix: FIX_API },
  { what: 'new WebSocket(', re: /(?<![A-Za-z0-9_$])WebSocket\s*\(/g, fix: FIX_API },
  { what: 'EventSource(', re: /(?<![A-Za-z0-9_$])EventSource\s*\(/g, fix: FIX_API },
  { what: 'navigator.sendBeacon(', re: /\.\s*sendBeacon\s*\(/g, fix: FIX_API },
  { what: 'net.Socket / net.connect', re: /(?<![A-Za-z0-9_$])net\s*\.\s*(?:Socket|connect|createConnection|createServer)\s*\(/g, fix: FIX_API },
  { what: 'http(s).request / .get', re: /(?<![A-Za-z0-9_$])https?\s*\.\s*(?:request|get|createServer)\s*\(/g, fix: FIX_API }
];

// 모듈 지정자 패턴 — 검사 대상이 문자열 리터럴 자체라 keepStrings 로 읽는다.
const NET_MODULES = 'http|https|http2|net|tls|dgram|dns';
const MODULE_RULES = [
  {
    what: "require('http') 류 코어 모듈",
    re: new RegExp("require\\s*\\(\\s*['\"](?:node:)?(?:" + NET_MODULES + ")['\"]", 'g'),
    fix: FIX_API
  },
  {
    what: "import('http') 류 동적 로드",
    re: new RegExp("import\\s*\\(\\s*['\"](?:node:)?(?:" + NET_MODULES + ")(?:/[^'\"]*)?['\"]", 'g'),
    fix: FIX_API
  },
  {
    what: "from 'node:http' 류 정적 import",
    re: new RegExp("from\\s*['\"](?:node:)?(?:" + NET_MODULES + ")(?:/[^'\"]*)?['\"]", 'g'),
    fix: FIX_API
  },
  {
    // electron 의 net 모듈도 결국 HTTP 다. 구조분해와 프로퍼티 접근 둘 다 본다.
    what: "electron 의 net 모듈",
    re: /require\s*\(\s*['"]electron['"]\s*\)\s*\.\s*net(?![A-Za-z0-9_$])|\{[^}\n]*\bnet\b[^}\n]*\}\s*=\s*require\s*\(\s*['"]electron['"]\s*\)/g,
    fix: FIX_API
  }
];

// 창이 바깥 호스트에서 스크립트·스타일·글꼴·이미지를 끌어오는 것도 네트워크다.
// 폐쇄망에서는 그대로 로드 실패 → 빈 창이 뜨거나 타임아웃까지 얼어 있는다.
const FIX_ASSET =
  '창은 폐쇄망에서도 떠야 합니다. 그 파일을 app/assets 나 app/node_modules 에 두고 ' +
  '상대경로로 부르세요(작은 아이콘·글꼴은 data: URI 로 박아도 됩니다).';

const ASSET_RULES = [
  {
    // srcset·poster 도 같은 요청을 만든다. src 를 먼저 시도해도 정규식이 되돌아가 srcset 에 맞는다.
    what: '원격 자원 참조(src/srcset/href/poster)',
    re: /\b(?:src|srcset|href|poster)\s*=\s*["'](?:https?:)?\/\/[^"']*["']/gi,
    fix: FIX_ASSET
  }
];

// CSS 규칙. .css 파일과 HTML 의 <style>·style="" 양쪽에 같은 규칙을 건다.
// data: URI 와 상대경로는 바깥으로 나가지 않으므로 잡지 않는다 —
// 'https?://' 로 시작하거나 프로토콜 상대(//호스트/…)인 것만 위반이다.
const CSS_RULES = [
  {
    // url() 없이 문자열만 쓰는 형태: @import "https://…" / @import '//cdn…'
    // (url() 형태는 아래 규칙이 잡는다 — 두 번 보고되지 않도록 여기서는 url( 를 배제한다.)
    what: '@import 원격 스타일시트',
    re: /@import\s+["']?\s*(?:https?:)?\/\//gi,
    fix: FIX_ASSET,
    cssContext: true
  },
  {
    what: 'url(…) 원격 자원',
    re: /\burl\s*\(\s*["']?\s*(?:https?:)?\/\//gi,
    fix: FIX_ASSET,
    cssContext: true
  }
];

// ───────────────────────── 도우미 ─────────────────────────

function gatewayOf(path) {
  for (const g of NETWORK_GATEWAYS) {
    if (g.endsWith('/') ? path.startsWith(g) : path === g) return g;
  }
  return null;
}

/** HTML 주석을 줄 번호를 유지한 채 지운다(주석 처리해 둔 <script src> 가 잡히지 않게). */
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** <script> 안쪽만 지운다(길이·줄 번호 유지). CSS 규칙을 HTML 에 걸 때
 *  JS 문자열 속 'url(https://…)' 같은 예시가 CSS 위반으로 잡히지 않게 한다.
 *  (JS 코드의 진짜 네트워크 사용은 CODE_RULES·MODULE_RULES 가 따로 본다.) */
function stripHtmlScripts(src) {
  return src.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (m, open, body, close) => open + body.replace(/[^\n]/g, ' ') + close);
}

/** CSS 주석을 줄 번호를 유지한 채 지운다(주석에 적어 둔 예시 URL 은 요청을 만들지 않는다). */
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/* @namespace 의 URI 는 "네트워크 주소"가 아니라 이름표다 — 브라우저는 그것을 절대 받아오지
 * 않는다(`@namespace svg url(http://www.w3.org/2000/svg)`). 파일 단위 유예가 아니라
 * "그 선언 안에서만"이라는 문법 단위 예외라, 근거(그 URI 를 fetch 하지 않는다)가
 * 사라질 일이 없다. 판정은 앞선 구분자(; { })까지만 되짚어 그 선언문 안인지 본다. */
function inNamespaceAtRule(src, index) {
  let start = 0;
  for (let i = index; i >= 0; i--) {
    const c = src[i];
    if (c === ';' || c === '{' || c === '}') { start = i + 1; break; }
  }
  return /@namespace\b/i.test(src.slice(start, index));
}

function scan(src, rules, out, path, raw) {
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src)) !== null) {
      if (rule.cssContext && inNamespaceAtRule(src, m.index)) {
        if (m[0].length === 0) rule.re.lastIndex++;
        continue;
      }
      out.push({ path: path, line: lineOf(raw, m.index), what: rule.what, fix: rule.fix });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
}

// ───────────────────────── 본체 ─────────────────────────

const REG = await loadRegistry();
const problems = [];

const inScope = collect(ROOT_DIR, EXT_LIST)
  .map((f) => ({ file: f, path: rel(f) }))
  .filter((e) => SCAN_ROOTS.some((r) => e.path.startsWith(r)));

const isExempt = (p) => EXEMPT_PREFIXES.some((x) => p.startsWith(x)) || EXEMPT_FILES.includes(p);
const files = inScope.filter((e) => !isExempt(e.path));

// 방향 0: 검사 범위가 조용히 비지 않았는가. must 인 확장자를 한 개도 못 읽었다면
// 아래 규칙이 몇 개든 이 lint 는 그 영역을 통과시킨 것이 아니라 보지 않은 것이다.
//
// files(유예를 뺀 뒤)가 아니라 inScope(유예를 빼기 전)로 센다.
// "범위가 비었는가" 는 위반 여부가 아니라 **스캔이 거기까지 닿았는가** 를 묻는 질문이다.
// files 로 세면 그 확장자가 전부 유예 대상일 때 이 검사가 스스로 실패한다 —
// 실제로 그럴 뻔했다: tools/ 의 .mjs 둘이 사라지면 범위 내 .mjs 는 app/scripts/ 뿐인데
// 그것은 EXEMPT_PREFIXES 로 걸러진 뒤라 카운트가 0이 되어, 고칠 것이 없는 실패가 난다.
const countByExt = {};
for (const e of inScope) {
  const ext = e.path.slice(e.path.lastIndexOf('.'));
  countByExt[ext] = (countByExt[ext] || 0) + 1;
}
for (const spec of SCAN_EXTS) {
  if (!spec.must || countByExt[spec.ext]) continue;
  problems.push(
    `app/scripts/lint-network.mjs:1 — SCAN_EXTS 의 '${spec.ext}' 로 읽은 파일이 0개입니다(${spec.why}). ` +
    `검사 범위가 비었는데 초록불이 뜰 뻔했습니다 — SCAN_ROOTS(${SCAN_ROOTS.join(' · ')}) 경로를 확인하고, ` +
    `정말 그 확장자를 더는 쓰지 않게 됐다면 SCAN_EXTS 에서 그 줄을 빼세요.`);
}

function scanFile(e, out) {
  const raw = read(e.file);
  const isHtml = e.path.endsWith('.html');
  const isCss = e.path.endsWith('.css');

  if (isCss) {
    // .css 에는 실행 코드가 없다. 원격 참조만 본다.
    scan(stripCssComments(raw), CSS_RULES, out, e.path, raw);
    return;
  }

  // HTML 은 <script> 안쪽만 코드로 본다(줄 번호는 그대로 유지된다).
  const body = isHtml ? scriptsOfHtml(raw) : raw;
  scan(stripCommentsAndStrings(body), CODE_RULES, out, e.path, raw);
  scan(stripCommentsAndStrings(body, { keepStrings: true }), MODULE_RULES, out, e.path, raw);
  if (isHtml) {
    const markup = stripHtmlComments(raw);
    scan(markup, ASSET_RULES, out, e.path, raw);
    // <style> 블록과 style="" 속성도 스타일시트다 — <script> 안쪽만 지우고 CSS 규칙을 건다.
    scan(stripCssComments(stripHtmlScripts(markup)), CSS_RULES, out, e.path, raw);
  }
}

const hits = [];
for (const e of files) scanFile(e, hits);

// 방향 1: 관문 밖의 네트워크 사용 = 위반.
const liveGateways = new Set();
for (const h of hits) {
  const g = gatewayOf(h.path);
  if (g) { liveGateways.add(g); continue; }
  problems.push(`${h.path}:${h.line} — ${h.what} 사용. 폐쇄망 불변식 위반입니다. ${h.fix}`);
}

// 방향 2: 관문은 열어 뒀는데 정작 네트워크 코드가 없으면 허용 구멍만 남는다.
// 아직 만들어지지 않은 관문(R4 이전의 app/main/sync/)은 건너뛴다 — 파일이 있을 때만 따진다.
for (const g of NETWORK_GATEWAYS) {
  const present = files.filter((e) => gatewayOf(e.path) === g);
  if (present.length === 0) continue;
  if (liveGateways.has(g)) continue;
  problems.push(
    `${present[0].path}:1 — 네트워크 관문 ${g} 에 네트워크 코드가 한 줄도 없습니다. ` +
    `쓰지 않게 됐다면 app/scripts/lint-network.mjs 의 NETWORK_GATEWAYS 와 ` +
    `app/shared/registry.js 의 ARCHITECTURE.files 에서 함께 빼세요(죽은 허용은 다음 사람의 근거가 됩니다).`);
}

// 방향 3: 허용 목록 ↔ 등록표 미러. 한쪽만 고치면 경계가 조용히 벌어진다.
const registered = (REG.ARCHITECTURE.files || [])
  .filter((f) => /네트워크|원격 저장 서버/.test(f.layer || ''))
  .map((f) => f.path);
for (const p of diffBothWays(
  'lint-network.mjs 의 NETWORK_GATEWAYS', NETWORK_GATEWAYS,
  'registry.js 의 ARCHITECTURE.files 네트워크 계층', registered
)) {
  problems.push(p);
}

// 방향 4: 유예가 낡지 않았는가 (CLAUDE.md "유예(allowlist)는 방패가 아니다").
//   - 목록의 파일이 사라졌으면 그 예외는 다음 사람이 잘못 근거로 삼을 죽은 허용이다.
//   - 남아 있는데 네트워크 코드가 한 줄도 없으면 예외를 둘 이유 자체가 없어진 것이다.
for (const p of EXEMPT_FILES) {
  const e = inScope.find((x) => x.path === p);
  if (!e) {
    problems.push(
      `app/scripts/lint-network.mjs:1 — 유예 목록의 ${p} 가 검사 범위에 없습니다(사라졌거나 이름이 바뀌었습니다). ` +
      `EXEMPT_FILES 에서 빼거나 새 경로로 고치세요.`);
    continue;
  }
  const own = [];
  scanFile(e, own);
  if (own.length === 0) {
    problems.push(
      `${p}:1 — 유예해 둔 파일인데 네트워크 코드가 한 줄도 없습니다. 예외의 근거가 사라졌습니다 — ` +
      `app/scripts/lint-network.mjs 의 EXEMPT_FILES 에서 이 줄을 빼세요.`);
  }
}
for (const pre of EXEMPT_PREFIXES) {
  if (inScope.some((e) => e.path.startsWith(pre))) continue;
  problems.push(
    `app/scripts/lint-network.mjs:1 — 유예 접두사 '${pre}' 에 해당하는 파일이 하나도 없습니다. ` +
    `EXEMPT_PREFIXES 에서 빼세요(죽은 허용은 다음 사람의 근거가 됩니다).`);
}

process.exit(report(
  'lint:network',
  problems,
  `네트워크 API·원격 자원 0건 — 검사 ${files.length}개 파일` +
  `(${SCAN_EXTS.map((s) => s.ext + ' ' + (countByExt[s.ext] || 0)).join(' · ')}), ` +
  `허용 관문 ${NETWORK_GATEWAYS.join(' · ')}`
));

/* main ↔ renderer 경계와 preload 관문 검사.
 *
 * 왜 있는가 = 이 lint 가 막는 사고
 *   창 스크립트에 require('fs') 한 줄이 섞이면 그 창은 nodeIntegration 을 켜야 돌고, 켜는 순간
 *   창에 끼어든 코드가 %APPDATA%\TodoPopup 원장을 통째로 읽고 지운다. preload 가 channel 을
 *   검사 없이 넘기면(와일드카드 브리지) 등록표 allowlist 는 장식이 되고 오타 난 채널이 조용히 무시된다.
 *   반대로 main 에 document.* 가 들어가면 창이 하나도 없는 트레이 상주 구간에서 즉사하고,
 *   shared/ 가 electron·fs 를 require 하면 renderer 가 <script> 로 못 읽어 등록표 공유가 깨진다.
 */

import {
  APP_DIR, collect, read, rel, lineOf,
  stripCommentsAndStrings, scriptsOfHtml, diffBothWays, loadRegistry, report
} from './_load.mjs';

const RENDERER_DIR = APP_DIR + '/renderer';
const MAIN_DIR = APP_DIR + '/main';
const SHARED_DIR = APP_DIR + '/shared';
const PRELOAD = APP_DIR + '/preload.js';

const problems = [];
const REG = await loadRegistry();

// ───────────────────────── allowlist (의도된 예외) ─────────────────────────

/* shared/*.js 의 UMD 머리는 "브라우저인가 CommonJS인가"를 스스로 판별해야 한다.
 * 그 판별문(typeof self/window/module/global, root.X = …)은 경계 위반이 아니라
 * 경계를 지키려고 존재하는 코드다 — 그 줄에서만 전역 검사를 면제한다.
 * (본문에서 window.* 를 쓰면 여전히 걸린다. 면제는 '줄 단위'다.) */
const UMD_WRAPPER_LINE = /typeof\s+(?:self|window|module|global|exports)\b|^\s*(?:else\s+)?root\s*\./;

/* shared/ 는 데이터와 순수 함수만 두는 층이라 상대경로 require 만 허용한다.
 * registry.js → contracts.js 한 줄이 유일한 정상 경로다. */
const SHARED_RELATIVE_REQUIRE = /^\.\.?\//;

// ───────────────────────── (1) renderer: Node/Electron 직접 사용 금지 ─────────────────────────

const GATE_HINT = 'preload 관문(window.api.invoke / window.api.on)만 씁니다 — 채널은 app/shared/registry.js 의 IPC_CHANNELS 에 등록하세요.';

const RENDERER_FORBIDDEN = [
  { re: /\brequire\s*\(/g, what: 'require(', fix: '창에서 Node 모듈을 부르지 마세요. 필요한 값은 IPC 채널을 하나 등록해 main 에서 받아옵니다. ' + GATE_HINT },
  { re: /\bprocess\s*\./g, what: 'process.', fix: '프로세스 정보는 main 이 소유합니다. get-init 처럼 필요한 값만 실어 보내는 채널을 쓰세요.' },
  { re: /\b__dirname\b/g, what: '__dirname', fix: '경로 계산은 main(windows.js/storage.js)의 일입니다. 창은 경로를 몰라야 합니다.' },
  { re: /\b__filename\b/g, what: '__filename', fix: '경로 계산은 main(windows.js/storage.js)의 일입니다. 창은 경로를 몰라야 합니다.' },
  { re: /\bipcRenderer\b/g, what: 'ipcRenderer', fix: 'ipcRenderer 를 창이 직접 잡으면 등록표 allowlist 를 우회합니다. ' + GATE_HINT },
  { re: /\bcontextBridge\b/g, what: 'contextBridge', fix: 'contextBridge 는 app/preload.js 만 씁니다. 창은 노출된 window.api 만 소비합니다.' },
  { re: /\belectron\b/g, what: 'electron', fix: 'electron 모듈은 main·preload 전용입니다. ' + GATE_HINT }
];

for (const file of collect(RENDERER_DIR, ['.html', '.js'])) {
  const raw = read(file);
  // HTML 은 <script> 안쪽만 본다(줄 번호 유지). 속성·본문 텍스트가 위반으로 잡히는 걸 막는다.
  const scripted = file.endsWith('.html') ? scriptsOfHtml(raw) : raw;
  const code = stripCommentsAndStrings(scripted); // 주석·문자열 리터럴은 검사 대상이 아니다
  for (const rule of RENDERER_FORBIDDEN) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(code)) !== null) {
      problems.push(`${rel(file)}:${lineOf(code, m.index)} — 창 스크립트가 ${rule.what} 를 직접 씁니다. ${rule.fix}`);
    }
  }
  // main 으로 나가는 길은 window.api 하나뿐. 다른 invoke() 는 관문을 비켜간 것이다.
  const invokeRe = /\binvoke\s*\(/g;
  let hit;
  while ((hit = invokeRe.exec(code)) !== null) {
    const before = code.slice(Math.max(0, hit.index - 60), hit.index);
    if (!/api\s*\.\s*$/.test(before)) {
      problems.push(`${rel(file)}:${lineOf(code, hit.index)} — 관문을 거치지 않은 invoke() 입니다. window.api.invoke('<등록된 채널>', payload) 형태로 고치세요.`);
    }
  }
}

// ───────────────────────── (2) main: DOM 사용 금지 ─────────────────────────

const DOM_FORBIDDEN = [
  { re: /\bdocument\s*\./g, what: 'document.' },
  { re: /\bwindow\s*\./g, what: 'window.' },
  { re: /\blocalStorage\b/g, what: 'localStorage' },
  { re: /\bnavigator\s*\./g, what: 'navigator.' },
  { re: /\bquerySelector\b/g, what: 'querySelector' },
  { re: /\bgetElementById\b/g, what: 'getElementById' }
];

function scanDom(file, code, fix) {
  const lines = code.split('\n');
  for (const rule of DOM_FORBIDDEN) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(code)) !== null) {
      const line = lineOf(code, m.index);
      if (UMD_WRAPPER_LINE.test(lines[line - 1] || '')) continue; // UMD 판별문 면제
      problems.push(`${rel(file)}:${line} — ${rule.what} 는 창(renderer)의 것입니다. ${fix}`);
    }
  }
}

for (const file of collect(MAIN_DIR, ['.js'])) {
  scanDom(file, stripCommentsAndStrings(read(file)),
    'main 은 창이 하나도 없는 트레이 상주 상태로도 돌아야 합니다 — 화면 조작은 창에 데이터를 보내(webContents.send) 창이 하게 하세요.');
}

// ───────────────────────── (3) shared: 순수 유지(데이터 + 순수 함수만) ─────────────────────────

const SHARED_FORBIDDEN = [
  { re: /\bprocess\s*\./g, what: 'process.' },
  { re: /\b__dirname\b/g, what: '__dirname' },
  { re: /\b__filename\b/g, what: '__filename' }
];

for (const file of collect(SHARED_DIR, ['.js'])) {
  const src = read(file);
  const code = stripCommentsAndStrings(src);                       // 전역·DOM 검사용
  const withStr = stripCommentsAndStrings(src, { keepStrings: true }); // require 대상 문자열이 검사 대상이라 살려둔다
  const lines = code.split('\n');

  scanDom(file, code, 'shared 는 main 과 renderer 가 같은 파일을 읽습니다 — 한쪽 전용 전역을 쓰면 다른 쪽이 부팅에서 터집니다.');

  for (const rule of SHARED_FORBIDDEN) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(code)) !== null) {
      const line = lineOf(code, m.index);
      if (UMD_WRAPPER_LINE.test(lines[line - 1] || '')) continue;
      problems.push(`${rel(file)}:${line} — shared 는 Node 전역(${rule.what})을 모릅니다. 그 계산은 app/main/ 으로 옮기고 결과만 인자로 받으세요.`);
    }
  }

  const reqRe = /\brequire\s*\(([^)]*)\)/g;
  let r;
  while ((r = reqRe.exec(withStr)) !== null) {
    const line = lineOf(withStr, r.index);
    const lit = /^\s*['"]([^'"]+)['"]\s*$/.exec(r[1]);
    if (!lit) {
      problems.push(`${rel(file)}:${line} — shared 의 require 는 정적 상대경로 리터럴만 허용합니다(브라우저 <script> 로도 읽히는 파일이라 동적 로딩이 불가능합니다).`);
      continue;
    }
    if (!SHARED_RELATIVE_REQUIRE.test(lit[1])) {
      problems.push(`${rel(file)}:${line} — shared 가 '${lit[1]}' 를 require 합니다. 등록표는 데이터와 순수 함수만 둡니다(electron·fs·path·http 금지) — 그 코드는 app/main/ 으로 옮기고 shared 는 값만 넘겨받으세요.`);
    }
  }
}

// ───────────────────────── (4) preload: 등록표 기반 allowlist 관문 ─────────────────────────

const psrc = read(PRELOAD);
const Pn = stripCommentsAndStrings(psrc);                        // 구조(괄호) 해석용
const Ps = stripCommentsAndStrings(psrc, { keepStrings: true }); // 채널 리터럴 판별용 (같은 길이라 index 가 맞물린다)
const P_REL = rel(PRELOAD);

if (!/require\s*\(\s*['"][^'"]*registry\.js['"]\s*\)/.test(Ps)) {
  problems.push(`${P_REL}:1 — preload 가 등록표를 읽지 않습니다. require('./shared/registry.js') 로 IPC_CHANNELS 를 가져와 allowlist 를 만드세요.`);
}

// registry.channelKeys(kind) 로 만든 Set 만 '관문'으로 인정한다. 손으로 적은 배열은 등록표와 갈라진다.
const guardNames = [];
const guardKinds = [];
const guardByKind = {};
const setRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Set\s*\(([\s\S]*?)\)\s*;/g;
let s;
while ((s = setRe.exec(Ps)) !== null) {
  const inner = s[2];
  if (!/channelKeys\s*\(|IPC_CHANNELS/.test(inner)) continue;
  guardNames.push(s[1]);
  const k = /channelKeys\s*\(\s*['"]([a-z]+)['"]/.exec(inner) || /kind\s*===?\s*['"]([a-z]+)['"]/.exec(inner);
  if (k) { guardKinds.push(k[1]); guardByKind[k[1]] = s[1]; }
}

// ipcRenderer 메서드 → 그 호출이 통과해야 할 채널 kind (registry.IPC_KINDS 어휘)
function kindOfCall(method) {
  return (method === 'on' || method === 'once' || method === 'addListener') ? 'event' : 'invoke';
}

if (!guardNames.length) {
  problems.push(`${P_REL}:1 — 등록표에서 파생한 allowlist 가 없습니다. const INVOKE = new Set(REG.channelKeys('invoke')); 처럼 registry 에서 채널 목록을 만드세요(손으로 적은 배열은 등록표와 갈라집니다).`);
}

// 등록표의 kind ↔ preload 가 만든 관문 kind 를 양방향 대조.
// 한쪽에만 있으면: 새 kind 를 등록만 하고 관문을 안 만든 무검증 통과(회귀), 또는 죽은 관문.
const regKinds = [...new Set(REG.IPC_CHANNELS.map(c => c.kind))];
for (const p of diffBothWays('registry.IPC_CHANNELS 의 kind', regKinds, `${P_REL} 의 allowlist Set`, guardKinds)) {
  problems.push(`${P_REL} — ${p} (kind 마다 new Set(REG.channelKeys('<kind>')) 관문이 하나씩 있어야 합니다)`);
}

/** idx 를 감싸는 블록 `{` 위치. 가드가 같은 함수 안에 있는지 보려고 쓴다. */
function enclosingBlockStart(code, idx) {
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const c = code[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) return i; depth--; }
  }
  return 0;
}

/** openParenIdx 의 `(` 부터 첫 인자 텍스트를 뽑는다. */
function firstArg(code, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return code.slice(openParenIdx + 1, i); }
    else if (c === ',' && depth === 1) return code.slice(openParenIdx + 1, i);
  }
  return code.slice(openParenIdx + 1);
}

const callRe = /\bipcRenderer\s*\.\s*([\w$]+)\s*\(/g;
let call;
while ((call = callRe.exec(Pn)) !== null) {
  const method = call[1];
  const open = Pn.indexOf('(', call.index + call[0].length - 1);
  const argRaw = firstArg(Ps, open).trim();
  const line = lineOf(Pn, call.index);

  const isLiteral = /^['"]/.test(argRaw) || (/^`/.test(argRaw) && !argRaw.includes('${'));
  if (isLiteral) continue; // 고정 채널은 우회 통로가 아니다

  const id = (/^([A-Za-z_$][\w$]*)/.exec(argRaw) || [])[1];
  if (!id) {
    problems.push(`${P_REL}:${line} — ipcRenderer.${method}() 의 채널이 계산식입니다(${argRaw.slice(0, 30)}…). 어떤 채널이 나갈지 정적으로 알 수 없으면 allowlist 가 무의미합니다 — 인자로 받은 channel 을 그대로 검사하는 형태로 고치세요.`);
    continue;
  }

  const blockStart = enclosingBlockStart(Pn, call.index);
  const guardText = Pn.slice(blockStart, call.index);
  const gated = guardNames.some(g => new RegExp('\\b' + g + '\\s*\\.\\s*has\\s*\\(\\s*' + id + '\\b').test(guardText));
  const rejects = /\bthrow\b|\breject\s*\(|\breturn\b/.test(guardText);

  if (!gated || !rejects) {
    const kind = kindOfCall(method);
    const hint = guardByKind[kind] || `new Set(REG.channelKeys('${kind}'))`;
    problems.push(`${P_REL}:${line} — ipcRenderer.${method}(${id}, …) 가 무검증 통과입니다(와일드카드 브리지 회귀). 호출 바로 앞에 if (!${hint}.has(${id})) { throw/reject } 를 두어 등록표(kind:${kind})에 없는 채널을 막으세요.`);
  }
}

// 노출 객체 안에서 ipcRenderer·require·process 를 '값 그대로' 넘기면 관문이 통째로 새어 나간다.
// (ipcRenderer.invoke 처럼 뒤에 . 가 붙는 메서드 호출은 관문 안쪽 사용이라 허용한다.)
const exposeIdx = Pn.indexOf('exposeInMainWorld');
if (exposeIdx < 0) {
  problems.push(`${P_REL}:1 — contextBridge.exposeInMainWorld('api', …) 가 없습니다. 창이 main 에 닿는 유일한 문을 여기서 만들어야 합니다.`);
} else {
  const open = Pn.indexOf('(', exposeIdx);
  let depth = 0, end = Pn.length;
  for (let i = open; i < Pn.length; i++) {
    const c = Pn[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  const region = Pn.slice(open, end);
  const leakRe = /\b(ipcRenderer|require|process|Buffer|module|globalThis)\b(?!\s*\.)/g;
  let leak;
  while ((leak = leakRe.exec(region)) !== null) {
    problems.push(`${P_REL}:${lineOf(Pn, open + leak.index)} — 노출 객체가 ${leak[1]} 를 값 그대로 넘깁니다. 창이 그 객체를 잡으면 allowlist 전체가 무력화됩니다 — 채널을 검사하는 래퍼 함수만 노출하세요.`);
  }
}

// ───────────────────────── (5) 창 생성 시 preload 우회 금지 ─────────────────────────

const UNSAFE_WEBPREFS = [
  { re: /\bnodeIntegration\s*:\s*true\b/g, fix: 'nodeIntegration: false 로 두세요 — 켜는 순간 창이 fs 를 직접 잡습니다.' },
  { re: /\bcontextIsolation\s*:\s*false\b/g, fix: 'contextIsolation: true 로 두세요 — 끄면 창 스크립트가 preload 의 내부를 덮어쓸 수 있습니다.' },
  { re: /\bwebSecurity\s*:\s*false\b/g, fix: 'webSecurity 는 끄지 마세요.' },
  { re: /\benableRemoteModule\s*:\s*true\b/g, fix: 'remote 모듈은 관문을 통째로 우회합니다 — 필요한 동작은 IPC 채널로 등록하세요.' }
];

for (const file of collect(MAIN_DIR, ['.js'])) {
  const code = stripCommentsAndStrings(read(file));
  if (!/\bnew\s+BrowserWindow\s*\(/.test(code)) continue;

  for (const rule of UNSAFE_WEBPREFS) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(code)) !== null) {
      problems.push(`${rel(file)}:${lineOf(code, m.index)} — 창 보안 설정이 관문을 우회합니다. ${rule.fix}`);
    }
  }

  const winRe = /\bnew\s+BrowserWindow\s*\(/g;
  let w;
  while ((w = winRe.exec(code)) !== null) {
    const arg = firstArg(code, code.indexOf('(', w.index + w[0].length - 1));
    if (!/\bwebPreferences\b/.test(arg)) {
      problems.push(`${rel(file)}:${lineOf(code, w.index)} — new BrowserWindow 에 webPreferences 가 없습니다. { preload, contextIsolation: true, nodeIntegration: false } 를 붙이세요 — 없으면 그 창은 window.api 없이 뜨고 모든 IPC 가 죽습니다.`);
    }
  }
  if (!/\bpreload\s*:/.test(code)) {
    problems.push(`${rel(file)}:1 — BrowserWindow 를 만드는 파일인데 preload 지정이 없습니다. app/preload.js 를 preload 로 붙여야 창이 등록표 allowlist 를 통과해 main 에 닿습니다.`);
  }
  if (!/\bcontextIsolation\s*:\s*true\b/.test(code) || !/\bnodeIntegration\s*:\s*false\b/.test(code)) {
    problems.push(`${rel(file)}:1 — BrowserWindow 를 만드는 파일에 contextIsolation: true / nodeIntegration: false 가 명시돼 있지 않습니다. 기본값에 기대지 말고 webPreferences 에 적어 두세요(Electron 기본값이 바뀌면 조용히 뚫립니다).`);
  }
}

process.exit(report('lint:boundary', problems, 'renderer 는 window.api 관문만, main 은 DOM 없이, shared 는 순수하게, preload 는 등록표 allowlist 로 채널을 막는다'));

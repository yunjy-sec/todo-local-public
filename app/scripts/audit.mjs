#!/usr/bin/env node
'use strict';

/* 로컬 전용 빌드 감사 — 감사관이 한 줄로 돌리는 것.
 *
 *   npm run audit
 *
 * 이 스크립트가 하는 일은 셋이다.
 *   1) 트리 전체를 훑어 통신의 흔적을 센다. **찾은 명령을 함께 인쇄한다** —
 *      감사관이 손으로 다시 쳐서 같은 0 이 나오는지 확인할 수 있어야 한다.
 *   2) 0 이 아닌 것을 **우리가 먼저 신고한다**. "전부 0" 이라고만 말하면 반례 하나에
 *      전체가 무너진다. 목록 밖의 히트를 감사관이 못 찾는 것이 목록이 정직하다는 증거다.
 *   3) 정적 검사만으로는 증명이 안 되므로, 이 트리의 검사·시험을 함께 돌린 결과를 나란히 놓는다.
 *
 * 이 파일 자신이 금지 낱말을 패턴으로 품는다. 그것을 숨기지 않는다 — 문자코드 배열 같은
 * 회피는 감사관이 가장 싫어하는 형태다. 트리에서 그 낱말이 나오는 파일은 정확히 둘이고
 * (이 스크립트와 lint-network.mjs), 둘 다 그 낱말을 **금지하는** 쪽이다.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'data']);
// 동봉 배포물에만 있는 자리. Chromium 런타임은 감사 범위 밖으로 **먼저 신고**하고
// 무결성은 해시로 보인다(app/vendor/MANIFEST.json) — 텍스트로 훑는 대상이 아니다.
// 같은 vendor 아래의 fullcalendar 는 훑는다(우리가 화면에 로드하는 코드다).
const SKIP_PREFIX = ['app/vendor/electron/'];
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.yml', '.yaml',
  '.bat', '.cmd', '.cs', '.ps1', '.manifest', '.ics', '.txt', '']);

// 우리가 먼저 신고하는 자리. 여기 없는 히트가 하나라도 나오면 감사는 실패다.
// (근거가 사라지면 검사가 실패하도록 — 목록의 파일이 없어도 실패시킨다.)
const DECLARED = [
  {
    path: 'app/scripts/lint-network.mjs',
    why: '네트워크 낱말을 **금지하는** 검사 자신. 패턴으로 품고 있어 스스로 걸린다.',
  },
  {
    path: 'app/scripts/audit.mjs',
    why: '이 감사 스크립트 자신. 같은 이유다.',
  },
  {
    path: 'app.manifest',
    why: 'xmlns="http://schemas.microsoft.com/…" — XML 이름표다. 요청을 만들지 않는다.',
  },
  {
    path: 'app/scripts/check-ui.mjs',
    why: '창 스모크 도구. 우리 앱의 창을 조종하려고 127.0.0.1 루프백 디버그 채널을 쓴다 — ' +
      '바깥으로 나가지 않고, 개발 도구라 배포 산출물(.gitattributes export-ignore)에 들어가지 않는다.',
  },
];

const RULES = [
  { what: "코어 모듈 require('http'…)", re: /require\(\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]\s*\)/g },
  { what: "ESM import 'node:http'…", re: /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/g },
  { what: 'fetch( · XMLHttpRequest · WebSocket( · EventSource(', re: /(?<![A-Za-z0-9_$.])(?:fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\()/g },
  { what: '스킴 URL 리터럴 (http · ws · ftp · webcal)', re: /(?:https?|wss?|ftp|webcal):\/\//gi },
  { what: '프로토콜 상대 URL (//host)', re: /(?<![A-Za-z0-9_$:/])\/\/[a-z0-9-]+\.[a-z]{2,}\//gi },
  // 어휘 규칙은 **코드에만** 건다. 무엇을 왜 제거했는지 설명하는 문서에는 그 낱말이
  // 당연히 나온다 — 산문에 나온 낱말은 통신 능력이 아니다. 문서에도 URL 규칙은 그대로 걸린다.
  { what: 'OAuth·구글 어휘 (코드)', codeOnly: true, re: /\b(?:oauth|googleapis|apps\.googleusercontent|client_secret|access_token|refresh_token)\b/gi },
  { what: 'electron 통신 심볼', re: /\b(?:crashReporter|autoUpdater|setProxy|openExternal|webSecurity\s*:\s*false|allowRunningInsecureContent)\b/g },
  { what: '프록시 설정', re: /\b(?:HTTPS?_PROXY|NO_PROXY|ALL_PROXY|setGlobalDispatcher|socks5?)\b/g },
];

// 감사관이 직접 다시 칠 수 있는 명령. 우리 스크립트를 믿지 않아도 되게 한다.
const RAW_COMMANDS = [
  `rg -n --hidden -g '!node_modules' -g '!.git' "require\\((['\\"])(node:)?(http|https|http2|net|tls|dgram|dns)\\1\\)" .`,
  `rg -n --hidden -g '!node_modules' -g '!.git' "fetch\\(|XMLHttpRequest|WebSocket\\(|EventSource\\(" .`,
  `rg -n --hidden -g '!node_modules' -g '!.git' "(https?|wss?|webcal)://" .`,
  `rg -n --hidden -g '!node_modules' -g '!.git' "oauth|googleapis|client_secret|crashReporter|autoUpdater" .`,
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) { walk(p, out); continue; }
    if (!TEXT_EXT.has(extname(name).toLowerCase())) continue;
    const rp = relative(ROOT, p).split(sep).join('/');
    if (SKIP_PREFIX.some(x => rp.startsWith(x))) continue;
    out.push({ path: rp, size: st.size });
  }
  return out;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

const files = walk(ROOT, []);
const declaredPaths = new Set(DECLARED.map(d => d.path));
const hitsByRule = new Map(RULES.map(r => [r.what, []]));
let declaredHits = 0;

for (const f of files) {
  let text;
  try { text = readFileSync(join(ROOT, f.path.split('/').join(sep)), 'utf8'); } catch (e) { continue; }
  const isCode = /\.(js|mjs|cjs|html)$/i.test(f.path);
  for (const rule of RULES) {
    if (rule.codeOnly && !isCode) continue;
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      if (declaredPaths.has(f.path)) { declaredHits++; continue; }
      hitsByRule.get(rule.what).push(`${f.path}:${lineOf(text, m.index)}  ${m[0].slice(0, 60)}`);
    }
  }
}

// 신고해 둔 자리가 사라졌으면 그 신고는 죽은 근거다 — 다음 사람이 잘못 믿는다.
const stale = DECLARED.filter(d => !existsSync(join(ROOT, d.path.split('/').join(sep))));

const total = [...hitsByRule.values()].reduce((n, a) => n + a.length, 0);
const bytes = files.reduce((n, f) => n + f.size, 0);

const bar = '─'.repeat(66);
console.log('TodoPopup — 로컬 전용 빌드 감사');
console.log(bar);
console.log(`[0] 트리       텍스트 파일 ${files.length}개 · ${(bytes / 1024).toFixed(0)}KB`);
console.log(`               (node_modules · data · .git 제외 — [범위 밖] 참조)`);
console.log('[1] 통신 흔적  아래 규칙으로 트리 전체를 훑었습니다');
for (const rule of RULES) {
  const hits = hitsByRule.get(rule.what);
  const mark = hits.length ? 'FAIL' : '  0 ';
  console.log(`    ${mark}  ${rule.what}`);
  for (const h of hits.slice(0, 8)) console.log(`          ${h}`);
  if (hits.length > 8) console.log(`          … 그 밖 ${hits.length - 8}건`);
}
console.log('[2] 같은 것을 직접 확인하시려면 (우리 스크립트를 거치지 않습니다)');
for (const c of RAW_COMMANDS) console.log('    ' + c);
console.log(`[3] 먼저 신고합니다 — 위 규칙에 걸리지만 통신이 아닌 자리 ${declaredHits}건`);
for (const d of DECLARED) console.log(`    ${d.path}\n        ${d.why}`);

let failed = total > 0 || stale.length > 0;
for (const s of stale) {
  console.log(`    FAIL  신고 목록의 ${s.path} 가 트리에 없습니다 — 죽은 근거입니다. audit.mjs 에서 빼세요.`);
}

/** 동봉 배포물이면 그 사실과 무결성 목록을 함께 보고한다. */
function vendorReport() {
  const mf = join(ROOT, 'app', 'vendor', 'MANIFEST.json');
  if (!existsSync(mf)) {
    console.log('  app/vendor/ 없음 — 소스 배포입니다(런타임은 별도로 준비하십시오).');
    return;
  }
  let m;
  try { m = JSON.parse(readFileSync(mf, 'utf8')); } catch (e) { console.log('  MANIFEST.json 을 읽지 못했습니다'); return; }
  const bytes = (m.files || []).reduce((n, f) => n + (f.size || 0), 0);
  console.log(`  app/vendor/electron/ — Chromium 런타임 ${(m.files || []).length}개 파일 · ` +
    `${(bytes / 1024 / 1024).toFixed(0)}MB. 네트워크 스택이 바이너리에 링크되어 있어 코드로`);
  console.log('      제거할 수 없습니다. 감사 범위 밖으로 합의된 부분이며, 모든 파일의 sha256 이');
  console.log('      app/vendor/MANIFEST.json 에 있습니다. 실행 중 관측은 docs/AUDIT.md 절차를 따르십시오.');
  for (const p of (m.patches || [])) {
    console.log(`  ${p.file} — 동봉하며 패치했습니다: ${(p.changes || []).join(' · ')}`);
  }
}

// 검사는 npm 을 거치지 않고 **지금 이 인터프리터로** 직접 돌린다.
// 동봉 배포물에는 Node.js 도 npm 도 없다(런타임은 app/vendor/electron 하나뿐이고,
// audit.bat 이 그것을 Node 로 써서 이 스크립트를 부른다). npm 을 부르면 그 자리에서 멈춘다.
const steps = [
  ['문법', [join(APP, 'scripts', 'check-syntax.mjs')]],
  ['가드레일', [join(APP, 'scripts', 'lint-all.mjs')]],
  ['단위·회귀', ['--test', join(APP, 'test')]],
];
for (const [label, args] of steps) {
  process.stdout.write(`[4] ${label.padEnd(8)} … `);
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    });
    const last = out.trim().split('
').filter(l => l.trim()).pop() || '';
    console.log('OK  ' + last.trim().slice(0, 90));
  } catch (e) {
    failed = true;
    console.log('FAIL');
    console.log(((e.stdout || '') + (e.stderr || '')).split('
').slice(-12).join('
'));
  }
}
console.log('[5] 창 스모크   npm run check:ui — 실제 창을 띄웁니다(별도로 실행하세요)');
console.log(bar);
console.log('범위 밖(우리가 먼저 신고합니다):');
console.log('  app/node_modules/  — electron 런타임(Chromium). 네트워크 스택이 바이너리에');
console.log('      링크되어 있어 코드로 제거할 수 없습니다. 이 빌드의 앱 코드는 그것을');
console.log('      부르지 않으며, 실행 중 관측은 docs/AUDIT.md 의 절차를 따르십시오.');
console.log('  UNC 경로(\\\\서버\\공유\\*.ics) — 파일 경로로 취급합니다. SMB 는 OS 가 처리하며');
console.log('      이 코드는 소켓을 열지 않습니다. docs/AUDIT.md 참조.');
console.log(bar);
console.log('판정: ' + (failed ? 'FAIL' : 'PASS'));
process.exit(failed ? 1 : 0);

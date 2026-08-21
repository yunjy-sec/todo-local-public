#!/usr/bin/env node
'use strict';

/* 통신 제거판을 **의존성까지 동봉한** 배포물로 묶는다.
 *
 * 왜 필요한가
 *   todo-local 은 소스만으로는 못 돈다 — Electron 런타임이 있어야 캘린더 창이 뜬다.
 *   그런데 그 런타임을 받는 것(npm install)이 곧 네트워크다. 폐쇄망에 들고 들어가려면
 *   바깥에서 한 번 묶어서 통째로 반입해야 한다. 이 스크립트가 그 묶음을 만든다.
 *   (Node.js 조차 없는 PC 를 위한 길은 따로 있다 — start-todo.bat 이 윈도우 내장
 *    csc.exe 로 TodoPopup.exe 를 만든다. 그쪽은 캘린더 창이 없다.)
 *
 * 무엇을 동봉하는가 — 런타임에 실제로 쓰는 것만
 *   app/vendor/electron/dist/   Electron 런타임(Chromium). 감사 범위 밖으로 먼저 신고한다.
 *   app/vendor/fullcalendar/    창이 <script> 로 부르는 번들 **두 개**뿐.
 *   나머지 node_modules 15개(undici · @electron/get · semver …)는 설치 시점 전용이라
 *   런타임에 한 줄도 안 쓴다. @electron/get 은 HTTP(S)_PROXY 를 읽는 코드까지 들고 있어
 *   동봉하면 감사 기준이 문자로 금지한 "프록시 설정"이 배포물에 들어간다.
 *
 * 무결성
 *   동봉한 모든 파일의 sha256 을 app/vendor/MANIFEST.json 에 적는다. 감사관이 대조할 수 있고,
 *   다음 빌드에서 입력이 바뀌면 여기서 먼저 드러난다.
 *
 * 실행: node tools/pack/pack.mjs [--out <dir>] [--zip]
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync,
  writeFileSync, rmSync,
} from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');                 // todo
const LOCAL = resolve(SRC, '..', 'todo-local');        // 생성된 통신 제거판
const NM = join(SRC, 'app', 'node_modules');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = resolve(outArg >= 0 && argv[outArg + 1] ? argv[outArg + 1] : join(SRC, 'dist', 'TodoPopup-local'));

// 동봉 대상. scan:true 는 감사에서 텍스트를 훑는다. false 면 사유를 반드시 적는다.
const VENDOR = [
  {
    from: join(NM, 'fullcalendar', 'index.global.min.js'),
    to: 'app/vendor/fullcalendar/index.global.min.js',
    scan: true,
    patch: patchFullCalendar,
  },
  {
    from: join(NM, '@fullcalendar', 'core', 'locales', 'ko.global.js'),
    to: 'app/vendor/fullcalendar/ko.global.js',
    scan: true,
  },
];

/**
 * fullcalendar 번들에서 나가는 길 하나를 막는다.
 *
 * 이 번들에는 fetch( 가 다섯 번 나오는데 **진짜 네트워크 호출은 하나**다 —
 * json-feed 이벤트 소스(`events: 'https://…'`)가 쓰는 자리. 나머지 넷은 객체 리터럴의
 * 메서드 정의(fetch(e,t){…})와 그 호출이라 네트워크와 무관하다.
 * 이 앱은 events 를 **함수**로 넘기므로 json-feed 경로를 애초에 타지 않는다 — 기능 손실 0.
 * 그래도 코드를 남겨 두면 감사관의 grep 에 잡히고, 설정 한 줄로 되살아날 수 있다.
 */
function patchFullCalendar(text) {
  const out = [];
  let t = text;

  const call = 'fetch(t,r).then(';
  if (!t.includes(call)) throw new Error('fullcalendar: json-feed 호출부를 못 찾았습니다 — 번들이 바뀌었습니다');
  t = t.replace(call,
    'Promise.reject(new Error("network is removed from this build")).then(');
  out.push('json-feed fetch 호출부를 거부 프로미스로 대체');

  // 오류 메시지 안의 문서 주소. 요청을 만들지는 않지만 감사 grep 에 잡힌다.
  const doc = 'https://fullcalendar.io/docs/initialize-globals';
  if (t.includes(doc)) {
    t = t.split(doc).join('(see FullCalendar docs)');
    out.push('문서 주소 리터럴 제거');
  }
  // http://www.w3.org/2000/svg 은 **그대로 둔다** — createElementNS 의 이름표라
  // 바꾸면 SVG 가 안 그려진다. 감사 신고 목록에 적는다.
  return { text: t, notes: out };
}

// ───────────────────────── 도구 ─────────────────────────

const SKIP = new Set(['.git', 'node_modules', 'data', 'dist']);

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (SKIP.has(name)) continue;
    const s = join(from, name);
    const d = join(to, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

function copyAll(from, to) { // vendor 는 무엇도 빼지 않는다
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const s = join(from, name);
    const d = join(to, name);
    if (statSync(s).isDirectory()) copyAll(s, d);
    else copyFileSync(s, d);
  }
}

function sha256(p) {
  return 'sha256:' + createHash('sha256').update(readFileSync(p)).digest('hex');
}

function walk(dir, base, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

function edit(p, from, to) {
  const full = join(OUT, p.split('/').join(sep));
  const t = readFileSync(full, 'utf8');
  if (!t.includes(from)) throw new Error(`${p}: 바꿀 문자열을 못 찾았습니다 — ${JSON.stringify(from.slice(0, 60))}`);
  writeFileSync(full, t.split(from).join(to), 'utf8');
}

// ───────────────────────── 본체 ─────────────────────────

if (!existsSync(LOCAL)) {
  console.error('통신 제거판이 없습니다: ' + LOCAL + '\n  먼저 `npm run cut` 을 실행하세요.');
  process.exit(1);
}
if (!existsSync(NM)) {
  console.error('상류에 app/node_modules 가 없습니다 — 여기서 동봉할 런타임을 가져옵니다.');
  process.exit(1);
}

// 생성물이 지금 소스와 일치하는지 먼저 확인한다. 낡은 트리를 묶어서 반입하면
// 폐쇄망 안에서 그것을 고칠 방법이 없다.
try {
  execFileSync(process.execPath, [join(SRC, 'tools', 'cut', 'cut.mjs'), '--check', '--no-verify'],
    { cwd: SRC, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error('통신 제거판이 지금 소스와 다릅니다. `npm run cut` 으로 다시 생성한 뒤 묶으세요.\n');
  console.error((e.stdout || '') + (e.stderr || ''));
  process.exit(1);
}

console.log('  묶는 중: ' + OUT);
rmSync(OUT, { recursive: true, force: true });
copyTree(LOCAL, OUT);

// 1) Electron 런타임
const elFrom = join(NM, 'electron', 'dist');
const elTo = join(OUT, 'app', 'vendor', 'electron');
copyAll(elFrom, elTo);
console.log('  electron 런타임 동봉');

// 2) 창이 부르는 번들 둘
const notes = [];
for (const v of VENDOR) {
  if (!existsSync(v.from)) throw new Error('동봉할 파일이 없습니다: ' + v.from);
  const dst = join(OUT, v.to.split('/').join(sep));
  mkdirSync(dirname(dst), { recursive: true });
  if (v.patch) {
    const r = v.patch(readFileSync(v.from, 'utf8'));
    writeFileSync(dst, r.text, 'utf8');
    notes.push({ file: v.to, input: sha256(v.from), changes: r.notes });
  } else {
    copyFileSync(v.from, dst);
  }
}
console.log('  fullcalendar 번들 2개 동봉(패치 적용)');

// 3) 창이 vendor 를 보게 한다
edit('app/renderer/calendar.html',
  '<script src="../node_modules/fullcalendar/index.global.min.js"></script>',
  '<script src="../vendor/fullcalendar/index.global.min.js"></script>');
edit('app/renderer/calendar.html',
  '<script src="../node_modules/@fullcalendar/core/locales/ko.global.js"></script>',
  '<script src="../vendor/fullcalendar/ko.global.js"></script>');

// 4) 런처가 동봉 런타임을 쓰게 한다
edit('start-todo.bat',
  'set "ELECTRON=%APP%\\node_modules\\electron\\dist\\electron.exe"',
  'set "ELECTRON=%APP%\\vendor\\electron\\electron.exe"');

// 5) 무결성 목록
const vendorRoot = join(OUT, 'app', 'vendor');
const files = walk(vendorRoot, vendorRoot).sort();
const manifest = {
  note: '동봉한 런타임의 무결성 목록. 감사관이 sha256 을 대조할 수 있습니다.',
  builtFrom: {
    todo: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SRC, encoding: 'utf8' }).trim(),
    todoLocal: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: LOCAL, encoding: 'utf8' }).trim(),
  },
  scanned: {
    note: '감사 스크립트가 텍스트를 훑는 대상',
    files: VENDOR.map(v => v.to),
  },
  outOfScope: {
    note: 'Chromium 런타임. 네트워크 스택이 바이너리에 링크되어 있어 코드로 제거할 수 없습니다. '
      + '감사 범위 밖으로 합의된 부분이며, 실행 중 관측 절차는 docs/AUDIT.md 에 있습니다.',
    prefix: 'electron/',
  },
  patches: notes,
  files: files.map(f => ({ path: f, sha256: sha256(join(vendorRoot, f.split('/').join(sep))), size: statSync(join(vendorRoot, f.split('/').join(sep))).size })),
};
writeFileSync(join(vendorRoot, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

const total = manifest.files.reduce((n, f) => n + f.size, 0);
console.log(`  MANIFEST.json — 파일 ${manifest.files.length}개 · ${(total / 1024 / 1024).toFixed(0)}MB`);

if (argv.includes('--zip')) {
  const zip = OUT + '.zip';
  rmSync(zip, { force: true });
  console.log('  압축 중…');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('  ' + zip + ' — ' + (statSync(zip).size / 1024 / 1024).toFixed(0) + 'MB');
}

console.log('\n  됐습니다. 폐쇄망 PC 에 통째로 복사하고 start-todo.bat 을 실행하세요.');
console.log('  검증: cd app && npm run audit   (감사 보고서)');

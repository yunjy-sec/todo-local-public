/* 검사 스크립트 공용 유틸.
 *
 * 왜 있는가
 *   lint 마다 파일 읽기·주석 제거·양방향 대조·보고 형식을 따로 쓰면
 *   메시지 모양이 제각각이 되고, 무엇보다 "한쪽에만 있는 것"을 한 방향만 보게 된다.
 *   단방향 검사는 "코드에 있는데 등록 안 함"만 잡고 "등록했는데 코드에서 사라짐"은 놓친다.
 *   후자는 죽은 등록으로 남아 다음 사람이 그것을 근거로 코드를 쓴다.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = join(SCRIPTS_DIR, '..');
export const ROOT_DIR = join(APP_DIR, '..');

/** 등록표·계약은 CommonJS UMD 라 그냥 import 하면 된다(브라우저도 같은 파일을 읽는다). */
export async function loadRegistry() {
  const mod = await import(pathToUrl(join(APP_DIR, 'shared', 'registry.js')));
  return mod.default || mod;
}

export async function loadContracts() {
  const mod = await import(pathToUrl(join(APP_DIR, 'shared', 'contracts.js')));
  return mod.default || mod;
}

function pathToUrl(p) {
  return 'file:///' + p.split(sep).join('/');
}

/** 확장자로 파일을 재귀 수집. node_modules·.git·.claude 는 건너뛴다.
 *
 * .claude 를 왜 빼는가 — 그 아래 worktrees/ 에 같은 저장소의 다른 체크아웃이 생긴다.
 * 그것까지 훑으면 검사가 **배포되지 않는 사본**을 보고 실패한다. 실제로 그랬다:
 * 워크트리가 하나 생기자마자 lint:csharp5 가 "디스크의 .cs 에만 있음"으로 9건을 냈는데,
 * build.cmd 가 컴파일하는 것은 저장소 본체의 src/ 뿐이라 고칠 것이 없는 실패였다.
 */
export function collect(dir, exts, skip = []) {
  const out = [];
  const skipNames = new Set(['node_modules', '.git', '.claude', 'dist', ...skip]);
  (function walk(d) {
    let entries;
    try { entries = readdirSync(d); } catch (e) { return; }
    for (const name of entries) {
      if (skipNames.has(name)) continue;
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) walk(full);
      else if (exts.some(x => name.endsWith(x))) out.push(full);
    }
  })(dir);
  return out;
}

export function read(file) {
  return readFileSync(file, 'utf8');
}

export function rel(file) {
  return relative(ROOT_DIR, file).split(sep).join('/');
}

/** 줄 번호를 유지한 채 주석과 문자열 리터럴을 지운다.
 *  (주석 안의 예시 코드나 설명 문장이 위반으로 잡히는 거짓 경보를 막는다.) */
export function stripCommentsAndStrings(src, { keepStrings = false } = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  let quote = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += keepStrings ? c : ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    // str
    if (c === '\\') { out += keepStrings ? src.slice(i, i + 2) : '  '; i += 2; continue; }
    if (c === quote) { state = 'code'; out += keepStrings ? c : ' '; i++; continue; }
    out += keepStrings ? c : (c === '\n' ? '\n' : ' ');
    i++;
  }
  return out;
}

/** HTML 파일에서 <script> 안쪽만 뽑는다(줄 번호 유지). */
export function scriptsOfHtml(src) {
  let out = '';
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    out += blankify(src.slice(last, m.index + m[0].indexOf('>') + 1));
    out += m[1];
    last = m.index + m[0].length - '</script>'.length;
  }
  out += blankify(src.slice(last));
  return out;
}

function blankify(s) {
  return s.replace(/[^\n]/g, ' ');
}

export function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/** 한쪽에만 있는 것을 양방향으로 보고한다. */
export function diffBothWays(aName, a, bName, b) {
  const problems = [];
  const sa = new Set(a);
  const sb = new Set(b);
  for (const k of sa) if (!sb.has(k)) problems.push(`${aName} 에만 있음: ${k} — ${bName} 에 넣거나 ${aName} 에서 빼세요.`);
  for (const k of sb) if (!sa.has(k)) problems.push(`${bName} 에만 있음: ${k} — ${aName} 에 넣거나 ${bName} 에서 빼세요.`);
  return problems;
}

/** 모든 lint 의 공통 종료 형식. 실패 메시지에는 고칠 자리가 들어 있어야 한다. */
export function report(name, problems, okMessage) {
  if (!problems || problems.length === 0) {
    console.log(`  ok   ${name} — ${okMessage}`);
    return 0;
  }
  console.error(`  FAIL ${name}`);
  for (const p of problems) console.error(`       ${p}`);
  return 1;
}

/* 설정 필드가 등록표(SETTINGS_FIELDS)와 설정 화면에서 갈라지는 것을 막는다.
 *
 * 막는 사고
 *   등록표에 필드를 넣고 패널에 컨트롤을 안 붙이면 사용자는 그 설정을 영원히 못 바꾼다(죽은 등록).
 *   반대로 패널이 등록에 없는 키를 save-settings 로 보내면 clampSettings 가 그 키를 통째로 버려서
 *   "저장을 눌렀는데 아무 일도 안 일어나는" 침묵 실패가 된다(에러도 로그도 없다).
 *   패널 input 의 min/max·select option 이 등록표와 어긋나면 UI 가 받아준 값을 저장이 조용히 깎는다.
 *   그리고 clampSettings 에 손으로 쓴 필드 분기가 남으면 새 필드는 정규화에서 빠진다.
 */

import {
  APP_DIR, loadRegistry, read, rel, lineOf,
  scriptsOfHtml, stripCommentsAndStrings, diffBothWays, report
} from './_load.mjs';

const LIST = APP_DIR + '/renderer/list.html';
const STORAGE = APP_DIR + '/main/storage.js';
const REGISTRY = APP_DIR + '/shared/registry.js';

// ───────────────────────── allowlist (의도된 예외) ─────────────────────────

// R4(원격 저장 옵션)에서 설정 패널에 붙일 필드. 등록·저장·동기화 클라이언트는 이미 이 키로 돌고,
// UI 만 R4 에서 온다(docs/ARCHITECTURE.md §4 "설정 섹션 원격 동기화", §6 R4).
// R4 가 패널을 붙이면 아래 STALE 검사가 "이제 UI 에 있으니 이 목록에서 빼라"고 실패시킨다.
// R4 에서 원격 동기화 UI 가 설정 패널에 붙어 유예가 비었다.
// (등록만 해 두고 화면은 다음 라운드에 붙일 때만 여기에 넣는다. 화면이 생기면 이 검사가 실패해
//  유예를 걷어내게 만든다 — 유예가 방패로 굳지 않게.)
const PENDING_UI_R4 = [];

// 설정 패널이 아니라 목록 창 본체가 다루는 필드. 패널 밖이지만 죽은 등록은 아니다.
//   listSortAsc — 푸터의 정렬 토글 버튼(btnSort)이 직접 save-settings 로 보낸다(ui: 'toggle').
// 아래 OUTSIDE_PANEL 검사가 "list.html 이 실제로 이 키를 다루는가"를 확인하므로 방패로 쓰이지 않는다.
const OUTSIDE_PANEL = ['listSortAsc'];

// collectSettings 는 보내는데 openSettings 는 채우지 않는 필드.
//   showClosed — 값의 주인이 푸터 체크박스(chkClosed)라 창 부팅 때 한 번 채우고,
//                패널 저장은 그 체크박스의 현재 값을 그대로 함께 보낸다.
const COLLECT_ONLY = ['showClosed'];

// ───────────────────────── 파서 (의존성 0) ─────────────────────────

/** 이름으로 함수 본문의 { } 구간을 찾는다. 주석·문자열이 지워진 소스에 쓴다(중괄호 오인 방지). */
function bodyOf(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index + m[0].length);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      return { head: m.index, start, end: i + 1, text: src.slice(start, i + 1) };
    }
  }
  return null;
}

/** src[braceIdx] 가 '{' 인 객체 리터럴의 최상위 키만 모은다(중첩 호출·배열 안은 건너뛴다). */
function objectKeys(src, braceIdx) {
  const out = [];
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) break; continue; }
    if (depth !== 1 || !/[A-Za-z_$]/.test(c)) continue;
    let prev = i - 1;
    while (prev >= braceIdx && /\s/.test(src[prev])) prev--;
    const p = src[prev];
    let j = i;
    while (j < src.length && /[\w$]/.test(src[j])) j++;
    let k = j;
    while (k < src.length && /\s/.test(src[k])) k++;
    // 키 자리: 바로 앞이 '{' 또는 ',' 이고 뒤가 ':'(명시) 또는 ','·'}'(단축 표기)
    if ((p === '{' || p === ',') && (src[k] === ':' || src[k] === ',' || src[k] === '}')) {
      out.push({ key: src.slice(i, j), index: i });
    }
    i = j - 1;
  }
  return out;
}

function attrOf(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(tag);
  return m ? m[1] : null;
}

function tagById(html, id) {
  const m = new RegExp('<(?:input|select|textarea)\\b[^>]*\\bid="' + id + '"[^>]*>', 'i').exec(html);
  return m ? { text: m[0], line: lineOf(html, m.index) } : null;
}

// ───────────────────────── 수집 ─────────────────────────

const REG = await loadRegistry();
const problems = [];

const regSrc = read(REGISTRY);
const regLine = lineOf(regSrc, Math.max(0, regSrc.indexOf('var SETTINGS_FIELDS')));
const fieldByKey = new Map(REG.SETTINGS_FIELDS.map(f => [f.key, f]));
const regKeys = REG.SETTINGS_FIELDS.map(f => f.key);

const html = read(LIST);
// <script> 안쪽만, 줄 번호를 유지한 채. 두 판본은 길이가 같아 인덱스가 서로·원본과 정렬된다.
const scripts = scriptsOfHtml(html);
const code = stripCommentsAndStrings(scripts);                        // 구조(중괄호) 해석용
const codeStr = stripCommentsAndStrings(scripts, { keepStrings: true }); // DOM id·채널명 해석용

const collect = bodyOf(code, 'collectSettings');
const open = bodyOf(code, 'openSettings');

const collectLoc = collect ? rel(LIST) + ':' + lineOf(code, collect.head) : rel(LIST) + ':?';
const openLoc = open ? rel(LIST) + ':' + lineOf(code, open.head) : rel(LIST) + ':?';

let collectKeys = [];
let fillKeys = [];
const idOfKey = new Map(); // 설정 key → 패널 DOM id (openSettings 가 채우는 자리에서 파생)

if (!collect) {
  problems.push(`${rel(LIST)}: collectSettings() 함수를 찾지 못했습니다 — 이름을 바꿨다면 lint-settings.mjs 의 bodyOf 호출도 함께 고치세요.`);
} else {
  const r = /return\s*\{/.exec(collect.text);
  if (!r) {
    problems.push(`${collectLoc}: collectSettings 가 객체 리터럴을 곧바로 return 하지 않습니다 — 이 lint 가 보내는 키를 읽을 수 없습니다. return { ... } 형태를 유지하세요.`);
  } else {
    const brace = collect.start + r.index + r[0].length - 1;
    collectKeys = objectKeys(code, brace).map(k => ({ key: k.key, line: lineOf(code, k.index) }));
  }
}

if (!open) {
  problems.push(`${rel(LIST)}: openSettings() 함수를 찾지 못했습니다 — 이름을 바꿨다면 lint-settings.mjs 의 bodyOf 호출도 함께 고치세요.`);
} else {
  const seen = new Set();
  const reRead = /\b(?:s|settings)\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = reRead.exec(open.text)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    fillKeys.push({ key: m[1], line: lineOf(code, open.start + m.index) });
  }
  // "$('sW').value = s.popupWidth" 같은 대입에서 DOM id ↔ 설정 key 다리를 뽑는다.
  const openStr = codeStr.slice(open.start, open.end);
  const reBind = /\$\(\s*'([^']+)'\s*\)\s*\.\s*(?:value|checked)\s*=\s*([^;]*)/g;
  while ((m = reBind.exec(openStr)) !== null) {
    const k = /\b(?:s|settings)\.([A-Za-z_$][\w$]*)/.exec(m[2]);
    if (k && !idOfKey.has(k[1])) idOfKey.set(k[1], { id: m[1], line: lineOf(code, open.start + m.index) });
  }
}

// ───────────────────────── 1. 등록표 ↔ 설정 패널 (양방향) ─────────────────────────

const panelKeys = Array.from(new Set(collectKeys.concat(fillKeys).map(x => x.key)));
const panelSide = new Set(panelKeys);
const regSide = regKeys.filter(k => !PENDING_UI_R4.includes(k) && !OUTSIDE_PANEL.includes(k));

for (const p of diffBothWays(
  `registry.SETTINGS_FIELDS (${rel(REGISTRY)}:${regLine})`, regSide,
  `list.html 설정 패널 (${collectLoc} collectSettings / ${openLoc} openSettings)`, panelKeys
)) problems.push(p);

// 등록에 없는 키를 패널이 만들어 보내면 저장이 조용히 버린다 — 정확한 줄로 다시 짚는다.
for (const c of collectKeys) {
  if (!fieldByKey.has(c.key)) {
    problems.push(`${rel(LIST)}:${c.line} collectSettings 가 보내는 '${c.key}' 는 등록되지 않았습니다 — ${rel(REGISTRY)}:${regLine} SETTINGS_FIELDS 에 행을 추가하거나 이 키를 지우세요(clampSettings 가 미등록 키를 버립니다).`);
  }
}
for (const f of fillKeys) {
  if (!fieldByKey.has(f.key)) {
    problems.push(`${rel(LIST)}:${f.line} openSettings 가 읽는 settings.${f.key} 는 등록되지 않았습니다 — 항상 undefined 입니다. ${rel(REGISTRY)}:${regLine} SETTINGS_FIELDS 에 넣거나 이 줄을 지우세요.`);
  }
}

// ───────────────────────── 2. allowlist 가 낡지 않았는가 ─────────────────────────

const listCode = code; // 목록 창 전체 스크립트
for (const k of PENDING_UI_R4) {
  if (panelSide.has(k)) {
    problems.push(`${rel(LIST)}: '${k}' 가 이제 설정 패널에 있습니다 — R4 가 도착했으니 ${rel(APP_DIR + '/scripts/lint-settings.mjs')} 의 PENDING_UI_R4 에서 빼세요.`);
  }
  if (!fieldByKey.has(k)) {
    problems.push(`lint-settings.mjs PENDING_UI_R4 의 '${k}' 가 ${rel(REGISTRY)}:${regLine} SETTINGS_FIELDS 에 없습니다 — 등록이 사라졌으면 이 예외도 지우세요.`);
  }
}
for (const k of OUTSIDE_PANEL) {
  if (panelSide.has(k)) {
    problems.push(`${rel(LIST)}: '${k}' 가 설정 패널로 들어왔습니다 — lint-settings.mjs 의 OUTSIDE_PANEL 에서 빼세요(예외가 필요 없어졌습니다).`);
  } else if (!new RegExp('\\b' + k + '\\b').test(listCode)) {
    problems.push(`${rel(LIST)}: '${k}' 를 다루는 코드가 목록 창에 없습니다 — 패널 밖 예외(OUTSIDE_PANEL)로 둔 근거가 사라졌으니 UI 를 붙이거나 ${rel(REGISTRY)}:${regLine} 등록을 지우세요.`);
  }
}
for (const k of COLLECT_ONLY) {
  if (fillKeys.some(f => f.key === k)) {
    problems.push(`${openLoc}: openSettings 가 '${k}' 를 채우게 됐습니다 — lint-settings.mjs 의 COLLECT_ONLY 예외를 지우세요.`);
  }
}

// ───────────────────────── 3. 패널 안 양방향: 보내는 값 ↔ 열 때 채우는 값 ─────────────────────────
// 채우지 않고 보내기만 하면 패널을 여는 순간 그 컨트롤의 빈 값이 저장을 덮어쓴다.

for (const p of diffBothWays(
  // 미등록 키는 위 1번이 이미 정확히 짚었으므로 여기서 두 번 말하지 않는다.
  `collectSettings 가 보내는 필드 (${collectLoc})`, collectKeys.map(x => x.key).filter(k => fieldByKey.has(k) && !COLLECT_ONLY.includes(k)),
  `openSettings 가 채우는 필드 (${openLoc})`, fillKeys.map(x => x.key).filter(k => fieldByKey.has(k))
)) problems.push(p);

// ───────────────────────── 4. 컨트롤의 범위·선택지가 등록표와 같은가 ─────────────────────────

for (const [key, bind] of idOfKey) {
  const f = fieldByKey.get(key);
  if (!f) continue;
  const tag = tagById(html, bind.id);
  if (!tag) {
    problems.push(`${rel(LIST)}:${bind.line} openSettings 가 채우는 #${bind.id} 엘리먼트가 설정 패널 마크업에 없습니다 — id 를 맞추거나 컨트롤을 추가하세요.`);
    continue;
  }
  const where = `${rel(LIST)}:${tag.line}`;
  if (f.type === 'int' || f.type === 'ratio') {
    // ratio 컨트롤은 퍼센트(0.3~1 → 30~100)로 그린다. 두 표기 모두 허용하고 어긋날 때만 잡는다.
    const want = f.type === 'ratio'
      ? { min: [f.min, f.min * 100], max: [f.max, f.max * 100] }
      : { min: [f.min], max: [f.max] };
    for (const which of ['min', 'max']) {
      const raw = attrOf(tag.text, which);
      if (raw === null) {
        problems.push(`${where} #${bind.id}(${key}): ${which} 속성이 없습니다 — 등록표(${rel(REGISTRY)}:${regLine})의 ${which}=${f[which]} 를 ${which}="${want[which][want[which].length - 1]}" 로 넣으세요(없으면 UI 가 받아준 값을 저장이 조용히 깎습니다).`);
        continue;
      }
      const n = parseFloat(raw);
      if (!want[which].some(v => Math.abs(v - n) < 1e-9)) {
        problems.push(`${where} #${bind.id}(${key}): ${which}="${raw}" 가 등록표와 다릅니다 — ${rel(REGISTRY)}:${regLine} 의 ${which}=${f[which]} 에 맞춰 ${which}="${want[which][want[which].length - 1]}" 로 고치세요.`);
      }
    }
  }
  if (f.type === 'enum') {
    const sel = new RegExp('<select\\b[^>]*\\bid="' + bind.id + '"[^>]*>([\\s\\S]*?)</select>', 'i').exec(html);
    if (!sel) {
      problems.push(`${where} #${bind.id}(${key}): enum 필드인데 <select> 가 아닙니다 — 등록된 값(${f.values.join(', ')})만 고르게 하려면 select 로 그리세요.`);
    } else {
      const opts = [];
      const reOpt = /<option\b[^>]*\bvalue="([^"]*)"/gi;
      let om;
      while ((om = reOpt.exec(sel[1])) !== null) opts.push(om[1]);
      for (const p of diffBothWays(
        `SETTINGS_FIELDS.${key}.values (${rel(REGISTRY)}:${regLine})`, f.values,
        `#${bind.id} 의 <option value> (${rel(LIST)}:${lineOf(html, sel.index)})`, opts
      )) problems.push(p);
    }
  }
}

// 등록된 필드가 패널에 있는데 어떤 컨트롤에도 안 묶였으면 openSettings 가 값을 못 채운다.
for (const k of panelKeys) {
  if (!fieldByKey.has(k) || COLLECT_ONLY.includes(k) || idOfKey.has(k)) continue;
  const f = fieldByKey.get(k);
  if (f.ui === 'select' && f.type === 'string') continue; // 목록을 코드가 만드는 select(기본 캘린더 등)
  problems.push(`${openLoc}: '${k}' 를 채우는 "$('…').value|checked = s.${k}" 대입이 없습니다 — 컨트롤에 값을 채우거나 collectSettings 에서 빼세요(패널을 열면 빈 값이 저장을 덮어씁니다).`);
}

// ───────────────────────── 5. save-settings 로 나가는 부분 패치 키 ─────────────────────────

const reSave = /invoke\(\s*'save-settings'\s*,\s*\{/g;
let sm;
while ((sm = reSave.exec(codeStr)) !== null) {
  const brace = sm.index + sm[0].length - 1;
  for (const k of objectKeys(code, brace)) {
    if (!fieldByKey.has(k.key)) {
      problems.push(`${rel(LIST)}:${lineOf(code, k.index)} save-settings 로 보내는 '${k.key}' 가 등록되지 않았습니다 — ${rel(REGISTRY)}:${regLine} SETTINGS_FIELDS 에 넣으세요(미등록 키는 clampSettings 가 버립니다).`);
    }
  }
}

// ───────────────────────── 6. clampSettings 가 등록표에서 파생되는가 ─────────────────────────

const stSrc = read(STORAGE);
const st = stripCommentsAndStrings(stSrc);
const stStr = stripCommentsAndStrings(stSrc, { keepStrings: true });
const clamp = bodyOf(st, 'clampSettings');

if (!clamp) {
  problems.push(`${rel(STORAGE)}: clampSettings() 를 찾지 못했습니다 — 설정 정규화가 사라졌거나 이름이 바뀌었습니다. 등록표를 순회하는 clampSettings 를 유지하세요.`);
} else {
  const clampLine = lineOf(st, clamp.head);
  if (!/REG\.SETTINGS_FIELDS/.test(clamp.text) || !/\bfor\b|forEach/.test(clamp.text)) {
    problems.push(`${rel(STORAGE)}:${clampLine} clampSettings 가 REG.SETTINGS_FIELDS 를 순회하지 않습니다 — 필드를 추가해도 정규화에서 빠집니다. "for (const f of REG.SETTINGS_FIELDS)" 로 파생시키세요.`);
  }
  const clampStr = stStr.slice(clamp.start, clamp.end);
  for (const k of regKeys) {
    const hit = new RegExp('\\b' + k + '\\b').exec(clampStr);
    if (hit) {
      problems.push(`${rel(STORAGE)}:${lineOf(stStr, clamp.start + hit.index)} clampSettings 안에 '${k}' 가 손으로 박혀 있습니다 — 필드별 분기를 지우고 f.type/f.min/f.max/f.def 로만 처리하세요(하드코딩된 분기는 새 필드를 놓칩니다).`);
    }
  }
}
if (!/REG\.settingsDefaults\(\)/.test(st)) {
  problems.push(`${rel(STORAGE)}: 기본 설정이 REG.settingsDefaults() 에서 나오지 않습니다 — storage 가 기본값을 두 벌 들고 있으면 등록표와 갈라집니다.`);
}

process.exit(report(
  'lint:settings',
  problems,
  `설정 필드 ${regKeys.length}개 ↔ 패널 ${panelKeys.length}개 1:1 (R4 대기 ${PENDING_UI_R4.length}, 패널 밖 ${OUTSIDE_PANEL.length}), min/max·enum 선택지·clampSettings 파생 확인`
));

/* lint:private-fields — extendedProperties.private 에 미등록 키를 쓰지 못하게 한다.
 *
 * 왜 있는가 (이 lint 가 막는 사고)
 *   private 키는 todos.json 에 그 이름 그대로 저장되고 구글 캘린더 왕복에도 그대로 실린다.
 *   등록표에 없는 키를 하나 쓰기 시작하면 그 값은 이 앱에서만 보이고, 구글에서 돌아온
 *   이벤트에는 없어서 완료·스누즈·알림횟수가 조용히 초기화된다(사용자는 알림이 되살아나야
 *   비로소 안다). 반대로 등록만 남고 아무도 안 쓰는 키는 다음 사람이 그걸 근거로 코드를 써서
 *   이미 죽은 데이터를 읽게 만든다. 그래서 등록↔사용을 양방향으로 결박한다.
 *   회차 상태(instanceState) 안의 키도 같은 어휘여야 한다 — 단일 일정은 private 최상위에,
 *   반복 회차는 instanceState JSON 안에 같은 이름으로 저장되므로 한쪽만 바뀌면 회차 상태가 샌다.
 */

import {
  APP_DIR, ROOT_DIR, collect, read, rel, lineOf,
  stripCommentsAndStrings, scriptsOfHtml, diffBothWays, report, loadRegistry
} from './_load.mjs';

// ───────────────────────── 검사 범위 ─────────────────────────

/* 범위는 "디렉터리 + 코드 확장자 전부"로 잡는다. 파일 목록을 손으로 적지 않는다 —
 * collect() 가 재귀로 훑으므로 새 파일(app/main/sync/ 처럼 새로 생긴 하위 디렉터리 포함)은
 * 저절로 들어온다.
 *
 * 이 상수가 막는 사고 (R? 리뷰에서 실제로 발견된 구멍)
 *   예전에는 renderer 를 .html 로만 훑었다. 창 스크립트를 <script> 인라인에서 별도 .js 로 빼는 것은
 *   흔한 리팩터링인데(파일이 커지면 누구나 한다), 그 순간 그 코드는 이 검사에서 통째로 사라진다.
 *   그러면 창이 미등록 private 키를 읽고 쓰기 시작해도 lint 는 계속 초록이고,
 *   사고는 구글 캘린더 왕복에서 값이 사라진 뒤에야 드러난다.
 *   검사가 "위반 없음"과 "아무것도 안 봄"을 같은 초록으로 보고하면 안 된다 —
 *   그래서 아래 EMPTY 검사가 범위가 비면 실패시킨다. */
const SCRIPT_EXTS = ['.js', '.mjs', '.cjs'];

const SCAN = [
  // model.priv() 를 거치는 주 대상. 하위 디렉터리(sync/)까지 재귀로 들어간다.
  { dir: APP_DIR + '/main', exts: SCRIPT_EXTS },
  // contracts.validateEvent 가 private 을 직접 읽는다
  { dir: APP_DIR + '/shared', exts: SCRIPT_EXTS },
  // 창은 원래 private 을 몰라야 한다 — 손대면 여기서 걸린다.
  // 인라인 <script> 든 밖으로 뺀 .js 든 똑같이 본다(sourceOf 가 .html 만 <script> 안쪽을 뽑는다).
  { dir: APP_DIR + '/renderer', exts: ['.html', ...SCRIPT_EXTS] }
];
const EXTRA_FILES = [APP_DIR + '/preload.js'];

/* 검사에서 빼는 곳 (allowlist — 무력화가 아니라 소유권이 다른 자리다)
 *   app/test/    구글이 준 미지 필드가 왕복에서 보존되는지 시험하려면 남의 private 키를
 *                일부러 픽스처에 넣어야 한다. 그 시험을 이 lint 가 막으면 안 된다.
 *   app/scripts/ lint 자신. 검사 패턴 문자열이 검사 대상이 되면 자기 자신을 잡는다.
 */

// priv() 결과에 바로 붙는 접근을 알아보는 함수 이름들.
// 'P' 는 아직 코드에 없지만(레포 전체 검색 0건) 짧은 별칭을 만들 자리로 미리 잡아 둔다 —
// 나중에 누가 P() 로 감싸도 이 lint 를 빠져나가지 못한다.
const ACCESSORS = ['priv', 'P'];

const REGISTRY_FILE = APP_DIR + '/shared/registry.js';
const MODEL_FILE = APP_DIR + '/main/model.js';
const SELF_FILE = APP_DIR + '/scripts/lint-private-fields.mjs';
const INSTANCE_STATE_KEY = 'instanceState';

// ───────────────────────── 소스 유틸 ─────────────────────────

function matchBrace(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return code.length;
}

function matchParen(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return code.length;
}

/** idx 이후 처음으로 닫히는 바깥 블록의 끝 = 그 선언이 살아 있는 범위의 끝. */
function blockEndFrom(code, idx) {
  let depth = 0;
  for (let i = idx; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { if (depth === 0) return i; depth--; }
  }
  return code.length;
}

/** idx 를 감싸는 블록 [시작, 끝]. 없으면 파일 전체. */
function enclosingBlock(code, idx) {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    if (code[i] === '}') depth++;
    else if (code[i] === '{') { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start < 0) return [0, code.length];
  return [start, matchBrace(code, start)];
}

/** 최상위(괄호 밖) 구분자로만 자른다. */
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === sep && depth === 0) { out.push(text.slice(last, i)); last = i + 1; }
  }
  out.push(text.slice(last));
  return out;
}

function indexOfTop(text, ch) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/** 객체 리터럴 본문에서 최상위 키 목록. 읽을 수 없는 자리(전개·계산 키)는 따로 돌려준다. */
function objectKeys(body) {
  const keys = [];
  const opaque = [];
  for (const seg of splitTop(body, ',')) {
    const s = seg.trim();
    if (!s) continue;
    const ci = indexOfTop(s, ':');
    const head = (ci < 0 ? s : s.slice(0, ci)).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(head)) keys.push(head);
    else opaque.push(s.slice(0, 30));
  }
  return { keys, opaque };
}

/** .html 은 <script> 안쪽만, 그 외는 통째로. 주석·문자열을 지운 판과 문자열을 남긴 판을 함께 준다.
 *  (두 판은 길이·줄 번호·인덱스가 완전히 같다 — 같은 위치를 두 판에서 교차로 볼 수 있다.) */
function sourceOf(file) {
  const raw = read(file);
  const base = file.endsWith('.html') ? scriptsOfHtml(raw) : raw;
  return {
    code: stripCommentsAndStrings(base),
    withStrings: stripCommentsAndStrings(base, { keepStrings: true })
  };
}

// ───────────────────────── private 키 수집 ─────────────────────────

const ACC = '(?:\\b[\\w$]+\\s*\\.\\s*)?\\b(?:' + ACCESSORS.join('|') + ')\\s*\\(\\s*[^()]*\\)';

// 1) ev.extendedProperties.private.<key>  (priv() 를 안 거치는 직접 접근)
const RE_LONG = /\bextendedProperties\s*\.\s*private\s*\.\s*([A-Za-z_$][\w$]*)/g;
// 2) priv(ev).<key> / model.priv(ev).<key> / P().<key>
const RE_CALL_DOT = new RegExp(ACC + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)', 'g');
// 3) priv(ev)['<key>']  (문자열 리터럴 키 — 문자열을 남긴 판에서 본다)
const RE_CALL_BRACKET = new RegExp(ACC + "\\s*\\[\\s*['\"]([\\w$]+)['\"]\\s*\\]", 'g');
// 4) const p = priv(ev) / var p = ev.extendedProperties && ev.extendedProperties.private
const RE_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
// 초기화식이 priv() 로 '시작'하거나 '.private' 로 '끝'날 때만 별칭이다.
// 단순히 포함 여부로 보면 fromRfc3339(model.priv(t).deletedAt) 같은 식에서
// 결과 변수(Date)를 private 객체로 오인해 d.getTime() 을 미등록 키로 신고한다.
const RE_PRIV_INIT_HEAD = new RegExp(
  '^(?:[\\w$]+\\s*\\.\\s*)?(?:' + ACCESSORS.join('|') + ')\\s*\\(');
const RE_PRIV_INIT_TAIL = /extendedProperties\s*\.\s*private\s*$/;

function isPrivInit(init) {
  const s = String(init).trim();
  return RE_PRIV_INIT_HEAD.test(s) || RE_PRIV_INIT_TAIL.test(s);
}
// 5) private: { <key>: ... }
const RE_PRIV_LITERAL = /\bprivate\s*:\s*\{/g;

function collectFile(file, hits, problems) {
  const { code, withStrings } = sourceOf(file);
  const push = (key, index, form) => hits.push({ key, file, line: lineOf(code, index), form });

  let m;
  RE_LONG.lastIndex = 0;
  while ((m = RE_LONG.exec(code)) !== null) push(m[1], m.index, 'extendedProperties.private.' + m[1]);

  RE_CALL_DOT.lastIndex = 0;
  while ((m = RE_CALL_DOT.exec(code)) !== null) push(m[1], m.index, m[0].trim());

  RE_CALL_BRACKET.lastIndex = 0;
  while ((m = RE_CALL_BRACKET.exec(withStrings)) !== null) push(m[1], m.index, m[0].trim());

  // priv() 결과를 담은 지역 변수: 그 변수가 살아 있는 블록 안에서만 <이름>.<키> 를 본다.
  // (이 범위 제한이 핵심이다 — popups.js 의 this.popups.get() 결과나 calendarOp(p) 의 payload 처럼
  //  private 과 무관한 p 를 잡으면 거짓 경보가 쏟아진다.)
  RE_DECL.lastIndex = 0;
  while ((m = RE_DECL.exec(code)) !== null) {
    if (!isPrivInit(m[2])) continue;
    const name = m[1];
    const from = m.index + m[0].length;
    const to = blockEndFrom(code, from);
    const region = code.slice(from, to);
    const regionStr = withStrings.slice(from, to);
    const dot = new RegExp('\\b' + name + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)', 'g');
    let d;
    while ((d = dot.exec(region)) !== null) push(d[1], from + d.index, name + '.' + d[1]);
    const bracket = new RegExp('\\b' + name + "\\s*\\[\\s*['\"]([\\w$]+)['\"]\\s*\\]", 'g');
    while ((d = bracket.exec(regionStr)) !== null) push(d[1], from + d.index, d[0].trim());
  }

  // private: { ... } 리터럴 — 이벤트를 새로 만들 때 여기서 키가 태어난다.
  RE_PRIV_LITERAL.lastIndex = 0;
  while ((m = RE_PRIV_LITERAL.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const body = code.slice(open + 1, matchBrace(code, open));
    const { keys, opaque } = objectKeys(body);
    for (const k of keys) push(k, m.index, 'private: { ' + k + ': … }');
    for (const bad of opaque) {
      problems.push(rel(file) + ':' + lineOf(code, m.index)
        + ' — private 리터럴에 lint 가 읽을 수 없는 키가 있습니다 (' + bad.trim() + '). '
        + '전개(...)나 계산 키로 private 을 채우면 어떤 키가 저장되는지 아무도 모릅니다 — '
        + '`키: 값` 형태로 하나씩 적으세요.');
    }
  }
}

// ───────────────────────── 회차 상태(instanceState) 어휘 ─────────────────────────

/** setInstState(ev, key, <3번째 인자>) / getInstState 결과가 다루는 키를 모은다. */
function collectInstKeys(file, into) {
  const { code } = sourceOf(file);

  // 쓰기: setInstState 호출의 3번째 인자
  const call = /\b(?:[\w$]+\s*\.\s*)?setInstState\s*\(/g;
  let m;
  while ((m = call.exec(code)) !== null) {
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s+$/.test(before)) continue; // 정의 자리는 호출이 아니다
    const open = m.index + m[0].length - 1;
    const args = splitTop(code.slice(open + 1, matchParen(code, open)), ',');
    const third = (args[2] || '').trim();
    if (third.startsWith('{')) {
      for (const k of objectKeys(third.slice(1, third.lastIndexOf('}'))).keys) into.add(k);
    } else if (/^[A-Za-z_$][\w$]*$/.test(third)) {
      // patch 를 변수로 만들어 넘기는 자리 — 그 변수가 사는 블록에서 키를 긁는다
      const [bs, be] = enclosingBlock(code, m.index);
      const block = code.slice(bs, be);
      const decl = new RegExp('\\b(?:const|let|var)\\s+' + third + '\\s*=\\s*\\{');
      const dm = decl.exec(block);
      if (dm) {
        const open2 = dm.index + dm[0].length - 1;
        for (const k of objectKeys(block.slice(open2 + 1, matchBrace(block, open2))).keys) into.add(k);
      }
      const dot = new RegExp('\\b' + third + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)', 'g');
      let d;
      while ((d = dot.exec(block)) !== null) into.add(d[1]);
    }
  }

  // 읽기: const st = model.getInstState(...) 의 st.<키>
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\s*\.\s*)?getInstState\s*\(/g;
  while ((m = decl.exec(code)) !== null) {
    const name = m[1];
    const from = m.index + m[0].length;
    const region = code.slice(from, blockEndFrom(code, from));
    const dot = new RegExp('\\b' + name + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)', 'g');
    let d;
    while ((d = dot.exec(region)) !== null) into.add(d[1]);
  }
}

/** registry 의 instanceState 설명에서 회차 키 어휘를 읽는다(설명과 코드를 같은 줄에 묶는다). */
function instVocabFromRegistry(row) {
  const m = /\{\s*instKey\s*:\s*\{([^}]*)\}/.exec(row && row.desc ? row.desc : '');
  if (!m) return null;
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

/** registry.js 안에서 PRIVATE_FIELDS 행(키를 안 주면 표 자체)의 줄 번호 — 고칠 자리를 가리킨다. */
function registryLineOf(key) {
  const src = read(REGISTRY_FILE);
  const table = /PRIVATE_FIELDS\s*=\s*\[/.exec(src);
  if (!table) return 1;
  const from = table.index;
  if (!key) return lineOf(src, from);
  const to = src.indexOf('];', from);
  const block = src.slice(from, to < 0 ? src.length : to);
  const hit = new RegExp("key\\s*:\\s*['\"]" + key + "['\"]").exec(block);
  return lineOf(src, from + (hit ? hit.index : 0));
}

function lineOfPattern(file, re) {
  const src = read(file);
  const m = re.exec(src);
  return m ? lineOf(src, m.index) : 1;
}

// ───────────────────────── 실행 ─────────────────────────

const REG = await loadRegistry();
const registered = REG.privateKeys();

const problems = [];

const files = [];
for (const t of SCAN) {
  const found = collect(t.dir, t.exts);
  // 범위가 통째로 비면 검사는 조용히 0건을 통과시킨다 — 그건 "위반 없음"이 아니라 "안 봄"이다.
  // 디렉터리를 옮기거나 이름을 바꿨는데 이 표를 안 고친 경우가 여기서 잡힌다.
  if (found.length === 0) {
    problems.push(rel(t.dir) + ' — 검사 대상 파일이 0개입니다 (' + t.exts.join(', ') + '). '
      + rel(SELF_FILE) + ' 의 SCAN 에서 이 디렉터리 경로나 확장자 목록을 실제 트리에 맞게 고치세요 — '
      + '범위가 빈 채로 두면 이 lint 는 위반이 있어도 영원히 초록입니다.');
  }
  for (const f of found) files.push(f);
}
for (const f of EXTRA_FILES) {
  try { read(f); files.push(f); } catch (e) { /* 없으면 검사할 것도 없다 */ }
}

const hits = [];
for (const f of files) collectFile(f, hits, problems);

const used = [];
for (const h of hits) if (used.indexOf(h.key) < 0) used.push(h.key);

// 방향 1: 코드에 있는데 등록에 없다 — 발견한 자리를 전부 찍는다.
for (const k of used) {
  if (registered.indexOf(k) >= 0) continue;
  for (const h of hits.filter(x => x.key === k)) {
    problems.push(rel(h.file) + ':' + h.line + ' — 미등록 private 키 ' + k + ' (' + h.form + '). '
      + rel(REGISTRY_FILE) + ':' + registryLineOf(null)
      + ' 의 PRIVATE_FIELDS 에 { key: \'' + k + '\', desc: \'…\' } 를 넣거나 등록된 키('
      + registered.join(', ') + ') 로 바꾸세요. '
      + '등록 없이 쓰면 구글 캘린더 왕복에서 이 값이 사라집니다.');
  }
}

// 방향 2: 등록만 있고 아무도 안 쓴다 — 죽은 등록.
for (const k of registered) {
  if (used.indexOf(k) >= 0) continue;
  problems.push(rel(REGISTRY_FILE) + ':' + registryLineOf(k)
    + ' — PRIVATE_FIELDS 의 ' + k + ' 를 코드 어디에서도 읽지도 쓰지도 않습니다. '
    + '쓰는 코드를 넣거나(app/main/model.js 의 priv() 경유) 이 행을 지우세요 — '
    + '죽은 등록은 다음 사람이 없는 데이터를 읽게 만듭니다.');
}

// 회차 상태 어휘: registry 설명 ↔ setInstState/getInstState 가 실제로 다루는 키 (양방향)
const instRow = REG.PRIVATE_FIELDS.filter(f => f.key === INSTANCE_STATE_KEY)[0];
const vocab = instVocabFromRegistry(instRow);
if (!vocab) {
  problems.push(rel(REGISTRY_FILE) + ':' + registryLineOf(INSTANCE_STATE_KEY)
    + ' — instanceState 의 desc 에 회차 키 목록이 {instKey: {키,키}} 형태로 없습니다. '
    + 'lint 가 여기서 어휘를 읽습니다 — 그 형태로 적어주세요.');
} else {
  const instUsed = new Set();
  for (const f of files) collectInstKeys(f, instUsed);
  const where = ' (' + rel(REGISTRY_FILE) + ':' + registryLineOf(INSTANCE_STATE_KEY)
    + ', ' + rel(MODEL_FILE) + ':' + lineOfPattern(MODEL_FILE, /function\s+setInstState/) + ')';
  for (const p of diffBothWays('registry instanceState 설명', vocab,
    'setInstState/getInstState 가 다루는 키', Array.from(instUsed))) {
    problems.push(p + where);
  }
  // 회차 키는 단일 일정에서 private 최상위로도 저장된다 — 등록되지 않은 이름이면 그때 사라진다.
  for (const k of vocab) {
    if (registered.indexOf(k) < 0) {
      problems.push(rel(REGISTRY_FILE) + ':' + registryLineOf(INSTANCE_STATE_KEY)
        + ' — 회차 상태 키 ' + k + ' 가 PRIVATE_FIELDS 에 없습니다. '
        + '단일 일정은 같은 이름을 private 최상위에 저장하므로(app/main/model.js setInstState 의 key 없는 분기) '
        + '등록하지 않으면 반복이 아닌 일정에서 이 상태가 사라집니다.');
    }
  }
}

// 무엇을 봤는지 통과 메시지에 남긴다 — 다음 사람이 "이 파일도 봤나?"를 소스를 열지 않고 알 수 있어야 한다.
const scopeNote = SCAN.map(t => rel(t.dir) + '/**{' + t.exts.join(',') + '}').join(' + ')
  + ' + ' + EXTRA_FILES.map(rel).join(', ');

process.exit(report('private-fields', problems,
  '등록된 private 키 ' + registered.length + '개만 쓰인다 (파일 ' + files.length + '개 검사: ' + scopeNote
  + ', 회차 상태 어휘 ' + (vocab ? vocab.length : 0) + '개 일치)'));

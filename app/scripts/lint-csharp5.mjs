/* C# 5 문법 검사 — .cs 소스가 내장 컴파일러(csc.exe)를 벗어나지 않는가.
 *
 * 막는 사고
 *   src/*.cs 는 윈도우에 원래 들어 있는 .NET Framework 4.x 의 csc.exe(= C# 5)로만 빌드한다
 *   (build.cmd). SDK 를 깔 수 없는 폐쇄망 PC 를 위한 선택이라 물러설 자리가 없다. 그런데
 *   사람도 편집기도 $"{x}" · ?. · nameof · => 본문을 반사적으로 써 넣고, 그러면 정작 그
 *   폐쇄망 PC 에서만 빌드가 CS1056 류로 죽어 "내 컴퓨터에선 되는데"를 한참 헤맨다.
 *   지금은 사람의 기억이 유일한 방어다 — 그 기억을 검사로 바꾼다.
 */

import {
  ROOT_DIR, collect, read, rel, lineOf,
  stripCommentsAndStrings, diffBothWays, report
} from './_load.mjs';

// ───────────────────────── 검사 범위 ─────────────────────────

// 이 저장소의 .cs 는 전부 내장 csc 로 빌드된다(다른 툴체인이 없다).
// node_modules·.git 은 collect 가 건너뛴다.
const CS_EXTS = ['.cs'];

// csc 호출이 적혀 있는 자리. 여기서 뽑은 파일 목록과 디스크의 .cs 를 양방향 대조한다.
//   build.cmd  실제 배포 빌드(src\*.cs 와일드카드)
//   README.md  파서 검증 하네스 빌드(src\Nlp.cs test\NlpTest.cs) — 이 명령이 유일한 기록이다
//   .github/workflows/*.yml  CI(있을 때만)
const BUILD_REF_FILES = ['build.cmd', 'README.md'];
const BUILD_REF_DIR = '.github';
const BUILD_REF_DIR_EXTS = ['.yml', '.yaml'];

// allowlist(예외) — 검사에서 통째로 빼는 .cs. 지금은 비어 있고, 비어 있는 게 정상이다.
// 여기에 줄을 늘리는 순간 그 파일은 폐쇄망에서 빌드가 깨져도 아무도 모르게 된다.
// 넣어야 한다면(예: 현대 SDK 로만 빌드하는 별도 도구) 왜인지 반드시 옆에 적을 것.
const EXEMPT_FILES = [];

// ───────────────────────── C#6+ 문법 규칙 ─────────────────────────
//
// 원칙: 거짓 경보를 내느니 놓친다. C# 5 에서도 합법인 모양(람다 delegate/=>, ?? 연산자,
// out 파라미터 선언, 배열 인덱스 대입, 3항 연산자)과 겹치는 규칙은 좁게 쓰거나 뺐다.
//   · out 파라미터 선언은 `out DateTime when` 처럼 생겨 C#7 의 `out DateTime x` 선언식과
//     구문만으로는 구별할 수 없다. 그래서 명백한 `out var` 만 본다(MainForm.ResolveInput 참고).
//   · `{ get; }` 만 있는 속성은 C#6 이지만 인터페이스에서는 C#5 에서도 합법이라 뺐다.

// 멤버 선언 머리에 올 수 있는 한정자. `new`·`async` 는 문장 첫 낱말로도 나오므로
// (예: `new Thread(() => …)`) 식 본문 판정에서 일부러 뺐다 — 그게 대표적 오탐이다.
const MEMBER_MODIFIER =
  '(?:public|private|protected|internal|static|override|virtual|sealed|abstract|extern|partial|unsafe)';

const RULES = [
  {
    label: '문자열 보간 $"…"',
    since: 'C# 6',
    // 검사 대상이 문자열 리터럴 자체라 keepStrings 로 읽는다. 다만 "값: $" 처럼
    // $ 로 끝나는 평범한 문자열이 $" 로 보이므로, 문자열을 지운 판본에도 $ 가
    // 남아 있는지(= 코드 자리의 $ 인지)로 한 번 더 거른다.
    on: 'strings',
    re: /\$@?"|@\$"/g,
    confirm: (m, code) => code.slice(m.index, m.index + m[0].length).indexOf('$') >= 0,
    fix: 'string.Format("{0}…", x) 또는 "…" + x 로 바꾸세요.'
  },
  {
    label: 'null 조건 연산자 ?.',
    since: 'C# 6',
    // 3항 연산자의 `? .5f` 같은 소수점 리터럴만 피하면 된다.
    re: /\?\.(?![0-9])/g,
    fix: 'if (x != null) { x.Foo(); } 로 풀어 쓰세요.'
  },
  {
    label: 'null 조건 인덱서 ?[',
    since: 'C# 6',
    // `int?[] a` 같은 nullable 배열 타입(?[] / ?[,])은 제외한다.
    re: /\?\[(?![\],])/g,
    fix: 'if (x != null) { var v = x[i]; } 로 풀어 쓰세요.'
  },
  {
    label: 'null 병합 대입 ??=',
    since: 'C# 8',
    re: /\?\?=/g,
    fix: 'if (x == null) x = 기본값; 로 풀어 쓰세요 (?? 연산자 자체는 C#5 에서도 됩니다).'
  },
  {
    label: 'nameof(…)',
    since: 'C# 6',
    re: /(?<![A-Za-z0-9_@])nameof\s*\(/g,
    fix: '"이름" 문자열 리터럴을 직접 적으세요.'
  },
  {
    label: '식 본문 멤버 (=> 로 시작하는 메서드·속성·생성자 본문)',
    since: 'C# 6/7',
    // 멤버가 시작될 수 있는 자리(줄머리 또는 { } ; 직후)에서 한정자로 열고,
    // 그 뒤로 = ; { } 를 하나도 지나지 않은 채 => 에 닿는 경우만 본다. 그래야 람다가
    // 걸리지 않는다 — `Func<int,int> f = x => x;` 는 = 를, 메서드 안의
    // `list.Sort((a,b) => …)` 는 { 를 먼저 지난다. (한정자는 문장 첫 낱말이 될 수 없다.)
    re: new RegExp('(?:^|[\\n{};])[ \\t]*(?:' + MEMBER_MODIFIER + '[ \\t\\r\\n]+)+[^;={}]*?=>', 'g'),
    at: (m) => m.index + m[0].length - 2,
    fix: '{ return …; } / { get { return …; } } 블록 본문으로 바꾸세요 (람다는 C#5 에서도 됩니다).'
  },
  {
    label: '자동 속성 초기화자 { get; set; } = …',
    since: 'C# 6',
    re: /\{[^{}]*\bget\s*;[^{}]*\}\s*=(?!=)/g,
    at: (m) => m.index + m[0].length - 1,
    fix: '생성자에서 대입하세요 (public T X { get; set; } 선언 자체는 C#5 에서도 됩니다).'
  },
  {
    label: 'out var 선언식',
    since: 'C# 7',
    re: /(?<![A-Za-z0-9_])out\s+var(?![A-Za-z0-9_])/g,
    fix: '호출 앞줄에 int n; 처럼 미리 선언하고 out n 으로 넘기세요.'
  },
  {
    label: 'using static',
    since: 'C# 6',
    re: /(?:^|\n)[ \t]*using\s+static(?![A-Za-z0-9_])/g,
    at: (m) => m.index + m[0].length - 1,
    fix: 'using static 를 지우고 Math.Min(…) 처럼 타입명을 붙여 부르세요.'
  },
  {
    label: '인덱스 초기화자 { ["키"] = 값 }',
    since: 'C# 6',
    re: /\[[^[\]]*\]\s*=(?!=)/g,
    // 초기화자 안(= 여는 { 나 , 바로 뒤)에 온 [..] = 만 위반이다.
    // d["k"] = v; 나 _lv.Columns[0].Width = w; 같은 평범한 인덱스 대입은 앞에 식별자가 온다.
    confirm: (m, code) => {
      let i = m.index - 1;
      while (i >= 0 && /\s/.test(code[i])) i--;
      return i >= 0 && (code[i] === '{' || code[i] === ',');
    },
    fix: 'new Dictionary<…>() 로 만든 뒤 d["키"] = 값; 또는 d.Add("키", 값); 로 채우세요.'
  },
  {
    label: '튜플 분해 var (a, b)',
    since: 'C# 7',
    re: /(?<![A-Za-z0-9_])var\s*\(/g,
    fix: '전용 클래스나 out 파라미터로 돌려받으세요.'
  },
  {
    label: '튜플 리터럴 return (a, b);',
    since: 'C# 7',
    re: /(?<![A-Za-z0-9_])return\s*\([^()]*,[^()]*\)\s*;/g,
    fix: '전용 클래스나 out 파라미터로 돌려받으세요.'
  },
  {
    label: '튜플 리터럴 대입 = (a, b);',
    since: 'C# 7',
    // `= (Foo)x;` 같은 형변환은 ) 뒤에 피연산자가 오므로 `)\s*;` 에서 걸러진다.
    // `= (a, b) => …` 람다도 마찬가지로 걸러진다.
    re: /(?<![=!<>+\-*/%&|^])=\s*\([^()=]*,[^()=]*\)\s*;/g,
    fix: '전용 클래스나 out 파라미터로 돌려받으세요.'
  },
  {
    label: '튜플 타입 선언 (int, string) X',
    since: 'C# 7',
    // 한정자 바로 뒤의 ( 는 C#5 에 없는 모양이다(반환형·필드형 자리의 튜플).
    re: new RegExp('(?<![A-Za-z0-9_])' + MEMBER_MODIFIER + '\\s+\\(', 'g'),
    at: (m) => m.index + m[0].length - 1,
    fix: '전용 클래스로 선언하세요.'
  }
];

// ───────────────────────── 도우미 ─────────────────────────

function at(p) {
  return ROOT_DIR + '/' + p;
}

function tryRead(file) {
  try { return read(file); } catch (e) { return null; }
}

function matchesOf(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** C# 축자 문자열 @"…" 의 내용만 공백으로 지운다(길이·줄 번호 보존).
 *  왜: 공용 stripCommentsAndStrings 는 JS 규칙이라 @"C:\path\" 의 \" 를 이스케이프로 보고
 *  닫는 따옴표를 삼킨다. 그러면 그 뒤 코드가 통째로 "문자열 안"이 되어 진짜 위반을 놓친다.
 *  주석·일반 문자열·문자 리터럴은 건드리지 않고 그대로 넘긴다(지우는 일은 공용 유틸의 몫). */
function blankVerbatimStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && (c2 === '/' || c2 === '*')) {
      const close = c2 === '/' ? '\n' : '*/';
      const found = src.indexOf(close, i + 2);
      const end = found < 0 ? src.length : found + close.length;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '@' && c2 === '"') {
      out += '@"';
      i += 2;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') { out += '  '; i += 2; continue; }
        if (src[i] === '"') { out += '"'; i++; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        if (src[i] === c) { out += c; i++; break; }
        out += src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function snippet(lines, line) {
  const s = (lines[line - 1] || '').trim();
  return s.length > 72 ? s.slice(0, 69) + '…' : s;
}

// ───────────────────────── 본체 ─────────────────────────

const problems = [];

const diskPaths = collect(ROOT_DIR, CS_EXTS)
  .map((f) => rel(f))
  .filter((p) => EXEMPT_FILES.indexOf(p) < 0)
  .sort();

if (diskPaths.length === 0) {
  problems.push(
    'src/*.cs 를 한 개도 찾지 못했습니다 — C# 구현이 옮겨졌다면 ' +
    'app/scripts/lint-csharp5.mjs 의 검사 범위를 함께 고치세요(빈 검사는 통과처럼 보입니다).');
}

// ---- 1) 문법 검사 ----

const hits = [];

for (const path of diskPaths) {
  const raw = read(at(path));
  const lines = raw.split('\n');
  const pre = blankVerbatimStrings(raw);
  const code = stripCommentsAndStrings(pre);                        // 주석·문자열 제거
  const withStrings = stripCommentsAndStrings(pre, { keepStrings: true }); // 주석만 제거

  for (const rule of RULES) {
    const text = rule.on === 'strings' ? withStrings : code;
    for (const m of matchesOf(rule.re, text)) {
      if (rule.confirm && !rule.confirm(m, code)) continue;
      const line = lineOf(raw, rule.at ? rule.at(m) : m.index);
      hits.push({
        path: path,
        line: line,
        msg:
          `${path}:${line} — ${rule.since} 문법 «${rule.label}» 사용. ` +
          `내장 csc(C# 5)로는 build.cmd 가 이 줄에서 깨집니다. ${rule.fix} ` +
          `[현재: ${snippet(lines, line)}]`
      });
    }
  }
}

// 고치는 사람이 위에서 아래로 읽을 수 있도록 파일·줄 순으로 낸다.
hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
for (const h of hits) problems.push(h.msg);

// ---- 2) 디스크의 .cs ↔ csc 가 컴파일하는 .cs (양방향) ----

const refFiles = BUILD_REF_FILES.map((p) => ({ path: p, src: tryRead(at(p)) }))
  .filter((e) => e.src !== null)
  .concat(collect(at(BUILD_REF_DIR), BUILD_REF_DIR_EXTS)
    .map((f) => ({ path: rel(f), src: read(f) })));

const CS_TOKEN = /[A-Za-z0-9_.*][A-Za-z0-9_./\\*-]*\.cs\b/g;
const builtPaths = [];
const refLocations = [];

for (const ref of refFiles) {
  const isDoc = ref.path.endsWith('.md');
  const lines = ref.src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 문서에서는 csc 명령 줄만 본다(본문에서 파일 이름을 언급했다고 컴파일되는 건 아니다).
    if (isDoc && !/csc/i.test(lines[i])) continue;
    for (const m of matchesOf(CS_TOKEN, lines[i])) {
      const token = m[0].replace(/\\/g, '/').replace(/^\.\//, '');
      const dir = token.slice(0, token.lastIndexOf('/'));
      const expanded = token.indexOf('*') < 0
        ? [token]
        // csc 는 재귀하지 않는다. src\*.cs 는 src 바로 아래 파일만 컴파일한다.
        : diskPaths.filter((p) => p.startsWith(dir + '/') && p.indexOf('/', dir.length + 1) < 0);
      for (const p of expanded) if (builtPaths.indexOf(p) < 0) builtPaths.push(p);
      const loc = ref.path + ':' + (i + 1);
      if (refLocations.indexOf(loc) < 0) refLocations.push(loc);
    }
  }
}

if (diskPaths.length > 0) {
  for (const p of diffBothWays(
    '디스크의 .cs', diskPaths,
    'csc 명령이 컴파일하는 .cs', builtPaths
  )) {
    problems.push(
      `${p} (컴파일 목록은 ${refLocations.join(' · ')} 에 있습니다. ` +
      '어디서도 컴파일되지 않는 .cs 는 이 검사만 통과할 뿐 빌드되지 않습니다.)');
  }
}

process.exit(report(
  'lint:csharp5',
  problems,
  `C#6+ 문법 0건 — .cs ${diskPaths.length}개 · 규칙 ${RULES.length}종 · ` +
  `csc 컴파일 목록(${refLocations.join(' · ')})과 1:1`
));

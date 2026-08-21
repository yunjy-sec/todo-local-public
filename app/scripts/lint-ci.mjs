/* CI 계약 검사.
 *
 * 왜 있는가
 *   검사를 새로 만들고 lint-all 에 넣는 것을 잊으면 CI 는 그 검사가 있는 줄도 모른다 —
 *   초록불이 거짓말을 한다. 반대로 lint-all 에만 넣고 package.json 에 안 넣으면
 *   사람이 개별로 돌릴 수 없다.
 *   그리고 워크플로에서 한 단계(예: 스모크, C# 빌드)가 조용히 빠지면
 *   그 영역의 회귀는 아무도 못 잡는다. 실제로 그런 사고를 막으려고 필수 단계를 못 박는다.
 *
 * 4자리 자기등록: scripts/lint-*.mjs · package.json scripts · lint-all CHECKS · registry.TESTING.checks
 * 이 넷을 여기서 대조한다(ci.yml 은 npm run lint 경유라 자동으로 다섯째 자리가 된다).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry, APP_DIR, ROOT_DIR, read, rel, report, diffBothWays } from './_load.mjs';

const REG = await loadRegistry();
const problems = [];

// ---- 1) 4자리 자기등록 대조 ----
const pkg = JSON.parse(read(join(APP_DIR, 'package.json')));
const pkgScripts = Object.keys(pkg.scripts || {});

// lint-all 은 import 하면 검사를 실제로 돌린다(그 안에 이 파일도 들어 있어 무한 재귀가 된다).
// 그래서 소스를 읽어 표만 뽑는다.
const lintAllSrc = read(join(APP_DIR, 'scripts', 'lint-all.mjs'));
const lintAllNames = [...lintAllSrc.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'/g)].map(m => ({ npm: m[1], file: m[2] }));

const testingNames = REG.TESTING.checks.map(c => c.npm);

// (a) lint-all ↔ registry.TESTING.checks
// TESTING 에는 lint 가 아닌 것(test, check:ui)도 있으므로 lint:* 만 비교한다.
problems.push(...diffBothWays(
  'lint-all CHECKS', lintAllNames.map(x => x.npm),
  'registry.TESTING.checks(lint:*)', testingNames.filter(n => n.startsWith('lint:'))
).map(m => 'app/scripts/lint-all.mjs — ' + m));

// (b) lint-all ↔ package.json scripts
problems.push(...diffBothWays(
  'lint-all CHECKS', lintAllNames.map(x => x.npm),
  'package.json scripts(lint:*)', pkgScripts.filter(n => n.startsWith('lint:'))
).map(m => 'app/package.json — ' + m));

// (c) TESTING.checks 전체가 package.json 에 있는가 (test, check:ui 포함)
for (const c of REG.TESTING.checks) {
  if (!pkgScripts.includes(c.npm)) {
    problems.push(`app/package.json — registry.TESTING.checks 의 '${c.npm}' 가 scripts 에 없습니다. 추가하거나 등록표에서 빼세요.`);
  }
}

// (d) 실제 파일 존재 + lint-all 이 부르는 파일과 package.json 명령이 같은 파일인가
for (const { npm, file } of lintAllNames) {
  const full = join(APP_DIR, 'scripts', file);
  if (!existsSync(full)) {
    problems.push(`app/scripts/lint-all.mjs — '${npm}' 이 가리키는 ${file} 가 없습니다.`);
    continue;
  }
  const cmd = pkg.scripts[npm] || '';
  if (cmd && !cmd.includes(file)) {
    problems.push(`app/package.json — '${npm}' 명령(${cmd})이 lint-all 의 ${file} 과 다른 파일을 부릅니다.`);
  }
}

// (e) scripts 디렉터리에 있는데 어디에도 등록 안 된 lint 파일
const { collect } = await import('./_load.mjs');
const onDisk = collect(join(APP_DIR, 'scripts'), ['.mjs'])
  .map(f => f.split(/[\\/]/).pop())
  .filter(f => f.startsWith('lint-') && f !== 'lint-all.mjs');
problems.push(...diffBothWays(
  '디스크의 lint 파일', onDisk,
  'lint-all CHECKS', lintAllNames.map(x => x.file)
).map(m => 'app/scripts/ — ' + m));

// ---- 2) 워크플로 필수 단계 ----
const CI_PATH = join(ROOT_DIR, '.github', 'workflows', 'ci.yml');
if (!existsSync(CI_PATH)) {
  problems.push('.github/workflows/ci.yml 가 없습니다 — CI 없이는 회귀가 사람 손에만 달린다.');
} else {
  const ci = read(CI_PATH);
  // [정규식, 왜 필요한가]
  const REQUIRED = [
    [/on:\s*[\s\S]*?push:/, 'push 트리거 — main 에 들어간 코드가 검사를 거치지 않는다'],
    [/pull_request:/, 'pull_request 트리거 — 머지 전에 못 잡는다'],
    [/workflow_dispatch:/, '수동 실행 — 조사할 때 돌릴 방법이 없다'],
    [/permissions:\s*\n\s*contents:\s*read/, '최소 권한 — 토큰이 필요 이상으로 세면 사고 범위가 커진다'],
    [/cancel-in-progress:\s*true/, '중복 실행 취소 — 큐가 밀리면 결과가 늦게 오고 아무도 안 본다'],
    [/runs-on:\s*windows-latest/, '윈도우 러너 — C# 은 내장 csc 라 ubuntu 에서 아예 안 돈다'],
    [/node-version:\s*22/, 'Node 22 — check:ui 가 전역 WebSocket/fetch 를 쓴다'],
    // 잠금 파일은 원격 주소 목록이라 이 빌드의 트리에서 뺐다(docs/AUDIT.md).
    [/npm install/, '의존성 설치 — 설치 없이 통과하면 의미가 없다'],
    [/npm run check\b/, '문법 검사'],
    [/npm run lint\b/, '가드레일 검사 — 이 한 줄이 lint-all 을 통해 모든 lint 를 끌어온다'],
    [/npm test\b/, '단위 시험'],
    [/npm run check:ui\b/, '실제 창 스모크 — 렌더러가 통째로 비어도 lint 는 초록이다'],
    [/TODO_DATA_DIR:/, '데이터 디렉터리 주입 — 실사용 원장을 만지면 안 된다'],
    [/cp \.\.\/testdata\/\*\.json/, '픽스처 사본 — 커밋된 고정본을 직접 가리키면 앱이 그것을 고쳐 오염시킨다'],
    [/npm run audit\b/, '통신 흔적 감사 — 이 빌드의 존재 이유다. 빠지면 통신이 돌아와도 아무도 모른다'],
    [/build\.cmd/, 'C# 빌드 — Phase 1 구현이 깨져도 아무도 모른다'],
    [/NlpTest\.exe/, 'C# 파서 시험 — JS 포팅과 갈라지는 것을 잡는다'],
  ];
  for (const [re, why] of REQUIRED) {
    if (!re.test(ci)) {
      problems.push(`.github/workflows/ci.yml — 필수 단계 누락: ${re.source} (${why})`);
    }
  }
  // 배포·비밀은 CI 에 두지 않는다(사람 세션이 필요한 일).
  if (/secrets\./.test(ci)) {
    problems.push('.github/workflows/ci.yml — secrets 사용이 보입니다. 배포·자격이 필요한 일은 CI 밖에서 합니다.');
  }
}

// ---- 3) 픽스처 존재 ----
for (const f of ['todos.json', 'calendars.json']) {
  const p = join(ROOT_DIR, 'testdata', f);
  if (!existsSync(p)) {
    problems.push(`testdata/${f} 가 없습니다 — CI 스모크가 빈 데이터로 돌아 아무것도 검증하지 못합니다.`);
  }
}

process.exit(report('lint:ci',
  problems,
  `자기등록 4자리 일치(lint ${lintAllNames.length}종) · CI 필수 단계 16개 · 픽스처 2종`));

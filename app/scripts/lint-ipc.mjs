/* lint:ipc — IPC 채널 3중 양방향 대조 (등록표 ↔ main 핸들러·발신 ↔ renderer 호출·수신).
 *
 * 왜 있는가 = 이 lint 가 막는 사고
 *   같은 채널 문자열이 registry.IPC_CHANNELS · main 의 handle()/send() · renderer 의
 *   api.invoke()/api.on() 세 곳에 따로 박힌다. 한 곳만 바뀌어도 아무 데서도 터지지 않는다 —
 *   main 이 오타 난 채널로 webContents.send() 하면 창은 에러조차 없이 조용히 아무 일도 안 하고,
 *   renderer 가 지운 호출은 죽은 채널로 등록표에 남아 다음 사람이 그걸 근거로 코드를 쓴다.
 *   그래서 세 자리를 양방향으로 묶는다 — 미등록 사용도, 아무도 안 쓰는 등록도 여기서 걸린다.
 */

import {
  APP_DIR, ROOT_DIR, collect, read, rel, lineOf,
  loadRegistry, stripCommentsAndStrings, scriptsOfHtml, diffBothWays, report
} from './_load.mjs';

const REG = await loadRegistry();

const LINT_FILE = 'app/scripts/lint-ipc.mjs';
const REG_FILE = APP_DIR + '/shared/registry.js';
const MAIN_DIR = APP_DIR + '/main';
const RENDERER_DIR = APP_DIR + '/renderer';

// ── 예외 1: 아직 실물이 없는 invoke 채널 ────────────────────────────────
// SCENARIOS.remote-sync 는 status:done 이지만 그 done 은 "등록이 끝났다" 는 뜻이다.
// main 핸들러와 renderer 호출은 docs/ARCHITECTURE.md §6 의 **R4(원격 옵션)** 라운드에서 붙는다.
// R4 에서 handle('sync-status') 를 붙이는 순간 아래 목록에서 빼야 lint 가 통과한다
// (붙었는데 목록에 남아 있으면 "이제 구현됐으니 예외를 빼라" 고 여기서 실패한다).
// R4 에서 sync-status·sync-now 핸들러가 붙어 유예가 비었다.
// 다음에 "등록만 하고 구현은 다음 라운드" 를 할 때만 여기에 넣고, 구현되면 바로 뺀다
// (이 검사가 그것을 강제한다 — 핸들러가 생기면 실패한다).
const UNIMPLEMENTED_INVOKE = [];

// ── 예외 2: 채널명을 변수로 넘겨서 보내는 자리 ──────────────────────────
// windows.showList(focusInput, extraChannel) 는 받은 채널을 그대로 send 한다.
// 즉 'open-settings' 리터럴은 발신 코드가 아니라 호출부(트레이 메뉴)에 있다.
// 리터럴이 살아 있는지는 아래에서 직접 확인한다 — 예외가 썩는 것을 막는다.
const FORWARDED_EVENTS = [
  { key: 'open-settings', literalIn: 'app/main/main.js', via: "트레이 메뉴 → windows.showList(false, 'open-settings') → windows.js 의 webContents.send(extraChannel)" }
];
// 위 forwarding 때문에 채널명이 변수인 send 가 남는 파일. 새 파일이 여기 없이 변수로 보내면 실패한다.
const DYNAMIC_EMIT_FILES = ['app/main/windows.js'];

const problems = [];

// ───────────────────────── 1) 등록표 ─────────────────────────
const regInvoke = REG.channelKeys('invoke');
const regEvent = REG.channelKeys('event');

// 등록 위치(파일:줄). 실패 메시지가 "어디를 고칠지" 를 가리키게 하려고 소스에서 직접 찾는다.
const regLoc = {};
{
  const src = read(REG_FILE);
  const re = /\{\s*key:\s*(['"])([^'"]+)\1\s*,\s*kind:\s*(['"])(invoke|event)\3/g;
  let m;
  while ((m = re.exec(src)) !== null) regLoc[m[2]] = rel(REG_FILE) + ':' + lineOf(src, m.index);
}

// ───────────────────────── 2) main 쪽 ─────────────────────────
// 핸들러 등록과 이벤트 발신을 모은다. 채널명은 문자열 리터럴이므로 keepStrings:true.
const handlers = [];
const handlerLoc = {};
const emits = [];
const emitLoc = {};
const mainCode = {};

for (const file of collect(MAIN_DIR, ['.js'])) {
  const code = stripCommentsAndStrings(read(file), { keepStrings: true });
  const relFile = rel(file);
  mainCode[relFile] = code;
  const at = (i) => relFile + ':' + lineOf(code, i);
  let m;

  // handle('키', …) — main.js 의 관문 함수. ipcMain.handle 직접 호출도 같은 패턴에 걸린다.
  const reHandle = /(ipcMain\s*\.\s*)?\bhandle\s*\(\s*(['"])([^'"]*)\2/g;
  while ((m = reHandle.exec(code)) !== null) {
    const key = m[3];
    const loc = at(m.index);
    if (m[1]) {
      problems.push(`${loc} — ipcMain.handle('${key}') 직접 호출입니다. app/main/main.js 의 handle() 관문을 쓰세요 (관문이 미등록 채널 등록을 막는다).`);
    }
    if (handlers.indexOf(key) >= 0) {
      problems.push(`${loc} — '${key}' 핸들러가 두 번 등록됩니다(먼저: ${handlerLoc[key]}). ipcMain.handle 은 두 번째에서 예외를 던집니다 — 둘 중 하나를 지우세요.`);
    } else {
      handlers.push(key);
      handlerLoc[key] = loc;
    }
  }

  // webContents.send('키', …) / broadcast('키', …)
  const reEmit = /\.\s*send\s*\(\s*(['"])([^'"]*)\1|\bbroadcast\s*\(\s*(['"])([^'"]*)\3/g;
  while ((m = reEmit.exec(code)) !== null) {
    const key = m[2] !== undefined ? m[2] : m[4];
    if (emits.indexOf(key) < 0) { emits.push(key); emitLoc[key] = at(m.index); }
  }

  // 채널명이 리터럴이 아닌 발신(변수·템플릿 리터럴). 여기서 3중 대조가 뚫린다.
  const reDynEmit = /\.\s*(send|broadcast)\s*\(\s*([^'"\s)])/g;
  while ((m = reDynEmit.exec(code)) !== null) {
    if (DYNAMIC_EMIT_FILES.indexOf(relFile) >= 0) continue;
    problems.push(`${at(m.index)} — 채널명을 변수로 ${m[1]}() 합니다. 등록표와 대조할 수 없습니다: 리터럴 채널명을 쓰거나, 리터럴이 어디 있는지 ${LINT_FILE} 의 FORWARDED_EVENTS 에 적고 이 파일을 DYNAMIC_EMIT_FILES 에 넣으세요.`);
  }
}

// forwarding 으로 보내는 이벤트를 발신 목록에 넣는다(리터럴이 실제로 살아 있을 때만).
for (const f of FORWARDED_EVENTS) {
  if (regEvent.indexOf(f.key) < 0) {
    problems.push(`${LINT_FILE} 의 FORWARDED_EVENTS: '${f.key}' 는 등록표의 kind:'event' 채널이 아닙니다 — ${rel(REG_FILE)} 의 IPC_CHANNELS 에 넣거나 예외에서 빼세요.`);
    continue;
  }
  const code = mainCode[f.literalIn];
  if (!code) {
    problems.push(`${LINT_FILE} 의 FORWARDED_EVENTS: ${f.literalIn} 를 읽지 못했습니다 — 파일이 옮겨졌으면 literalIn 경로를 고치세요.`);
    continue;
  }
  let idx = code.indexOf("'" + f.key + "'");
  if (idx < 0) idx = code.indexOf('"' + f.key + '"');
  if (idx < 0) {
    problems.push(`${LINT_FILE} 의 FORWARDED_EVENTS: '${f.key}' 리터럴이 ${f.literalIn} 에서 사라졌습니다(${f.via}). 발신처가 없어졌다면 ${rel(REG_FILE)} 의 채널도 지우고 이 예외도 지우세요.`);
    continue;
  }
  if (emits.indexOf(f.key) < 0) { emits.push(f.key); emitLoc[f.key] = f.literalIn + ':' + lineOf(code, idx); }
}

// ───────────────────────── 3) renderer 쪽 ─────────────────────────
// HTML 안의 <script> 만 본다(본문 텍스트에 있는 채널명 비슷한 문자열에 속지 않으려고).
const invokes = [];
const invokeLoc = {};
const ons = [];
const onLoc = {};

for (const file of collect(RENDERER_DIR, ['.html', '.js'])) {
  const src = read(file);
  const js = file.endsWith('.html') ? scriptsOfHtml(src) : src;
  const code = stripCommentsAndStrings(js, { keepStrings: true });
  const relFile = rel(file);
  const at = (i) => relFile + ':' + lineOf(code, i);
  let m;

  const reInvoke = /\bapi\s*\.\s*invoke\s*\(\s*(['"])([^'"]*)\1/g;
  while ((m = reInvoke.exec(code)) !== null) {
    if (invokes.indexOf(m[2]) < 0) { invokes.push(m[2]); invokeLoc[m[2]] = at(m.index); }
  }

  const reOn = /\bapi\s*\.\s*on\s*\(\s*(['"])([^'"]*)\1/g;
  while ((m = reOn.exec(code)) !== null) {
    if (ons.indexOf(m[2]) < 0) { ons.push(m[2]); onLoc[m[2]] = at(m.index); }
  }

  const reDyn = /\bapi\s*\.\s*(invoke|on)\s*\(\s*([^'"\s)])/g;
  while ((m = reDyn.exec(code)) !== null) {
    problems.push(`${at(m.index)} — api.${m[1]}() 에 채널명을 변수로 넘깁니다. 등록표와 대조할 수 없고 오타는 런타임까지 살아남습니다 — 리터럴 채널명을 쓰세요.`);
  }
}

// ───────────────────────── 4) 3중 양방향 대조 ─────────────────────────
// diffBothWays 가 "한쪽에만 있음" 문장을 만들고, 여기서 그 키가 실제로 있는 자리를 붙인다.
// 등록된 키면 등록표 줄을 가리키고(거기서 지우면 된다), 등록에 없는 키면 그 키를 쓰는
// 코드 자리를 가리킨다(거기가 고칠 자리다).
const allLoc = Object.assign({}, handlerLoc, emitLoc, invokeLoc, onLoc, regLoc);
function cross(aName, a, bName, b) {
  return diffBothWays(aName, a, bName, b).map(function (line) {
    const hit = line.match(/있음: (\S+)/);
    const where = hit && allLoc[hit[1]] ? ' [' + allLoc[hit[1]] + ']' : '';
    return line + where;
  });
}

const N_REG = '등록표 ' + rel(REG_FILE) + ' IPC_CHANNELS';

// 미구현 예외 채널은 양쪽에서 다 빼고 아래 5) 에서 따로 본다.
// (한쪽에서만 빼면 "핸들러에만 있음" 같은 거꾸로 된 메시지가 나온다.)
const skip = (k) => UNIMPLEMENTED_INVOKE.indexOf(k) >= 0;
const cmpReg = regInvoke.filter(k => !skip(k));

// (1) 등록 invoke ↔ main 핸들러
problems.push(...cross(
  N_REG + "(invoke)", cmpReg,
  "main 핸들러 app/main/main.js setupIpc() 의 handle('키')", handlers.filter(k => !skip(k))));

// (2) 등록 invoke ↔ renderer 호출 (아무도 안 부르는 채널도 죽은 등록으로 잡는다)
problems.push(...cross(
  N_REG + "(invoke)", cmpReg,
  "renderer 호출 app/renderer/*.html 의 api.invoke('키')", invokes.filter(k => !skip(k))));

// (3) 등록 event ↔ renderer 수신 ↔ main 발신
problems.push(...cross(
  N_REG + "(event)", regEvent,
  "renderer 수신 app/renderer/*.html 의 api.on('키')", ons));
problems.push(...cross(
  N_REG + "(event)", regEvent,
  "main 발신 app/main/*.js 의 webContents.send('키')/broadcast('키')", emits));

// ───────────────────────── 5) 예외 목록이 썩지 않았는가 ─────────────────────────
for (const k of UNIMPLEMENTED_INVOKE) {
  if (regInvoke.indexOf(k) < 0) {
    problems.push(`${LINT_FILE} 의 UNIMPLEMENTED_INVOKE: '${k}' 가 등록표에 없습니다 — ${rel(REG_FILE)} 의 IPC_CHANNELS 에 되돌리거나 예외에서 빼세요.`);
    continue;
  }
  if (handlers.indexOf(k) >= 0) {
    problems.push(`${handlerLoc[k]} — '${k}' 핸들러가 생겼습니다(R4 완료). ${LINT_FILE} 의 UNIMPLEMENTED_INVOKE 에서 '${k}' 를 빼세요.`);
  } else if (invokes.indexOf(k) >= 0) {
    problems.push(`${invokeLoc[k]} — '${k}' 를 부르는데 main 핸들러가 없습니다(호출이 그대로 reject 된다). app/main/main.js 에 handle('${k}') 를 붙이고 ${LINT_FILE} 의 UNIMPLEMENTED_INVOKE 에서 빼세요.`);
  }
}

process.exit(report(
  'lint:ipc',
  problems,
  `채널 ${regInvoke.length + regEvent.length}개 3중 일치 (invoke ${regInvoke.length}: 핸들러 ${handlers.length}·호출 ${invokes.length}, event ${regEvent.length}: 발신 ${emits.length}·수신 ${ons.length}, 미구현 예외 ${UNIMPLEMENTED_INVOKE.length})`
));

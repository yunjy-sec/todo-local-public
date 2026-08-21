'use strict';

/* IPC 관문 — renderer 가 main 에 닿는 유일한 문.
 *
 * 채널 목록은 registry.IPC_CHANNELS 에서 나온다. 예전에는 여기서 임의의 channel 을
 * 그대로 통과시켰는데(와일드카드 브리지), 그러면 창에 끼어든 어떤 코드든 main 의
 * 모든 핸들러를 부를 수 있고 오타 난 채널명은 조용히 아무 일도 안 하고 끝난다.
 * 이제 등록되지 않은 채널은 즉시 예외로 터진다 — lint:ipc 가 등록·핸들러·호출처를 대조한다.
 */
const { contextBridge, ipcRenderer } = require('electron');
const REG = require('./shared/registry.js');

const problems = REG.verify();
if (problems.length) {
  // 등록이 계약을 어기면 창을 띄우기 전에 여기서 멈춘다.
  throw new Error('registry: ' + problems.join(' | '));
}

const INVOKE = new Set(REG.channelKeys('invoke'));
const EVENT = new Set(REG.channelKeys('event'));

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) {
      return Promise.reject(new Error(
        '미등록 IPC 채널: ' + channel + ' — app/shared/registry.js 의 IPC_CHANNELS 에 넣거나 오타를 고치세요.'));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, cb) {
    if (!EVENT.has(channel)) {
      throw new Error(
        '미등록 IPC 이벤트: ' + channel + ' — app/shared/registry.js 의 IPC_CHANNELS 에 kind:event 로 넣으세요.');
    }
    ipcRenderer.on(channel, (ev, data) => cb(data));
  },
  // 창이 등록표를 읽어 UI 를 만든다(칩·설정 필드·색 등). DOM 은 창이, 목록은 등록표가 소유한다.
  registry: {
    QUICK_CHIPS: REG.QUICK_CHIPS,
    SNOOZE_PRESETS: REG.SNOOZE_PRESETS,
    POPUP_ACTIONS: REG.POPUP_ACTIONS,
    SETTINGS_FIELDS: REG.SETTINGS_FIELDS,
    SETTINGS_SECTIONS: REG.SETTINGS_SECTIONS,
    EVENT_COLORS: REG.EVENT_COLORS,
    CAL_PALETTE: REG.CAL_PALETTE,
    RRULE_SUPPORT: REG.RRULE_SUPPORT
  }
});

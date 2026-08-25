using System;
using System.Windows.Forms;
using TodoPopup;

/// <summary>
/// 단축키 문자열 해석과 커밋 스탬프 읽기.
///
/// 왜 이렇게 시험하는가
///   같은 함정을 두 번 밟았다 — 쌍둥이 팝업 사고는 모니터 2대에서만, 두 번째 실행 사고는
///   인스턴스 2개일 때만 났고, 둘 다 검사는 초록이었다. 전역 단축키도 "실제로 눌러 봐야만"
///   확인되는 모양으로 짜면 같은 일이 난다. 그래서 문자열 <-> 조합 변환을 순수 함수로 떼어
///   놓고 표로 시험한다. RegisterHotKey 자체는 OS 의 몫이다.
///
/// 막는 사고
///   문자열 형식은 Electron 판과 공유한다("Control+Alt+N"). 형식이 갈라지면 한쪽에서 정한
///   키가 다른 쪽에서 조용히 무시된다 — settings.json 이 한 파일이기 때문이다.
/// </summary>
public static class HotkeyTest
{
    private static int _fail;

    [STAThread]
    public static int Main()
    {
        // ---- 읽기: 되는 것 ----
        Ok("Control+Alt+N", Hotkeys.MOD_CONTROL | Hotkeys.MOD_ALT, 0x4E);
        Ok("Control+Alt+T", Hotkeys.MOD_CONTROL | Hotkeys.MOD_ALT, 0x54);
        Ok("Control+Alt+Enter", Hotkeys.MOD_CONTROL | Hotkeys.MOD_ALT, 0x0D);
        Ok("Control+Shift+F5", Hotkeys.MOD_CONTROL | Hotkeys.MOD_SHIFT, 0x74);
        Ok("Alt+Space", Hotkeys.MOD_ALT, 0x20);
        Ok("Control+Alt+1", Hotkeys.MOD_CONTROL | Hotkeys.MOD_ALT, 0x31);

        // Electron 문서에 나오는 다른 이름들도 받는다 — 사용자가 그것을 보고 적는다.
        Ok("Ctrl+Alt+N", Hotkeys.MOD_CONTROL | Hotkeys.MOD_ALT, 0x4E);
        Ok("CommandOrControl+Alt+N", Hotkeys.MOD_CONTROL | Hotkeys.MOD_ALT, 0x4E);
        Ok("control+alt+n", Hotkeys.MOD_CONTROL | Hotkeys.MOD_ALT, 0x4E);
        Ok("Super+Alt+Return", Hotkeys.MOD_WIN | Hotkeys.MOD_ALT, 0x0D);

        // 눌러 두면 초당 수십 번 들어온다 — 목록 창이 그만큼 뜨면 못 쓴다.
        {
            uint mods, vk;
            Hotkeys.TryParse("Control+Alt+N", out mods, out vk);
            Check("자동 반복을 끈다 (MOD_NOREPEAT)", (mods & Hotkeys.MOD_NOREPEAT) != 0,
                "mods=0x" + mods.ToString("X"));
        }

        // ---- 읽기: 안 되는 것 ----
        No("N", "수정자 없는 전역 단축키는 만들지 않는다 — 그 글자를 통째로 못 쓰게 된다");
        No("", "빈 값");
        No(null, "null");
        No("Control+", "키가 없다");
        No("Control+Alt+없는키", "모르는 키 이름");
        No("Banana+N", "모르는 수정자");
        No("Control+Alt+F99", "F1~F24 밖");

        // ---- 쓰기: 눌린 키 -> 문자열 ----
        Fmt(Keys.Control | Keys.Alt | Keys.N, "Control+Alt+N");
        Fmt(Keys.Control | Keys.Alt | Keys.Enter, "Control+Alt+Enter");
        Fmt(Keys.Control | Keys.Shift | Keys.F5, "Control+Shift+F5");
        Fmt(Keys.Control | Keys.Alt | Keys.D1, "Control+Alt+1");
        Fmt(Keys.Control | Keys.Alt | Keys.NumPad1, "Control+Alt+1");
        FmtNull(Keys.N, "수정자가 없다");
        FmtNull(Keys.Control | Keys.ControlKey, "수정자만 눌렀다");
        FmtNull(Keys.Control | Keys.Alt, "수정자만 눌렀다");

        // 왕복: 만들어 낸 문자열은 반드시 다시 읽혀야 한다. 안 그러면 설정 화면에서
        // 고른 조합이 저장은 되는데 걸리지는 않는 상태가 된다.
        foreach (Keys k in new Keys[] {
            Keys.Control | Keys.Alt | Keys.N,
            Keys.Control | Keys.Alt | Keys.Enter,
            Keys.Control | Keys.Shift | Keys.F12,
            Keys.Control | Keys.Alt | Keys.Shift | Keys.D9,
            Keys.Alt | Keys.Home })
        {
            string spec = Hotkeys.FormatFromKeys(k);
            uint mods, vk;
            Check("왕복: " + k + " -> " + spec,
                spec != null && Hotkeys.TryParse(spec, out mods, out vk), "spec=" + (spec ?? "null"));
        }

        // ---- 보여 주기 ----
        Check("빈 값은 '없음' 으로 보인다", Hotkeys.Display("") == "없음", Hotkeys.Display(""));
        Check("Control 은 Ctrl 로 짧게 보인다",
            Hotkeys.Display("Control+Alt+N") == "Ctrl+Alt+N", Hotkeys.Display("Control+Alt+N"));

        // ---- 커밋 스탬프 ----
        BuildInfo.Parse("b88dfd3 2026-08-25T15:29:07+09:00");
        Check("커밋 해시를 읽는다", BuildInfo.Hash == "b88dfd3", BuildInfo.Hash);
        Check("커밋 시각을 사람이 읽는 모양으로", BuildInfo.When.StartsWith("2026-08-25"), BuildInfo.When);
        Check("배너 문구가 커밋을 말한다",
            BuildInfo.Text.StartsWith("커밋 b88dfd3"), BuildInfo.Text);

        BuildInfo.ResetForTest();
        BuildInfo.Parse("unknown");
        Check("스탬프가 없으면 지어내지 않는다", BuildInfo.Text.IndexOf("unknown") >= 0, BuildInfo.Text);

        Console.WriteLine(_fail == 0 ? "ALL PASS" : "FAILED " + _fail);
        return _fail;
    }

    private static void Ok(string spec, uint wantMods, uint wantVk)
    {
        uint mods, vk;
        bool got = Hotkeys.TryParse(spec, out mods, out vk);
        uint bare = mods & ~Hotkeys.MOD_NOREPEAT;
        Check("읽는다: " + spec, got && bare == wantMods && vk == wantVk,
            "ok=" + got + " mods=0x" + bare.ToString("X") + " vk=0x" + vk.ToString("X"));
    }

    private static void No(string spec, string why)
    {
        uint mods, vk;
        Check("거절한다: " + (spec ?? "(null)") + " — " + why,
            !Hotkeys.TryParse(spec, out mods, out vk), "받아들여 버렸다");
    }

    private static void Fmt(Keys k, string want)
    {
        string got = Hotkeys.FormatFromKeys(k);
        Check("적는다: " + k + " -> " + want, got == want, "got=" + (got ?? "null"));
    }

    private static void FmtNull(Keys k, string why)
    {
        string got = Hotkeys.FormatFromKeys(k);
        Check("적지 않는다: " + k + " — " + why, got == null, "got=" + (got ?? "null"));
    }

    private static void Check(string what, bool ok, string detail)
    {
        if (ok) Console.WriteLine("PASS " + what);
        else
        {
            _fail++;
            Console.WriteLine("FAIL " + what + " — " + detail);
        }
    }
}

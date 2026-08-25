using System;
using System.IO;
using System.Text;
using TodoPopup;

/// <summary>
/// settings.json 은 C# 판과 Electron 판이 같이 쓴다. 그 계약이 실제로 지켜지는지 본다.
///
/// 막는 사고 (사용자 폴더에서 실제로 벌어졌다)
///   Electron 이 쓴 settings.json 을 C# 이 DataContractJsonSerializer 로 읽다가
///   예외가 나서 매 실행마다 settings.json.corrupt-&lt;시각&gt; 으로 격리했다. 열 개가 쌓였고
///   그동안 사용자의 설정은 한 번도 반영되지 않았다. 저장하면 아는 키 11개만 남기고
///   autostart·단축키·캘린더 설정을 지웠다(533바이트 -&gt; 292바이트).
/// </summary>
public static class SettingsTest
{
    private static int _fail;

    public static int Main()
    {
        string dir = Path.Combine(Path.GetTempPath(), "todo-settings-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        Environment.SetEnvironmentVariable("TODO_DATA_DIR", dir);

        // TODO_DATA_DIR 을 실제로 보는가 — 안 보면 이 시험이 실사용 원장을 만진다.
        Check("데이터 디렉터리를 주입할 수 있다", Storage.DataDir == dir,
            "Storage.DataDir=" + Storage.DataDir);

        string path = Path.Combine(dir, "settings.json");

        // Electron 이 쓰는 모양: 사전순이 아니고, 우리가 모르는 키가 있고, 빈 배열이 있다.
        string electron = "{\n"
            + "    \"defaultCalendarId\":  \"default\",\n"
            + "    \"opacity\":  0.8,\n"
            + "    \"position\":  \"top-center\",\n"
            + "    \"popupWidth\":  380,\n"
            + "    \"popupHeight\":  170,\n"
            + "    \"defaultRenotifyMinutes\":  7,\n"
            + "    \"defaultSnoozeMinutes\":  10,\n"
            + "    \"playSound\":  true,\n"
            + "    \"showClosed\":  true,\n"
            + "    \"autostart\":  true,\n"
            + "    \"calendarOpacity\":  0.8,\n"
            + "    \"calendarOpaqueOnFocus\":  false,\n"
            + "    \"snapMinutes\":  15,\n"
            + "    \"defaultReminderMinutes\":  [\n\n                               ],\n"
            + "    \"hotkeyList\":  \"Control+Alt+T\",\n"
            + "    \"hotkeyNew\":  \"Control+Alt+N\"\n"
            + "}\n";
        File.WriteAllText(path, electron, new UTF8Encoding(false));

        // ---- 읽기 ----
        AppSettings s = Storage.LoadSettings();
        Check("Electron 이 쓴 값을 읽는다 (position)", s.Position == "top-center", "position=" + s.Position);
        Check("Electron 이 쓴 값을 읽는다 (opacity)", Math.Abs(s.Opacity - 0.8) < 0.0001, "opacity=" + s.Opacity);
        Check("사전순이 아니어도 뒤쪽 키를 읽는다", s.DefaultRenotifyMinutes == 7,
            "defaultRenotifyMinutes=" + s.DefaultRenotifyMinutes);
        Check("없는 키는 기본값으로 (truncateSeconds)", s.TruncateSeconds, "truncateSeconds=" + s.TruncateSeconds);
        Check("없는 키는 기본값으로 (popupEffect)", s.PopupEffect == "flash", "popupEffect=" + s.PopupEffect);
        Check("읽기만으로 파일을 격리하지 않는다",
            Directory.GetFiles(dir, "settings.json.corrupt-*").Length == 0,
            "격리 파일 " + Directory.GetFiles(dir, "settings.json.corrupt-*").Length + "개");

        // ---- 쓰기 ----
        s.PopupEffect = "pulse";
        s.TruncateSeconds = false;
        Storage.SaveSettings(s);
        string after = File.ReadAllText(path, Encoding.UTF8);

        Check("저장해도 모르는 키가 살아남는다 (autostart)", after.Contains("\"autostart\""), after);
        Check("저장해도 모르는 키가 살아남는다 (hotkeyList)", after.Contains("\"hotkeyList\""), after);
        Check("저장해도 모르는 키가 살아남는다 (defaultReminderMinutes)",
            after.Contains("\"defaultReminderMinutes\""), after);
        Check("저장해도 모르는 키가 살아남는다 (calendarOpaqueOnFocus)",
            after.Contains("\"calendarOpaqueOnFocus\""), after);
        Check("우리 키는 갱신된다 (popupEffect)", after.Contains("\"popupEffect\": \"pulse\""), after);
        Check("우리 키는 갱신된다 (truncateSeconds)", after.Contains("\"truncateSeconds\": false"), after);
        Check("저장이 파일을 격리하지 않는다",
            Directory.GetFiles(dir, "settings.json.corrupt-*").Length == 0,
            "격리 파일 " + Directory.GetFiles(dir, "settings.json.corrupt-*").Length + "개");

        // ---- 왕복 ----
        AppSettings again = Storage.LoadSettings();
        Check("왕복해도 값이 그대로다", again.PopupEffect == "pulse" && !again.TruncateSeconds && again.Position == "top-center",
            "effect=" + again.PopupEffect + " truncate=" + again.TruncateSeconds + " pos=" + again.Position);

        // ---- 정말 못 읽는 파일은? ----
        File.WriteAllText(path, "이건 JSON 이 아니다", new UTF8Encoding(false));
        AppSettings broken = Storage.LoadSettings();
        Check("JSON 이 아니면 기본값으로 떨어지되 죽지 않는다",
            broken.Position == "bottom-center" && broken.PopupEffect == "flash",
            "pos=" + broken.Position);

        try { Directory.Delete(dir, true); }
        catch { }

        Console.WriteLine(_fail == 0 ? "ALL PASS" : "FAILED " + _fail);
        return _fail;
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

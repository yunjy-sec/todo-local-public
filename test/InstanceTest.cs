using System;
using TodoPopup;

/// <summary>
/// 두 번째 실행이 무엇을 할지 정하는 표, 그리고 명패의 왕복.
///
/// 왜 이렇게 시험하는가
///   같은 함정을 두 번 밟았다. 쌍둥이 팝업 사고는 모니터가 2대여야만 났고 CI 의 가상
///   디스플레이는 1대였다 — 검사는 내내 초록이었고 사용자 기계에서만 앱이 죽었다.
///   이 기능도 "인스턴스가 둘인 상태" 를 만들어야만 시험할 수 있게 짜면 같은 일이 난다.
///   그래서 판단을 화면·프로세스·창에서 완전히 떼어 놓고 표만 넣는다.
///
/// 막는 사고
///   낡은 복사본이 잠금을 쥐고 있으면 새 복사본이 종료 코드 0 으로 조용히 사라졌다.
///   사용자는 그것을 "업데이트가 반영 안 됐다" 로 읽었다.
/// </summary>
public static class InstanceTest
{
    private static int _fail;

    public static int Main()
    {
        string mine = @"C:\Users\yunjy\Downloads\todo-local-public";
        string other = @"C:\Users\yunjy\Downloads\todo3";

        // ---- 결정표 ----

        Case("잠금을 얻으면 평소대로 시작한다",
            true, mine, Plate(other), Args(), InstanceAction.StartNormally);

        Case("같은 폴더의 두 번째 실행은 조용하다",
            false, mine, Plate(mine), Args(), InstanceAction.ShowExistingAndQuit);

        Case("같은 폴더면 --calendar 여도 조용하다",
            false, mine, Plate(mine), Args("--calendar"), InstanceAction.ShowExistingAndQuit);

        Case("끝 역슬래시와 대소문자는 같은 폴더로 본다",
            false, mine, Plate(mine.ToUpper() + "\\"), Args(), InstanceAction.ShowExistingAndQuit);

        Case("다른 폴더면 정체를 알려 준다",
            false, mine, Plate(other), Args(), InstanceAction.TellKnown);

        Case("명패가 없으면 정체 불명이다",
            false, mine, null, Args(), InstanceAction.TellUnknown);

        // 사람이 안 보는 경로는 명패가 있든 없든, 폴더가 같든 다르든 화면이 없다.
        Case("--hidden 은 화면 없이 물러난다",
            false, mine, Plate(other), Args("--hidden"), InstanceAction.StepAsideSilently);

        Case("--hidden 은 명패가 없어도 화면 없이 물러난다",
            false, mine, null, Args("--hidden"), InstanceAction.StepAsideSilently);

        Case("--test-popup 은 화면 없이 물러난다",
            false, mine, Plate(other), Args("--test-popup"), InstanceAction.StepAsideSilently);

        Case("--hidden 은 같은 폴더여도 창을 부르지 않는다",
            false, mine, Plate(mine), Args("--hidden"), InstanceAction.StepAsideSilently);

        // ---- 다른 점 문구 ----

        Check("폴더가 다르면 그렇게 말한다",
            InstanceDecision.DifferenceText(Plate(other, "20260612_094412"), mine, "20260825_101733")
                .StartsWith("다른 점: 폴더 · 빌드 시각"),
            InstanceDecision.DifferenceText(Plate(other, "20260612_094412"), mine, "20260825_101733"));

        Check("어느 쪽이 새것인지 말한다",
            InstanceDecision.AgeText("20260612_094412", "20260825_101733").Contains("이 복사본이")
            && InstanceDecision.AgeText("20260612_094412", "20260825_101733").Contains("74일"),
            InstanceDecision.AgeText("20260612_094412", "20260825_101733"));

        Check("낡은 것을 실행했으면 그렇게 말한다",
            InstanceDecision.AgeText("20260825_101733", "20260612_094412").Contains("지금 도는 판이"),
            InstanceDecision.AgeText("20260825_101733", "20260612_094412"));

        // ZIP 해제는 mtime 을 보존하므로 두 복사본의 빌드 스탬프가 같을 수 있다.
        // 그때도 폴더가 다르면 안내는 떠야 한다.
        Check("빌드가 같아도 폴더가 다르면 안내한다",
            InstanceDecision.Decide(false, mine, Plate(other, "20260825_101733"), Args()) == InstanceAction.TellKnown,
            "빌드 동일 + 폴더 상이");
        Check("빌드가 같으면 나이를 말하지 않는다",
            InstanceDecision.DifferenceText(Plate(other, "20260825_101733"), mine, "20260825_101733") == "다른 점: 폴더",
            InstanceDecision.DifferenceText(Plate(other, "20260825_101733"), mine, "20260825_101733"));

        Check("스탬프를 못 읽으면 나이를 지어내지 않는다",
            InstanceDecision.AgeText("unknown", "20260825_101733") == "",
            InstanceDecision.AgeText("unknown", "20260825_101733"));

        // ---- 명패 왕복 ----

        {
            InstanceInfo a = new InstanceInfo();
            a.Pid = 23744;
            a.SessionId = 2;
            a.StartedAtUtc = DateTime.UtcNow.ToBinary();
            a.Hwnd = 0x12345;
            a.MachineName = Environment.MachineName;
            a.ExePath = other;
            a.Build = "20260612_094412";
            a.AcceptsExitRequest = true;

            InstanceInfo b = InstanceInfo.Deserialize(a.Serialize());
            Check("명패가 왕복한다", b != null
                && b.Pid == a.Pid && b.SessionId == a.SessionId
                && b.StartedAtUtc == a.StartedAtUtc && b.Hwnd == a.Hwnd
                && b.MachineName == a.MachineName && b.ExePath == a.ExePath
                && b.Build == a.Build && b.AcceptsExitRequest,
                b == null ? "null" : b.Serialize());

            // 역슬래시가 든 경로가 이스케이프를 거쳐 살아 돌아와야 한다.
            Check("역슬래시 경로가 상하지 않는다", b != null && b.ExePath == other,
                b == null ? "null" : b.ExePath);
        }

        Check("남의 형식은 명패로 받아들이지 않는다",
            InstanceInfo.Deserialize("{\"magic\":\"XXXX\",\"schema\":1}") == null, "magic 불일치");
        Check("모르는 판(schema)은 정체 불명으로 다룬다",
            InstanceInfo.Deserialize("{\"magic\":\"TDPI\",\"schema\":99}") == null, "schema 불일치");
        Check("쓰레기를 읽어도 죽지 않는다",
            InstanceInfo.Deserialize("이건 JSON 이 아니다") == null, "비 JSON");

        // ---- 명패는 다른 기계 것이면 못 믿는다 ----
        {
            InstanceInfo far = Plate(other);
            far.MachineName = "SOMEONE-ELSE-PC";
            far.Pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            Check("다른 기계의 명패는 믿지 않는다", !far.IsTrustworthy(), "machine=" + far.MachineName);
        }
        {
            InstanceInfo dead = Plate(other);
            dead.Pid = 999999; // 있을 법하지 않은 pid
            Check("죽은 pid 의 명패는 믿지 않는다", !dead.IsTrustworthy(), "pid=" + dead.Pid);
        }
        {
            InstanceInfo reused = Plate(other);
            System.Diagnostics.Process me = System.Diagnostics.Process.GetCurrentProcess();
            reused.Pid = me.Id;
            reused.StartedAtUtc = DateTime.UtcNow.AddDays(-3).ToBinary(); // 시작 시각이 어긋난다
            Check("pid 는 살아 있어도 시작 시각이 다르면 믿지 않는다 (pid 재사용)",
                !reused.IsTrustworthy(), "pid 재사용");
        }

        Console.WriteLine(_fail == 0 ? "ALL PASS" : "FAILED " + _fail);
        return _fail;
    }

    private static string[] Args(params string[] a) { return a; }

    private static InstanceInfo Plate(string path) { return Plate(path, "20260612_094412"); }

    private static InstanceInfo Plate(string path, string build)
    {
        InstanceInfo n = new InstanceInfo();
        n.Pid = 23744;
        n.SessionId = 1;
        n.MachineName = Environment.MachineName;
        n.ExePath = path;
        n.Build = build;
        n.AcceptsExitRequest = true;
        return n;
    }

    private static void Case(string what, bool gotLock, string myPath, InstanceInfo holder,
        string[] args, InstanceAction want)
    {
        InstanceAction got = InstanceDecision.Decide(gotLock, myPath, holder, args);
        Check(what, got == want, "got=" + got + " want=" + want);
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

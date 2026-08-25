using System;

namespace TodoPopup
{
    internal enum InstanceAction
    {
        /// <summary>잠금을 얻었다. 평소대로 시작한다.</summary>
        StartNormally,

        /// <summary>같은 복사본이다. 지금까지와 똑같이 — 기존 창을 띄우고 조용히 끝난다.</summary>
        ShowExistingAndQuit,

        /// <summary>사람이 안 보는 경로다. 화면을 띄우지 않고 물러난다.</summary>
        StepAsideSilently,

        /// <summary>다른 폴더의 판이 돌고 있고, 그 정체를 안다.</summary>
        TellKnown,

        /// <summary>돌고 있는 판의 정체를 모른다. 끄는 단추를 그리지 않는다.</summary>
        TellUnknown,
    }

    /// <summary>
    /// 두 번째 실행에서 무엇을 할지 정하는 **순수 함수**.
    ///
    /// 왜 함수로 떼어 놓았는가
    ///   같은 함정을 두 번 밟았다. 쌍둥이 팝업 사고는 모니터가 2대여야만 났고, CI 의 가상
    ///   디스플레이는 1대라 검사가 내내 초록이었다. 이 기능도 그대로 두면 "인스턴스가 둘인
    ///   상태" 를 만들어야만 시험할 수 있다. 그래서 판단을 화면·프로세스·창에서 완전히
    ///   떼어 냈다 — 표만 넣으면 시험이 된다(test/InstanceTest.cs).
    ///
    /// 이 함수는 아무것도 죽이지 않고 아무것도 쓰지 않는다. 무엇을 할지만 답한다.
    /// </summary>
    internal static class InstanceDecision
    {
        /// <param name="gotLock">뮤텍스를 얻었는가. 이것이 유일한 권위다.</param>
        /// <param name="myPath">이 복사본의 폴더.</param>
        /// <param name="holder">읽어 온 명패. 없거나 못 믿으면 null.</param>
        /// <param name="args">명령줄.</param>
        public static InstanceAction Decide(bool gotLock, string myPath, InstanceInfo holder, string[] args)
        {
            if (gotLock) return InstanceAction.StartNormally;

            // 사람이 안 보는 경로가 먼저다. 로그온 직후의 창은 셸이 준비되기 전에 떠서
            // 다른 창 뒤로 숨고 포커스를 훔치며, 사용자는 보지도 못한다.
            if (HasFlag(args, "--hidden") || HasFlag(args, "--test-popup"))
                return InstanceAction.StepAsideSilently;

            // 명패가 없다 = 명패를 쓸 줄 모르는 더 낡은 판이 잠금을 쥐고 있다.
            if (holder == null) return InstanceAction.TellUnknown;

            // 같은 폴더의 복사본이면 지금까지와 똑같이 조용하다. 바로가기를 두 번 누르는 것은
            // 정상 사용이고, 매번 물으면 사용자는 상자를 읽지 않고 닫는 법을 배운다.
            if (InstanceInfo.SamePath(holder.ExePath, myPath))
                return InstanceAction.ShowExistingAndQuit;

            return InstanceAction.TellKnown;
        }

        /// <summary>사람에게 보여 줄 "무엇이 다른가" 한 줄. 다른 점이 없으면 빈 문자열.</summary>
        public static string DifferenceText(InstanceInfo holder, string myPath, string myBuild)
        {
            if (holder == null) return "";
            bool pathDiffers = !InstanceInfo.SamePath(holder.ExePath, myPath);
            bool buildDiffers = holder.Build != myBuild;
            if (!pathDiffers && !buildDiffers) return "";

            string what = pathDiffers && buildDiffers ? "폴더 · 빌드 시각"
                : pathDiffers ? "폴더" : "빌드 시각";
            // 나이는 빌드가 실제로 다를 때만 말한다. ZIP 해제는 mtime 을 보존해서 두 복사본의
            // 스탬프가 같을 수 있는데, 그때 "(빌드 시각이 같습니다)" 를 덧붙이면 군더더기다.
            string age = buildDiffers ? AgeText(holder.Build, myBuild) : "";
            return "다른 점: " + what + (age.Length > 0 ? " (" + age + ")" : "");
        }

        /// <summary>빌드 스탬프 두 개를 견줘 "이 복사본이 74일 새것" 같은 말로.</summary>
        public static string AgeText(string holderBuild, string myBuild)
        {
            DateTime a, b;
            if (!TryStamp(holderBuild, out a) || !TryStamp(myBuild, out b)) return "";
            TimeSpan d = b - a;
            int days = (int)Math.Round(Math.Abs(d.TotalDays));
            string who = d.TotalSeconds > 0 ? "이 복사본이" : "지금 도는 판이";
            if (Math.Abs(d.TotalMinutes) < 1) return "빌드 시각이 같습니다";
            if (days < 1)
            {
                int hours = (int)Math.Round(Math.Abs(d.TotalHours));
                if (hours < 1) return who + " " + (int)Math.Round(Math.Abs(d.TotalMinutes)) + "분 새것";
                return who + " " + hours + "시간 새것";
            }
            return who + " " + days + "일 새것";
        }

        private static bool TryStamp(string s, out DateTime dt)
        {
            dt = DateTime.MinValue;
            if (string.IsNullOrEmpty(s) || s.Length != 15 || s[8] != '_') return false;
            return DateTime.TryParseExact(s, "yyyyMMdd_HHmmss",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out dt);
        }

        public static bool HasFlag(string[] args, string flag)
        {
            if (args == null) return false;
            foreach (string a in args) if (a == flag) return true;
            return false;
        }
    }
}

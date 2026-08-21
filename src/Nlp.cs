using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace TodoPopup
{
    public class NlpResult
    {
        public bool HasTime;
        public DateTime When;
        public string Title;
        public string Matched;

        public NlpResult()
        {
            Title = "";
            Matched = "";
        }
    }

    // 한국어 시간 표현 파서.
    // 지원: "30분 뒤", "1시간 반 후", "두시간 뒤", "3일 뒤", "내일 오후 3시",
    //       "모레 14:30", "8월 21일 9시", "8/21 저녁", "다음주 월요일 3시 반", "점심에" 등
    public static class Nlp
    {
        private class Seg
        {
            public int Start;
            public int Length;
            public Seg(int s, int l) { Start = s; Length = l; }
        }

        private const string WordNums = "한|두|세|네|다섯|여섯|일곱|여덟|아홉|열한|열두|열";

        private static int WordNum(string w)
        {
            switch (w)
            {
                case "한": return 1;
                case "두": return 2;
                case "세": return 3;
                case "네": return 4;
                case "다섯": return 5;
                case "여섯": return 6;
                case "일곱": return 7;
                case "여덟": return 8;
                case "아홉": return 9;
                case "열": return 10;
                case "열한": return 11;
                case "열두": return 12;
                default: return 0;
            }
        }

        public static NlpResult Parse(string text, DateTime now)
        {
            NlpResult r = new NlpResult();
            if (text == null) text = "";
            r.Title = CleanTitle(text);
            if (r.Title.Length == 0 && text.Trim().Length == 0) return r;

            List<Seg> segs = new List<Seg>();
            List<string> matched = new List<string>();

            // ---- 1) 상대 시간: N시간 (M분|반)? 뒤 / N분 뒤 ----
            Match m = Regex.Match(text,
                "(?:([0-9]{1,3})|(" + WordNums + "))\\s*시간\\s*(?:([0-9]{1,2})\\s*분|(반))?\\s*(?:뒤|후)(?:에)?");
            if (m.Success)
            {
                int h = m.Groups[1].Success ? int.Parse(m.Groups[1].Value) : WordNum(m.Groups[2].Value);
                int mm = 0;
                if (m.Groups[3].Success) mm = int.Parse(m.Groups[3].Value);
                else if (m.Groups[4].Success) mm = 30;
                r.When = now.AddHours(h).AddMinutes(mm);
                r.HasTime = true;
                segs.Add(new Seg(m.Index, m.Length));
                matched.Add(m.Value.Trim());
                Finish(r, text, segs, matched);
                return r;
            }

            m = Regex.Match(text, "([0-9]{1,4})\\s*분\\s*(?:뒤|후)(?:에)?");
            if (m.Success)
            {
                r.When = now.AddMinutes(int.Parse(m.Groups[1].Value));
                r.HasTime = true;
                segs.Add(new Seg(m.Index, m.Length));
                matched.Add(m.Value.Trim());
                Finish(r, text, segs, matched);
                return r;
            }

            // ---- 2) 날짜 부분 ----
            bool hasDay = false;
            bool weekdayAuto = false;
            DateTime baseDate = now.Date;

            m = Regex.Match(text, "([0-9]{1,3})\\s*일\\s*(?:뒤|후)(?:에)?");
            if (m.Success)
            {
                baseDate = now.Date.AddDays(int.Parse(m.Groups[1].Value));
                hasDay = true;
                segs.Add(new Seg(m.Index, m.Length));
                matched.Add(m.Value.Trim());
            }

            if (!hasDay)
            {
                m = Regex.Match(text, "오늘|내일모레|내일|모레|글피");
                if (m.Success)
                {
                    int off = 0;
                    if (m.Value == "내일") off = 1;
                    else if (m.Value == "모레" || m.Value == "내일모레") off = 2;
                    else if (m.Value == "글피") off = 3;
                    baseDate = now.Date.AddDays(off);
                    hasDay = true;
                    segs.Add(new Seg(m.Index, m.Length));
                    matched.Add(m.Value);
                }
            }

            if (!hasDay)
            {
                m = Regex.Match(text, "([0-9]{1,2})\\s*월\\s*([0-9]{1,2})\\s*일(?:에)?");
                if (m.Success)
                {
                    int mo = int.Parse(m.Groups[1].Value);
                    int d = int.Parse(m.Groups[2].Value);
                    if (mo >= 1 && mo <= 12 && d >= 1 && d <= DateTime.DaysInMonth(now.Year, mo))
                    {
                        baseDate = new DateTime(now.Year, mo, d);
                        if (baseDate < now.Date) baseDate = baseDate.AddYears(1);
                        hasDay = true;
                        segs.Add(new Seg(m.Index, m.Length));
                        matched.Add(m.Value.Trim());
                    }
                }
            }

            if (!hasDay)
            {
                m = Regex.Match(text, "(?<![0-9./])([0-9]{1,2})\\s*/\\s*([0-9]{1,2})(?![0-9./:])");
                if (m.Success)
                {
                    int mo = int.Parse(m.Groups[1].Value);
                    int d = int.Parse(m.Groups[2].Value);
                    if (mo >= 1 && mo <= 12 && d >= 1 && d <= DateTime.DaysInMonth(now.Year, mo))
                    {
                        baseDate = new DateTime(now.Year, mo, d);
                        if (baseDate < now.Date) baseDate = baseDate.AddYears(1);
                        hasDay = true;
                        segs.Add(new Seg(m.Index, m.Length));
                        matched.Add(m.Value.Trim());
                    }
                }
            }

            if (!hasDay)
            {
                m = Regex.Match(text, "(?:(다음\\s*주|담주)\\s*)?([월화수목금토일])요일(?:에)?");
                if (m.Success)
                {
                    string[] order = { "일", "월", "화", "수", "목", "금", "토" };
                    int target = Array.IndexOf(order, m.Groups[2].Value);
                    bool nextWeek = m.Groups[1].Success;
                    if (nextWeek)
                    {
                        // "다음주 X요일" = 다음 달력 주(월요일 시작)의 X요일
                        int mondayOffset = ((int)now.DayOfWeek + 6) % 7;
                        DateTime thisWeekMonday = now.Date.AddDays(-mondayOffset);
                        int targetOffset = (target + 6) % 7;
                        baseDate = thisWeekMonday.AddDays(7 + targetOffset);
                    }
                    else
                    {
                        weekdayAuto = true;
                        baseDate = now.Date.AddDays((target - (int)now.DayOfWeek + 7) % 7);
                    }
                    hasDay = true;
                    segs.Add(new Seg(m.Index, m.Length));
                    matched.Add(m.Value.Trim());
                }
            }

            // ---- 3) 시각 부분 ----
            bool hasClock = false;
            bool clockDigits = false;
            bool colonNotation = false;
            int hour = 9, minute = 0;
            string mer = null;

            m = Regex.Match(text, "(?:(오전|오후|아침|점심|저녁|밤|새벽)\\s*)?([0-9]{1,2})\\s*[:：]\\s*([0-9]{2})(?:에)?");
            if (m.Success)
            {
                int h = int.Parse(m.Groups[2].Value);
                int mm2 = int.Parse(m.Groups[3].Value);
                if (h <= 23 && mm2 <= 59)
                {
                    if (m.Groups[1].Success) mer = m.Groups[1].Value;
                    hour = h;
                    minute = mm2;
                    hasClock = true;
                    clockDigits = true;
                    colonNotation = true; // "HH:MM"은 명시적 24시간 표기로 취급
                    segs.Add(new Seg(m.Index, m.Length));
                    matched.Add(m.Value.Trim());
                }
            }

            if (!hasClock)
            {
                m = Regex.Match(text,
                    "(?:(오전|오후|아침|점심|저녁|밤|새벽)\\s*)?(?:([0-9]{1,2})|(" + WordNums + "))\\s*시(?!간)(?:\\s*(?:([0-9]{1,2})\\s*분|(반)))?(?:에)?");
                if (m.Success)
                {
                    int h = m.Groups[2].Success ? int.Parse(m.Groups[2].Value) : WordNum(m.Groups[3].Value);
                    if (h >= 0 && h <= 24)
                    {
                        if (m.Groups[1].Success) mer = m.Groups[1].Value;
                        hour = h;
                        minute = 0;
                        if (m.Groups[4].Success) minute = Math.Min(59, int.Parse(m.Groups[4].Value));
                        else if (m.Groups[5].Success) minute = 30;
                        hasClock = true;
                        clockDigits = true;
                        segs.Add(new Seg(m.Index, m.Length));
                        matched.Add(m.Value.Trim());
                    }
                }
            }

            if (!hasClock)
            {
                m = Regex.Match(text, "(정오|자정|아침|점심|저녁|밤|새벽|오전|오후)(?:에)?");
                if (m.Success)
                {
                    string w = m.Groups[1].Value;
                    minute = 0;
                    if (w == "정오" || w == "점심") hour = 12;
                    else if (w == "자정") hour = 0;
                    else if (w == "아침") hour = 8;
                    else if (w == "오전") hour = 9;
                    else if (w == "오후") hour = 14;
                    else if (w == "저녁") hour = 18;
                    else if (w == "밤") hour = 21;
                    else if (w == "새벽") hour = 5;
                    hasClock = true;
                    segs.Add(new Seg(m.Index, m.Length));
                    matched.Add(m.Value.Trim());
                }
            }

            if (!hasDay && !hasClock)
            {
                r.HasTime = false;
                return r;
            }

            // 오전/오후 보정
            if (clockDigits)
            {
                if (mer == "오후" || mer == "저녁" || mer == "밤" || mer == "점심")
                {
                    if (mer == "밤" && hour == 12)
                    {
                        // "밤 12시" = 자정
                        hour = 0;
                        if (hasDay) baseDate = baseDate.AddDays(1);
                    }
                    else if (hour < 12) hour += 12;
                }
                else if (mer == "오전" || mer == "아침" || mer == "새벽")
                {
                    if (hour == 12) hour = 0;
                }
                else if (mer == null && !colonNotation)
                {
                    // 관용적 해석: 1~7시는 오후로 본다 ("3시 회의" = 15:00).
                    // "3:00" 같은 콜론 표기는 명시적이므로 보정하지 않는다.
                    if (hour >= 1 && hour <= 7) hour += 12;
                }
            }

            if (hour > 23) hour = 23;
            DateTime when = baseDate.AddHours(hour).AddMinutes(minute);

            if (!hasDay && hasClock)
            {
                if (when <= now) when = when.AddDays(1);
            }
            else if (weekdayAuto && when <= now)
            {
                when = when.AddDays(7);
            }

            r.When = when;
            r.HasTime = true;
            Finish(r, text, segs, matched);
            return r;
        }

        private static void Finish(NlpResult r, string text, List<Seg> segs, List<string> matched)
        {
            segs.Sort(delegate(Seg a, Seg b) { return b.Start.CompareTo(a.Start); });
            string t = text;
            // 세그먼트가 겹칠 수 있으므로(예: "3/4:30") 이미 제거한 영역과 겹치는 부분은 클램프한다.
            int prevStart = t.Length;
            foreach (Seg s in segs)
            {
                int end = Math.Min(s.Start + s.Length, prevStart);
                if (end > s.Start)
                {
                    t = t.Remove(s.Start, end - s.Start);
                    prevStart = s.Start;
                }
            }
            r.Title = CleanTitle(t);
            r.Matched = string.Join(" ", matched.ToArray());
        }

        private static string CleanTitle(string t)
        {
            t = Regex.Replace(t ?? "", "\\s+", " ").Trim();
            return t.Trim(' ', ',', '·', '-');
        }
    }
}

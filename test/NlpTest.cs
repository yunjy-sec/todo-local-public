using System;
using TodoPopup;

// 자연어 파서 검증 하네스 (배포 제외, 개발용)
public static class NlpTest
{
    private static int _fail;

    public static int Main()
    {
        DateTime now = new DateTime(2026, 8, 20, 15, 53, 0); // 목요일 오후

        Check(now, "내일 오후 3시 회의", new DateTime(2026, 8, 21, 15, 0, 0), "회의");
        Check(now, "30분 뒤 스트레칭", now.AddMinutes(30), "스트레칭");
        Check(now, "1시간 반 후 운동", now.AddMinutes(90), "운동");
        Check(now, "두시간 뒤 빨래", now.AddHours(2), "빨래");
        Check(now, "3시 반 회의", new DateTime(2026, 8, 21, 15, 30, 0), "회의"); // 15:30 지남 → 내일
        Check(now, "8시 회의", new DateTime(2026, 8, 21, 8, 0, 0), "회의"); // 오전 해석, 지남 → 내일
        Check(now, "17시 보고", new DateTime(2026, 8, 20, 17, 0, 0), "보고");
        Check(now, "오늘 18:00 퇴근", new DateTime(2026, 8, 20, 18, 0, 0), "퇴근");
        Check(now, "점심에 약 먹기", new DateTime(2026, 8, 21, 12, 0, 0), "약 먹기"); // 오늘 12시 지남 → 내일
        Check(now, "저녁 회식", new DateTime(2026, 8, 20, 18, 0, 0), "회식");
        Check(now, "모레 아침 9시 출장", new DateTime(2026, 8, 22, 9, 0, 0), "출장");
        Check(now, "8월 21일 9시 발표", new DateTime(2026, 8, 21, 9, 0, 0), "발표");
        Check(now, "8/25 14:30 병원", new DateTime(2026, 8, 25, 14, 30, 0), "병원");
        Check(now, "다음주 월요일 9시 보고", new DateTime(2026, 8, 24, 9, 0, 0), "보고");
        Check(now, "금요일 3시 미팅", new DateTime(2026, 8, 21, 15, 0, 0), "미팅"); // 내일이 금요일
        Check(now, "목요일 10시 리뷰", new DateTime(2026, 8, 27, 10, 0, 0), "리뷰"); // 오늘 목요일 10시 지남 → 다음주
        Check(now, "3일 뒤 오후 2시 검진", new DateTime(2026, 8, 23, 14, 0, 0), "검진");
        Check(now, "자정에 백업 확인", new DateTime(2026, 8, 21, 0, 0, 0), "백업 확인");
        CheckNone(now, "회의 준비");
        CheckNone(now, "보고서 3장 쓰기");

        // 리뷰에서 확정된 결함의 회귀 테스트
        Check(now, "내일 3:00 공항버스", new DateTime(2026, 8, 21, 3, 0, 0), "공항버스"); // 콜론 표기는 오후 보정 제외
        Check(now, "내일모레 9시 검진", new DateTime(2026, 8, 22, 9, 0, 0), "검진");
        Check(now, "밤 12시 정리", new DateTime(2026, 8, 21, 0, 0, 0), "정리"); // 밤 12시 = 자정
        CheckNone(now, "1시간 회의 준비"); // "N시간"(뒤/후 없음)을 "N시"로 오인하면 안 됨
        CheckNone(now, "３０분 뒤 약 먹기"); // 전각 숫자 — 크래시 없이 무시
        CheckNoCrash(now, "3/4:30 배송 확인"); // 겹치는 매치 세그먼트 — 크래시 없어야 함
        CheckNoCrash(now, "회의 3/4:30");

        Console.WriteLine(_fail == 0 ? "ALL PASS" : string.Format("{0} FAILED", _fail));
        return _fail == 0 ? 0 : 1;
    }

    private static void Check(DateTime now, string text, DateTime expected, string expectedTitle)
    {
        NlpResult r = Nlp.Parse(text, now);
        bool ok = r.HasTime && r.When == expected && r.Title == expectedTitle;
        if (!ok)
        {
            _fail++;
            Console.WriteLine("FAIL: \"{0}\"", text);
            Console.WriteLine("  기대: {0:yyyy-MM-dd HH:mm} / \"{1}\"", expected, expectedTitle);
            if (r.HasTime)
                Console.WriteLine("  실제: {0:yyyy-MM-dd HH:mm} / \"{1}\"", r.When, r.Title);
            else
                Console.WriteLine("  실제: 시간 인식 실패 / \"{0}\"", r.Title);
        }
        else
        {
            Console.WriteLine("PASS: \"{0}\" -> {1:MM-dd HH:mm} \"{2}\"", text, r.When, r.Title);
        }
    }

    private static void CheckNoCrash(DateTime now, string text)
    {
        try
        {
            NlpResult r = Nlp.Parse(text, now);
            Console.WriteLine("PASS: \"{0}\" -> 예외 없음 (HasTime={1}, Title=\"{2}\")", text, r.HasTime, r.Title);
        }
        catch (Exception ex)
        {
            _fail++;
            Console.WriteLine("FAIL: \"{0}\" — 예외 발생: {1}", text, ex.GetType().Name);
        }
    }

    private static void CheckNone(DateTime now, string text)
    {
        NlpResult r = Nlp.Parse(text, now);
        if (r.HasTime)
        {
            _fail++;
            Console.WriteLine("FAIL: \"{0}\" — 시간이 없어야 하는데 {1:MM-dd HH:mm} 로 인식", text, r.When);
        }
        else
        {
            Console.WriteLine("PASS: \"{0}\" -> 시간 없음", text);
        }
    }
}

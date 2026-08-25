using System;
using TodoPopup;

public static class SnapTest
{
    public static int Main()
    {
        int fail = 0;
        DateTime at = new DateTime(2026, 8, 25, 14, 0, 30);

        // "1분 뒤" 를 14:00:30 에 말하면 14:01:00 이어야 한다(14:01:30 이 아니라).
        DateTime got = TimeUtil.SnapSeconds(at.AddMinutes(1), true);
        DateTime want = new DateTime(2026, 8, 25, 14, 1, 0);
        if (got != want) { Console.WriteLine("FAIL on: " + got + " want " + want); fail++; }
        else Console.WriteLine("PASS 초 버림: 14:00:30 + 1min -> " + got.ToString("HH:mm:ss"));

        // 끄면 그대로 둔다.
        DateTime off = TimeUtil.SnapSeconds(at.AddMinutes(1), false);
        if (off.Second != 30) { Console.WriteLine("FAIL off: " + off); fail++; }
        else Console.WriteLine("PASS 끄면 그대로: " + off.ToString("HH:mm:ss"));

        Console.WriteLine(fail == 0 ? "ALL PASS" : "FAILED " + fail);
        return fail;
    }
}

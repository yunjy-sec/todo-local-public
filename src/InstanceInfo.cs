using System;
using System.Globalization;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Text;

namespace TodoPopup
{
    /// <summary>
    /// 도는 인스턴스가 내거는 **명패**. 어디 있는 어느 판이 지금 잠금을 쥐고 있는가.
    ///
    /// 왜 있는가
    ///   뮤텍스는 "누가 쥐고 있다" 만 알려 주고 "누가" 는 알려 주지 않는다. 그래서 새 복사본은
    ///   종료 코드 0 으로 조용히 사라졌고, 사용자는 낡은 판이 이겼다는 것을 알 방법이 없어
    ///   "업데이트가 반영 안 됐다" 로 판단했다. 명패는 그 "누가" 를 적어 두는 자리다.
    ///
    /// 왜 파일이 아니라 메모리 맵인가
    ///   수명과 스코프가 뮤텍스와 정확히 같다. 프로세스가 죽으면 이름이 사라지므로
    ///   **낡은 명패라는 것이 존재하지 않는다** — pid 재사용을 걱정할 코드가 아예 없다.
    ///   OpenExisting 이 실패하면 그것은 곧 "명패를 쓸 줄 모르는 더 낡은 판이 잠금을 쥐고 있다"
    ///   는 뜻이고, 그 판정이 정확히 우리가 원하는 판정이다.
    ///
    /// 권위는 언제나 "잠금을 못 얻었다" 는 사실이다. 명패는 이름표일 뿐이며,
    /// 없거나 어긋나면 그냥 '정체 불명' 으로 다룬다 — 모르는 것을 죽이지 않는다.
    /// </summary>
    internal class InstanceInfo
    {
        public const string MapName = "Local\\TodoPopup_Instance";
        private const string Magic = "TDPI";
        private const int Schema = 1;
        private const int MapSize = 4096;

        public int Pid;
        public int SessionId;
        public long StartedAtUtc;   // DateTime.ToBinary()
        public long Hwnd;           // 종료 요청을 받을 창
        public string MachineName;
        public string ExePath;      // 이 복사본이 있는 폴더의 exe
        public string Build;        // exe 의 마지막 쓰기 시각 yyyyMMdd_HHmmss
        public bool AcceptsExitRequest;

        // 살아 있는 동안 쥐고 있어야 이름이 유지된다. 놓으면 명패가 사라진다.
        private MemoryMappedFile _held;

        /// <summary>지금 이 프로세스의 명패를 만든다.</summary>
        public static InstanceInfo ForThisProcess(IntPtr hwnd)
        {
            InstanceInfo n = new InstanceInfo();
            System.Diagnostics.Process me = System.Diagnostics.Process.GetCurrentProcess();
            n.Pid = me.Id;
            n.SessionId = me.SessionId;
            try { n.StartedAtUtc = me.StartTime.ToUniversalTime().ToBinary(); }
            catch { n.StartedAtUtc = 0; }
            n.Hwnd = hwnd.ToInt64();
            n.MachineName = Environment.MachineName;
            n.ExePath = ExeDir();
            n.Build = BuildStamp();
            n.AcceptsExitRequest = true;
            return n;
        }

        /// <summary>명패를 내건다. 실패해도 앱은 그대로 돈다 — 진단용 곁다리다.</summary>
        public bool Publish()
        {
            try
            {
                _held = MemoryMappedFile.CreateNew(MapName, MapSize);
                using (MemoryMappedViewStream vs = _held.CreateViewStream())
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(Serialize());
                    if (bytes.Length > MapSize - 4) return false;
                    vs.Write(BitConverter.GetBytes(bytes.Length), 0, 4);
                    vs.Write(bytes, 0, bytes.Length);
                    vs.Flush();
                }
                return true;
            }
            catch
            {
                _held = null;
                return false;
            }
        }

        public void Release()
        {
            try { if (_held != null) _held.Dispose(); }
            catch { }
            _held = null;
        }

        /// <summary>도는 인스턴스의 명패를 읽는다. 없으면 null — 그것이 '정체 불명' 이다.</summary>
        public static InstanceInfo Read()
        {
            try
            {
                using (MemoryMappedFile mm = MemoryMappedFile.OpenExisting(MapName, MemoryMappedFileRights.Read))
                using (MemoryMappedViewStream vs = mm.CreateViewStream(0, 0, MemoryMappedFileAccess.Read))
                {
                    byte[] head = new byte[4];
                    if (vs.Read(head, 0, 4) != 4) return null;
                    int len = BitConverter.ToInt32(head, 0);
                    if (len <= 0 || len > MapSize - 4) return null;
                    byte[] body = new byte[len];
                    int got = 0;
                    while (got < len)
                    {
                        int r = vs.Read(body, got, len - got);
                        if (r <= 0) break;
                        got += r;
                    }
                    if (got != len) return null;
                    return Deserialize(Encoding.UTF8.GetString(body));
                }
            }
            catch
            {
                // FileNotFoundException 이면 "명패를 쓸 줄 모르는 더 낡은 판" 이다. 정상 판정이다.
                return null;
            }
        }

        /// <summary>
        /// 이 명패를 믿어도 되는가. 하나라도 어긋나면 버린다 — 틀린 정보는 없는 정보보다 나쁘고,
        /// 그 정보로 종료를 제안하면 남의 프로세스를 죽이게 된다.
        /// </summary>
        public bool IsTrustworthy()
        {
            if (Pid <= 0) return false;
            if (MachineName != Environment.MachineName) return false;
            System.Diagnostics.Process p = null;
            try { p = System.Diagnostics.Process.GetProcessById(Pid); }
            catch { return false; } // 이미 없다
            try
            {
                if (p.HasExited) return false;
                if (p.SessionId != System.Diagnostics.Process.GetCurrentProcess().SessionId) return false;
                if (StartedAtUtc != 0)
                {
                    long actual = p.StartTime.ToUniversalTime().ToBinary();
                    if (actual != StartedAtUtc) return false; // pid 재사용
                }
            }
            catch { return false; }
            finally { try { p.Dispose(); } catch { } }
            return true;
        }

        public bool IsAlive()
        {
            if (Pid <= 0) return false;
            try
            {
                using (System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById(Pid))
                    return !p.HasExited;
            }
            catch { return false; }
        }

        public string StartedAtLocalText()
        {
            if (StartedAtUtc == 0) return "";
            try { return DateTime.FromBinary(StartedAtUtc).ToLocalTime().ToString("HH:mm:ss"); }
            catch { return ""; }
        }

        /// <summary>사람이 읽는 "5시간 3분째".</summary>
        public string UptimeText()
        {
            if (StartedAtUtc == 0) return "";
            try
            {
                TimeSpan d = DateTime.UtcNow - DateTime.FromBinary(StartedAtUtc);
                if (d.TotalSeconds < 0) return "";
                if (d.TotalMinutes < 1) return "방금 시작";
                if (d.TotalHours < 1) return ((int)d.TotalMinutes) + "분째";
                return ((int)d.TotalHours) + "시간 " + d.Minutes + "분째";
            }
            catch { return ""; }
        }

        // ---- 이 복사본이 누구인가 ----

        public static string ExeDir()
        {
            try
            {
                string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(exe)) return Path.GetDirectoryName(exe);
            }
            catch { }
            return "";
        }

        public static string BuildStamp()
        {
            try
            {
                string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(exe) && File.Exists(exe))
                    return File.GetLastWriteTime(exe).ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture);
            }
            catch { }
            return "unknown";
        }

        /// <summary>폴더 비교. 대소문자와 끝 역슬래시를 무시한다.</summary>
        public static bool SamePath(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
            return string.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        // ---- 직렬화 (Json.cs 를 쓴다 — 새 도구를 또 만들지 않는다) ----

        public string Serialize()
        {
            System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, string>> p =
                new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, string>>();
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("magic", Json.Quote(Magic)));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("schema", Json.Num(Schema)));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("pid", Json.Num(Pid)));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("sessionId", Json.Num(SessionId)));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("startedAt", Json.Quote(StartedAtUtc.ToString(CultureInfo.InvariantCulture))));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("hwnd", Json.Quote(Hwnd.ToString(CultureInfo.InvariantCulture))));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("machine", Json.Quote(MachineName)));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("path", Json.Quote(ExePath)));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("build", Json.Quote(Build)));
            p.Add(new System.Collections.Generic.KeyValuePair<string, string>("acceptsExit", Json.Bool(AcceptsExitRequest)));
            return Json.Merge("{}", p);
        }

        public static InstanceInfo Deserialize(string text)
        {
            System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, string>> p = Json.ReadObject(text);
            if (Json.GetString(p, "magic", "") != Magic) return null;
            if (Json.GetInt(p, "schema", 0) != Schema) return null; // 모르는 판이면 정체 불명으로 다룬다
            InstanceInfo n = new InstanceInfo();
            n.Pid = Json.GetInt(p, "pid", 0);
            n.SessionId = Json.GetInt(p, "sessionId", -1);
            long v;
            n.StartedAtUtc = long.TryParse(Json.GetString(p, "startedAt", "0"), NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : 0;
            n.Hwnd = long.TryParse(Json.GetString(p, "hwnd", "0"), NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : 0;
            n.MachineName = Json.GetString(p, "machine", "");
            n.ExePath = Json.GetString(p, "path", "");
            n.Build = Json.GetString(p, "build", "");
            n.AcceptsExitRequest = Json.GetBool(p, "acceptsExit", false);
            return n;
        }
    }
}

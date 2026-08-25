using System;
using System.IO;
using System.Reflection;

namespace TodoPopup
{
    /// <summary>
    /// 이 판이 **어느 커밋에서 나왔는가**.
    ///
    /// 왜 빌드 시각이 아닌가
    ///   전에는 exe 의 마지막 쓰기 시각을 보여 줬다. 그것은 코드를 식별하지 못한다 —
    ///   ZIP 을 다시 풀어도, 같은 소스를 다시 빌드해도 값이 바뀐다. 반대로 다른 사람이
    ///   같은 커밋을 어제 빌드했으면 값이 다르다. "지금 도는 판이 무엇인가" 를 물을 때
    ///   답이 되어야 하는 것은 커밋이다.
    ///
    /// 어떻게 들어오는가
    ///   build.cmd 가 commit.txt 를 만들어(git 이 있으면 git 에서, 없으면 저장소에 담겨
    ///   온 것을 그대로) csc /resource: 로 **exe 안에 박는다**. 그래서 파일이 늘지 않는다 —
    ///   이 판의 값은 52KB exe 하나다.
    ///
    ///   ZIP 배포에는 .git 이 없다. 그래서 생성기(tools/cut)가 commit.txt 를 생성물 트리에
    ///   써 넣고, 그 파일이 ZIP 에 담겨 온다.
    /// </summary>
    internal static class BuildInfo
    {
        private static bool _loaded;
        private static string _hash = "";
        private static string _when = "";

        /// <summary>짧은 커밋 해시. 모르면 빈 문자열.</summary>
        public static string Hash { get { Load(); return _hash; } }

        /// <summary>커밋 시각 "yyyy-MM-dd HH:mm". 모르면 빈 문자열.</summary>
        public static string When { get { Load(); return _when; } }

        /// <summary>배너에 넣는 한 토막. 모르면 그 사실을 그대로 말한다.</summary>
        public static string Text
        {
            get
            {
                Load();
                if (_hash.Length == 0 && _when.Length == 0) return "커밋 알 수 없음";
                if (_when.Length == 0) return "커밋 " + _hash;
                if (_hash.Length == 0) return "커밋 " + _when;
                return "커밋 " + _hash + " " + _when;
            }
        }

        private static void Load()
        {
            if (_loaded) return;
            _loaded = true;
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream st = asm.GetManifestResourceStream("commit"))
                {
                    if (st == null) return;
                    using (StreamReader r = new StreamReader(st))
                        Parse(r.ReadToEnd());
                }
            }
            catch { }
        }

        /// <summary>"b88dfd3 2026-08-25T15:26:41+09:00" 한 줄.</summary>
        internal static void Parse(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            string line = text.Trim();
            int nl = line.IndexOf('\n');
            if (nl >= 0) line = line.Substring(0, nl).Trim();
            if (line.Length == 0) return;

            int sp = line.IndexOf(' ');
            if (sp < 0) { _hash = line; return; }
            _hash = line.Substring(0, sp).Trim();

            string iso = line.Substring(sp + 1).Trim();
            DateTimeOffset dto;
            if (DateTimeOffset.TryParse(iso, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.None, out dto))
                _when = dto.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
            else
                _when = iso;
        }

        /// <summary>시험용 — 자원 없이 파싱만 확인한다.</summary>
        internal static void ResetForTest()
        {
            _loaded = true;
            _hash = "";
            _when = "";
        }
    }
}

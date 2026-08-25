using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace TodoPopup
{
    /// <summary>
    /// 평평한 JSON 객체를 **순서와 모르는 키를 지키면서** 읽고 쓰는 최소 도구.
    ///
    /// 왜 있는가 (실제로 난 사고)
    ///
    ///   settings.json 은 C# 판과 Electron 판이 **같이 쓰는 파일**이다. 그런데 C# 은
    ///   DataContractJsonSerializer 로 읽었다. 그 직렬화기는
    ///     · 멤버가 사전순으로 오지 않으면 건너뛰거나 예외를 던지고,
    ///     · JSON 에서는 IExtensibleDataObject 로도 모르는 키를 되돌려 쓰지 못한다.
    ///   결과는 두 가지였다.
    ///     (1) Electron 이 쓴 settings.json 을 읽을 때마다 예외가 나서 파일을
    ///         settings.json.corrupt-<시각> 으로 격리했다. **실행할 때마다** 한 개씩.
    ///         실제 사용자 폴더에 열 개가 쌓여 있었고, 그동안 사용자의 설정은
    ///         한 번도 반영되지 않았다 — 매번 기본값으로 떨어졌다.
    ///     (2) C# 이 설정을 저장하면 자기가 아는 11개만 남기고 autostart·단축키·
    ///         캘린더 설정 같은 나머지를 **지워 버렸다**(533바이트 -> 292바이트).
    ///
    ///   그래서 이 파일이 있다. 아는 키만 고치고 나머지는 원문 그대로 되돌려 쓴다.
    ///
    /// 범위: 최상위가 객체인 JSON. 값이 객체·배열이면 원문을 통째로 보존한다
    /// (해석하지 않는다 — 해석하지 않는 것이 이 도구의 일이다).
    /// </summary>
    internal static class Json
    {
        // ---- 읽기 ----

        /// <summary>최상위 객체를 (키, 값 원문) 목록으로. 순서는 파일에 있던 그대로.</summary>
        public static List<KeyValuePair<string, string>> ReadObject(string src)
        {
            List<KeyValuePair<string, string>> outp = new List<KeyValuePair<string, string>>();
            if (string.IsNullOrEmpty(src)) return outp;
            int i = 0;
            if (src.Length > 0 && src[0] == '﻿') i = 1; // BOM
            SkipWs(src, ref i);
            if (i >= src.Length || src[i] != '{') return outp;
            i++;
            while (i < src.Length)
            {
                SkipWs(src, ref i);
                if (i >= src.Length) break;
                if (src[i] == '}') break;
                if (src[i] == ',') { i++; continue; }
                if (src[i] != '"') break; // 모르는 모양이면 거기서 멈춘다 — 던지지 않는다
                string key = Unquote(ReadRawString(src, ref i));
                SkipWs(src, ref i);
                if (i >= src.Length || src[i] != ':') break;
                i++;
                SkipWs(src, ref i);
                int vs = i;
                if (!SkipValue(src, ref i)) break;
                outp.Add(new KeyValuePair<string, string>(key, src.Substring(vs, i - vs)));
            }
            return outp;
        }

        public static string GetRaw(List<KeyValuePair<string, string>> pairs, string key)
        {
            foreach (KeyValuePair<string, string> p in pairs)
                if (p.Key == key) return p.Value;
            return null;
        }

        public static string GetString(List<KeyValuePair<string, string>> pairs, string key, string def)
        {
            string raw = GetRaw(pairs, key);
            if (raw == null) return def;
            raw = raw.Trim();
            if (raw.Length >= 2 && raw[0] == '"') return Unquote(raw);
            if (raw == "null") return def;
            return raw;
        }

        public static bool GetBool(List<KeyValuePair<string, string>> pairs, string key, bool def)
        {
            string raw = GetRaw(pairs, key);
            if (raw == null) return def;
            raw = raw.Trim();
            if (raw == "true") return true;
            if (raw == "false") return false;
            return def;
        }

        public static int GetInt(List<KeyValuePair<string, string>> pairs, string key, int def)
        {
            double d;
            if (TryNumber(pairs, key, out d)) return (int)Math.Round(d);
            return def;
        }

        public static double GetDouble(List<KeyValuePair<string, string>> pairs, string key, double def)
        {
            double d;
            if (TryNumber(pairs, key, out d)) return d;
            return def;
        }

        private static bool TryNumber(List<KeyValuePair<string, string>> pairs, string key, out double val)
        {
            val = 0;
            string raw = GetRaw(pairs, key);
            if (raw == null) return false;
            raw = raw.Trim();
            if (raw.Length >= 2 && raw[0] == '"') raw = Unquote(raw);
            return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out val);
        }

        // ---- 쓰기 ----

        /// <summary>
        /// 원문의 키 순서와 **모르는 키를 그대로 두고** updates 의 키만 갈아 끼운다.
        /// 원문에 없던 키는 뒤에 붙는다.
        /// </summary>
        public static string Merge(string original, List<KeyValuePair<string, string>> updates)
        {
            List<KeyValuePair<string, string>> pairs = ReadObject(original);
            List<string> order = new List<string>();
            Dictionary<string, string> map = new Dictionary<string, string>();
            foreach (KeyValuePair<string, string> p in pairs)
            {
                if (!map.ContainsKey(p.Key)) order.Add(p.Key);
                map[p.Key] = p.Value;
            }
            foreach (KeyValuePair<string, string> u in updates)
            {
                if (!map.ContainsKey(u.Key)) order.Add(u.Key);
                map[u.Key] = u.Value;
            }

            StringBuilder sb = new StringBuilder();
            sb.Append("{\n");
            for (int i = 0; i < order.Count; i++)
            {
                sb.Append("  ").Append(Quote(order[i])).Append(": ").Append(Compact(map[order[i]]));
                if (i < order.Count - 1) sb.Append(',');
                sb.Append('\n');
            }
            sb.Append("}\n");
            return sb.ToString();
        }

        public static string Quote(string s)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            if (s != null)
            {
                foreach (char c in s)
                {
                    if (c == '"') sb.Append("\\\"");
                    else if (c == '\\') sb.Append("\\\\");
                    else if (c == '\n') sb.Append("\\n");
                    else if (c == '\r') sb.Append("\\r");
                    else if (c == '\t') sb.Append("\\t");
                    else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Num(double d)
        {
            return d.ToString("R", CultureInfo.InvariantCulture);
        }

        public static string Num(int n)
        {
            return n.ToString(CultureInfo.InvariantCulture);
        }

        public static string Bool(bool b)
        {
            return b ? "true" : "false";
        }

        // ---- 스캐너 ----

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        private static string ReadRawString(string s, ref int i)
        {
            int start = i;
            i++; // 여는 따옴표
            while (i < s.Length)
            {
                if (s[i] == '\\') { i += 2; continue; }
                if (s[i] == '"') { i++; break; }
                i++;
            }
            return s.Substring(start, i - start);
        }

        /// <summary>값 하나를 건너뛴다. 중첩된 객체·배열·문자열을 정확히 센다.</summary>
        private static bool SkipValue(string s, ref int i)
        {
            if (i >= s.Length) return false;
            char c = s[i];
            if (c == '"') { ReadRawString(s, ref i); return true; }
            if (c == '{' || c == '[')
            {
                int depth = 0;
                while (i < s.Length)
                {
                    char d = s[i];
                    if (d == '"') { ReadRawString(s, ref i); continue; }
                    if (d == '{' || d == '[') depth++;
                    else if (d == '}' || d == ']')
                    {
                        depth--;
                        i++;
                        if (depth == 0) return true;
                        continue;
                    }
                    i++;
                }
                return false;
            }
            while (i < s.Length && s[i] != ',' && s[i] != '}' && s[i] != ']') i++;
            return true;
        }

        /// <summary>여러 줄로 적힌 값을 한 줄로 — 파일이 사람이 읽을 만하게 남도록.</summary>
        private static string Compact(string raw)
        {
            if (raw == null) return "null";
            string t = raw.Trim();
            if (t.Length == 0) return "null";
            if (t[0] != '{' && t[0] != '[') return t;
            StringBuilder sb = new StringBuilder();
            int i = 0;
            while (i < t.Length)
            {
                if (t[i] == '"') { int st = i; ReadRawString(t, ref i); sb.Append(t.Substring(st, i - st)); continue; }
                char c = t[i];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n')
                {
                    i++;
                    continue;
                }
                sb.Append(c);
                i++;
            }
            return sb.ToString();
        }

        public static string Unquote(string raw)
        {
            if (raw == null) return null;
            string t = raw.Trim();
            if (t.Length < 2 || t[0] != '"') return t;
            StringBuilder sb = new StringBuilder();
            for (int i = 1; i < t.Length - 1; i++)
            {
                char c = t[i];
                if (c != '\\') { sb.Append(c); continue; }
                i++;
                if (i >= t.Length - 1) break;
                char e = t[i];
                if (e == 'n') sb.Append('\n');
                else if (e == 'r') sb.Append('\r');
                else if (e == 't') sb.Append('\t');
                else if (e == 'b') sb.Append('\b');
                else if (e == 'f') sb.Append('\f');
                else if (e == 'u' && i + 4 < t.Length)
                {
                    int code;
                    if (int.TryParse(t.Substring(i + 1, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                    {
                        sb.Append((char)code);
                        i += 4;
                    }
                }
                else sb.Append(e); // \" \\ \/ 등
            }
            return sb.ToString();
        }
    }
}

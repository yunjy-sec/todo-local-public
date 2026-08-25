using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Xml;

namespace TodoPopup
{
    public static class Storage
    {
        /// <summary>
        /// 데이터 디렉터리. 기본값은 %APPDATA%\TodoPopup 이고, TODO_DATA_DIR 로 주입할 수 있다.
        ///
        /// Electron 판은 처음부터 이 변수를 봤는데 C# 판은 보지 않았다. 그래서 C# 쪽 시험은
        /// 격리될 방법이 없었고, 실제로 **실사용 원장을 열어 읽고 썼다**. CLAUDE.md 가
        /// "테스트는 실사용 원장을 만지지 않는다" 라고 적어 둔 그 규칙이 한쪽에서만 지켜지고
        /// 있었던 셈이다. 두 판이 같은 파일을 공유하므로 주입 방법도 같아야 한다.
        /// </summary>
        public static string DataDir
        {
            get
            {
                string injected = null;
                try { injected = Environment.GetEnvironmentVariable("TODO_DATA_DIR"); }
                catch { }
                if (!string.IsNullOrEmpty(injected)) return injected;
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "TodoPopup");
            }
        }

        private static string TodosPath { get { return Path.Combine(DataDir, "todos.json"); } }
        private static string SettingsPath { get { return Path.Combine(DataDir, "settings.json"); } }

        public static List<TodoItem> LoadTodos()
        {
            TodoFile f = LoadFile<TodoFile>(TodosPath);
            List<TodoItem> list = (f != null && f.Items != null) ? f.Items : new List<TodoItem>();
            list.RemoveAll(delegate(TodoItem t) { return t == null || string.IsNullOrEmpty(t.Id); });
            return list;
        }

        public static void SaveTodos(List<TodoItem> items)
        {
            TodoFile f = new TodoFile();
            f.Kind = "calendar#events";
            f.Items = items;
            SaveFile(TodosPath, f, typeof(TodoFile));
        }

        /// <summary>
        /// settings.json 은 Electron 판과 **같이 쓰는 파일**이라 DataContract 로 다루지 않는다.
        /// 이유와 사고 기록은 Json.cs 머리주석에 있다. 요지: 그 직렬화기로 읽으면 Electron 이
        /// 쓴 파일이 매 실행마다 .corrupt-* 로 격리됐고(사용자 폴더에 열 개가 쌓였다),
        /// 쓰면 우리가 모르는 키를 전부 지웠다.
        /// </summary>
        public static AppSettings LoadSettings()
        {
            AppSettings s = new AppSettings(); // 생성자가 기본값을 넣는다
            string raw = ReadTextOrNull(SettingsPath);
            if (raw != null)
            {
                List<KeyValuePair<string, string>> p = Json.ReadObject(raw);
                s.Opacity = Json.GetDouble(p, "opacity", s.Opacity);
                s.Position = Json.GetString(p, "position", s.Position);
                s.PopupWidth = Json.GetInt(p, "popupWidth", s.PopupWidth);
                s.PopupHeight = Json.GetInt(p, "popupHeight", s.PopupHeight);
                s.DefaultRenotifyMinutes = Json.GetInt(p, "defaultRenotifyMinutes", s.DefaultRenotifyMinutes);
                s.DefaultSnoozeMinutes = Json.GetInt(p, "defaultSnoozeMinutes", s.DefaultSnoozeMinutes);
                s.PlaySound = Json.GetBool(p, "playSound", s.PlaySound);
                s.ShowClosed = Json.GetBool(p, "showClosed", s.ShowClosed);
                s.TruncateSeconds = Json.GetBool(p, "truncateSeconds", s.TruncateSeconds);
                s.PopupAllMonitors = Json.GetBool(p, "popupAllMonitors", s.PopupAllMonitors);
                s.PopupEffect = Json.GetString(p, "popupEffect", s.PopupEffect);
                s.HotkeyList = Json.GetString(p, "hotkeyList", s.HotkeyList);
                s.HotkeyNew = Json.GetString(p, "hotkeyNew", s.HotkeyNew);
                s.HotkeyAck = Json.GetString(p, "hotkeyAck", s.HotkeyAck);
            }
            s.Clamp();
            return s;
        }

        public static void SaveSettings(AppSettings s)
        {
            s.Clamp();
            List<KeyValuePair<string, string>> up = new List<KeyValuePair<string, string>>();
            up.Add(new KeyValuePair<string, string>("opacity", Json.Num(s.Opacity)));
            up.Add(new KeyValuePair<string, string>("position", Json.Quote(s.Position)));
            up.Add(new KeyValuePair<string, string>("popupWidth", Json.Num(s.PopupWidth)));
            up.Add(new KeyValuePair<string, string>("popupHeight", Json.Num(s.PopupHeight)));
            up.Add(new KeyValuePair<string, string>("defaultRenotifyMinutes", Json.Num(s.DefaultRenotifyMinutes)));
            up.Add(new KeyValuePair<string, string>("defaultSnoozeMinutes", Json.Num(s.DefaultSnoozeMinutes)));
            up.Add(new KeyValuePair<string, string>("playSound", Json.Bool(s.PlaySound)));
            up.Add(new KeyValuePair<string, string>("showClosed", Json.Bool(s.ShowClosed)));
            up.Add(new KeyValuePair<string, string>("truncateSeconds", Json.Bool(s.TruncateSeconds)));
            up.Add(new KeyValuePair<string, string>("popupAllMonitors", Json.Bool(s.PopupAllMonitors)));
            up.Add(new KeyValuePair<string, string>("popupEffect", Json.Quote(s.PopupEffect)));
            up.Add(new KeyValuePair<string, string>("hotkeyList", Json.Quote(s.HotkeyList)));
            up.Add(new KeyValuePair<string, string>("hotkeyNew", Json.Quote(s.HotkeyNew)));
            up.Add(new KeyValuePair<string, string>("hotkeyAck", Json.Quote(s.HotkeyAck)));

            string original = ReadTextOrNull(SettingsPath);
            WriteTextAtomic(SettingsPath, Json.Merge(original == null ? "{}" : original, up));
        }

        private static string ReadTextOrNull(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                byte[] bytes = File.ReadAllBytes(path);
                if (bytes.Length == 0) return null;
                // BOM 이 붙어 오는 일이 있었다 — 스캐너가 첫 글자에서 멈추지 않게 여기서 턴다.
                return new UTF8Encoding(false).GetString(bytes).TrimStart('﻿');
            }
            catch { return null; }
        }

        private static void WriteTextAtomic(string path, string text)
        {
            try
            {
                Directory.CreateDirectory(DataDir);
                string tmp = path + ".tmp";
                File.WriteAllText(tmp, text, new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(tmp, path, null);
                else File.Move(tmp, path);
            }
            catch { }
        }

        private static T LoadFile<T>(string path) where T : class
        {
            try
            {
                if (!File.Exists(path)) return null;
                byte[] bytes = File.ReadAllBytes(path);
                if (bytes.Length == 0) return null;
                DataContractJsonSerializer ser = new DataContractJsonSerializer(typeof(T));
                using (MemoryStream ms = new MemoryStream(bytes))
                {
                    return ser.ReadObject(ms) as T;
                }
            }
            catch
            {
                try
                {
                    string backup = path + ".corrupt-" + DateTime.Now.ToString("yyyyMMddHHmmss");
                    File.Copy(path, backup, true);
                }
                catch { }
                return null;
            }
        }

        private static void SaveFile(string path, object data, Type type)
        {
            try
            {
                Directory.CreateDirectory(DataDir);
                DataContractJsonSerializer ser = new DataContractJsonSerializer(type);
                string tmp = path + ".tmp";
                using (FileStream fs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
                using (XmlDictionaryWriter w = JsonReaderWriterFactory.CreateJsonWriter(fs, Encoding.UTF8, true, true, "  "))
                {
                    ser.WriteObject(w, data);
                    w.Flush();
                }
                // 원자적 교체: Delete→Move 사이에 중단돼도 기존 파일이 남도록
                if (File.Exists(path)) File.Replace(tmp, path, null);
                else File.Move(tmp, path);
            }
            catch
            {
            }
        }
    }
}

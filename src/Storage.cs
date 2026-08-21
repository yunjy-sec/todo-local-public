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
        public static string DataDir
        {
            get
            {
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

        public static AppSettings LoadSettings()
        {
            AppSettings s = LoadFile<AppSettings>(SettingsPath);
            if (s == null) s = new AppSettings();
            s.Clamp();
            return s;
        }

        public static void SaveSettings(AppSettings s)
        {
            s.Clamp();
            SaveFile(SettingsPath, s, typeof(AppSettings));
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

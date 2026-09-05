using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ReqFlowLauncher
{
    internal static class Program
    {
        internal const int Port = 37651;
        internal static readonly string AppUrl = "http://127.0.0.1:" + Port + "/";
        internal static bool SuppressBrowser;

        [STAThread]
        private static void Main(string[] args)
        {
            SuppressBrowser = Array.IndexOf(args, "--no-browser") >= 0;
            bool created;
            using (var mutex = new Mutex(true, @"Local\ReqFlowLauncher", out created))
            {
                if (!created)
                {
                    if (!SuppressBrowser) OpenBrowser();
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try
                {
                    Application.Run(new ReqFlowContext());
                }
                catch (Exception error)
                {
                    MessageBox.Show(
                        "ReqFlow 启动失败。\n\n" + error.Message,
                        "ReqFlow",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
            }
        }

        internal static void OpenBrowser()
        {
            Process.Start(new ProcessStartInfo(AppUrl) { UseShellExecute = true });
        }
    }

    internal sealed class ReqFlowContext : ApplicationContext
    {
        private delegate bool EnumThreadWindowsCallback(IntPtr windowHandle, IntPtr state);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool EnumThreadWindows(
            uint threadId,
            EnumThreadWindowsCallback callback,
            IntPtr state);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr windowHandle);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr windowHandle);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr windowHandle);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(
            IntPtr windowHandle,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags);

        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private readonly string appRoot;
        private readonly string statePath;
        private readonly TcpListener listener;
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private readonly NotifyIcon trayIcon;
        private readonly Icon appIcon;
        private readonly Dictionary<string, string> localFileTokens = new Dictionary<string, string>();
        private readonly object localFileTokenLock = new object();

        internal ReqFlowContext()
        {
            var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var reqFlowRoot = Path.Combine(localData, "ReqFlow");
            appRoot = Path.Combine(reqFlowRoot, "app");
            statePath = Path.Combine(reqFlowRoot, "data", "state.json");

            ExtractWebApplication();

            listener = new TcpListener(IPAddress.Loopback, Program.Port);
            listener.Start();
            Task.Run((Func<Task>)ListenLoop);

            var menu = new ContextMenuStrip();
            menu.Items.Add("打开 SYE", null, delegate { Program.OpenBrowser(); });
            menu.Items.Add("检查更新", null, delegate { LaunchUpdater(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitThread(); });

            appIcon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
            trayIcon = new NotifyIcon
            {
                Icon = appIcon ?? SystemIcons.Application,
                Text = "SYE - 本地需求管理",
                ContextMenuStrip = menu,
                Visible = true
            };
            trayIcon.DoubleClick += delegate { Program.OpenBrowser(); };
            trayIcon.ShowBalloonTip(1500, "SYE 已启动", "数据保存在本机，双击托盘图标可重新打开。", ToolTipIcon.Info);

            if (!Program.SuppressBrowser) Program.OpenBrowser();
        }

        private void LaunchUpdater()
        {
            try
            {
                var updaterDirectory = AppDomain.CurrentDomain.BaseDirectory;
                var updaterPath = Path.Combine(updaterDirectory, "SYEUpdater.exe");
                if (!File.Exists(updaterPath)) throw new FileNotFoundException("请将 SYEUpdater.exe 与 SYE.exe 放在同一个文件夹。", updaterPath);
                var currentExecutable = Assembly.GetExecutingAssembly().Location;
                Process.Start(new ProcessStartInfo(updaterPath, "\"" + currentExecutable + "\"")
                {
                    UseShellExecute = true,
                    WorkingDirectory = updaterDirectory
                });
            }
            catch (Exception error)
            {
                MessageBox.Show("无法启动内置更新器。\n\n" + error.Message, "SYE 更新",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ExtractWebApplication()
        {
            if (Directory.Exists(appRoot))
            {
                Directory.Delete(appRoot, true);
            }
            Directory.CreateDirectory(appRoot);

            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ReqFlow.Web.zip"))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("未找到内置的 ReqFlow 页面资源。");
                }
                using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    foreach (var entry in archive.Entries)
                    {
                        var destination = Path.GetFullPath(Path.Combine(appRoot, entry.FullName));
                        if (!destination.StartsWith(appRoot, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidDataException("页面资源包含无效路径。");
                        }
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(destination);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(destination));
                        entry.ExtractToFile(destination, true);
                    }
                }
            }
        }

        private async Task ListenLoop()
        {
            while (!cancellation.IsCancellationRequested)
            {
                try
                {
                    var client = await listener.AcceptTcpClientAsync();
                    Task.Run(delegate { HandleClient(client); });
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                catch (SocketException)
                {
                    if (cancellation.IsCancellationRequested) return;
                }
            }
        }

        private void HandleClient(TcpClient client)
        {
            using (client)
            using (var stream = client.GetStream())
            {
                try
                {
                    client.ReceiveTimeout = 10000;
                    client.SendTimeout = 10000;
                    var request = ReadRequest(stream);
                    if (request == null) return;

                    if (request.Path == "/api/state")
                    {
                        HandleStateRequest(stream, request);
                        return;
                    }
if (request.Path.StartsWith("/api/integrations/beyond-compare/", StringComparison.Ordinal))
                    {
                        HandleBeyondCompareRequest(stream, request);
                        return;
                    }
                    if (request.Path.StartsWith("/api/local-files/", StringComparison.Ordinal))
                    {
                        HandleLocalFilesRequest(stream, request);
                        return;
                    }

                    if (request.Method != "GET" && request.Method != "HEAD")
                    {
                        WriteResponse(stream, 405, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Method Not Allowed"), false);
                        return;
                    }

                    var relative = Uri.UnescapeDataString(request.Path.Split('?')[0]).TrimStart('/');
                    if (string.IsNullOrEmpty(relative)) relative = "index.html";
                    relative = relative.Replace('/', Path.DirectorySeparatorChar);
                    var filePath = Path.GetFullPath(Path.Combine(appRoot, relative));

                    if (!filePath.StartsWith(appRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        WriteResponse(stream, 403, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Forbidden"), false);
                        return;
                    }
                    if (!File.Exists(filePath))
                    {
                        filePath = Path.Combine(appRoot, "index.html");
                    }

                    var body = File.ReadAllBytes(filePath);
                    WriteResponse(stream, 200, ContentType(filePath), body, request.Method == "HEAD");
                }
                catch
                {
                    try
                    {
                        WriteResponse(stream, 500, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("ReqFlow local server error"), false);
                    }
                    catch { }
                }
            }
        }

        private void HandleStateRequest(NetworkStream stream, HttpRequest request)
        {
            if (request.Method == "GET")
            {
                var body = File.Exists(statePath)
                    ? File.ReadAllBytes(statePath)
                    : Encoding.UTF8.GetBytes("{\"schemaVersion\":3,\"history\":[],\"quickLinks\":[]}");
                WriteResponse(stream, 200, "application/json; charset=utf-8", body, false);
                return;
            }

            if (request.Method == "PUT")
            {
                if (request.Body.Length > 25 * 1024 * 1024)
                {
                    WriteResponse(stream, 413, "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"error\":\"state_too_large\"}"), false);
                    return;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(statePath));
                var temp = statePath + ".tmp";
                File.WriteAllBytes(temp, request.Body);
                if (File.Exists(statePath)) File.Delete(statePath);
                File.Move(temp, statePath);
                WriteResponse(stream, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"saved\":true}"), false);
                return;
            }

            WriteResponse(stream, 405, "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"error\":\"method_not_allowed\"}"), false);
        }

        private void HandleLocalFilesRequest(NetworkStream stream, HttpRequest request)
        {
            try
            {
                var requestPath = request.Path.Split('?')[0];
                if (requestPath.StartsWith("/api/local-files/read/", StringComparison.Ordinal)
                    && request.Method == "GET")
                {
                    var token = Uri.UnescapeDataString(requestPath.Substring("/api/local-files/read/".Length));
                    string filePath;
                    lock (localFileTokenLock)
                    {
                        localFileTokens.TryGetValue(token, out filePath);
                    }
                    if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath))
                    {
                        WriteJson(stream, 404, new { error = "local_file_not_found" });
                        return;
                    }
                    var fileInfo = new FileInfo(filePath);
                    if (fileInfo.Length > 200L * 1024 * 1024)
                    {
                        WriteJson(stream, 413, new { error = "local_file_too_large" });
                        return;
                    }
                    WriteResponse(stream, 200, ContentType(filePath), File.ReadAllBytes(filePath), false);
                    return;
                }

                if (requestPath != "/api/local-files/pick")
                {
                    WriteJson(stream, 404, new { error = "local_file_endpoint_not_found" });
                    return;
                }
                if (request.Method != "POST")
                {
                    WriteJson(stream, 405, new { error = "method_not_allowed" });
                    return;
                }

                string integrationHeader;
                if (!request.Headers.TryGetValue("X-ReqFlow-Integration", out integrationHeader)
                    || integrationHeader != "local-files")
                {
                    WriteJson(stream, 403, new { error = "integration_header_required" });
                    return;
                }

                var payload = request.Body.Length == 0
                    ? new Dictionary<string, object>()
                    : Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(request.Body));
                var kind = PayloadString(payload, "kind");
                var selection = PickLocalDocuments(kind == "folder");
                if (selection == null)
                {
                    WriteJson(stream, 200, new { selected = false, rootName = "", files = new object[0] });
                    return;
                }

                var files = new List<object>();
                foreach (var selectedPath in selection.Paths)
                {
                    var fileInfo = new FileInfo(selectedPath);
                    var token = Guid.NewGuid().ToString("N");
                    lock (localFileTokenLock)
                    {
                        localFileTokens[token] = selectedPath;
                    }
                    var relativePath = fileInfo.Name;
                    if (!string.IsNullOrEmpty(selection.RootPath))
                    {
                        relativePath = Path.GetFileName(selection.RootPath) + "/"
                            + selectedPath.Substring(selection.RootPath.Length)
                                .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                                .Replace(Path.DirectorySeparatorChar, '/');
                    }
                    files.Add(new
                    {
                        token = token,
                        name = fileInfo.Name,
                        path = fileInfo.FullName,
                        relativePath = relativePath,
                        size = fileInfo.Length,
                        lastModified = (long)(fileInfo.LastWriteTimeUtc
                            - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds
                    });
                }
                WriteJson(stream, 200, new
                {
                    selected = true,
                    rootName = string.IsNullOrEmpty(selection.RootPath) ? "" : Path.GetFileName(selection.RootPath),
                    files = files
                });
            }
            catch (Exception error)
            {
                WriteJson(stream, 400, new { error = error.Message });
            }
        }

        private void HandleBeyondCompareRequest(NetworkStream stream, HttpRequest request)
        {
            try
            {
                if (request.Path == "/api/integrations/beyond-compare/status" && request.Method == "GET")
                {
                    var executablePath = FindBeyondCompare();
                    var version = string.IsNullOrEmpty(executablePath)
                        ? ""
                        : FileVersionInfo.GetVersionInfo(executablePath).ProductVersion ?? "";
                    WriteJson(stream, 200, new
                    {
                        installed = !string.IsNullOrEmpty(executablePath),
                        executablePath = executablePath ?? "",
                        version = version
                    });
                    return;
                }

                if (request.Method != "POST")
                {
                    WriteJson(stream, 405, new { error = "method_not_allowed" });
                    return;
                }

                string integrationHeader;
                if (!request.Headers.TryGetValue("X-ReqFlow-Integration", out integrationHeader)
                    || integrationHeader != "beyond-compare")
                {
                    WriteJson(stream, 403, new { error = "integration_header_required" });
                    return;
                }

                var payload = request.Body.Length == 0
                    ? new Dictionary<string, object>()
                    : Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(request.Body));

                if (request.Path == "/api/integrations/beyond-compare/pick")
                {
                    object kindValue;
                    var kind = payload != null && payload.TryGetValue("kind", out kindValue)
                        ? Convert.ToString(kindValue)
                        : "document";
                    var selectedPath = PickLocalPath(kind == "program");
                    WriteJson(stream, 200, new
                    {
                        selected = !string.IsNullOrEmpty(selectedPath),
                        path = selectedPath ?? ""
                    });
                    return;
                }

                if (request.Path == "/api/integrations/beyond-compare/launch")
                {
                    var executablePath = PayloadString(payload, "executablePath");
                    var leftPath = PayloadString(payload, "leftPath");
                    var rightPath = PayloadString(payload, "rightPath");
                    executablePath = ValidateBeyondCompareExecutable(executablePath);
                    leftPath = ValidateDocumentPath(leftPath);
                    rightPath = ValidateDocumentPath(rightPath);

                    Process.Start(new ProcessStartInfo
                    {
                        FileName = executablePath,
                        Arguments = QuoteArgument(leftPath) + " " + QuoteArgument(rightPath),
                        WorkingDirectory = Path.GetDirectoryName(executablePath),
                        UseShellExecute = true
                    });
                    WriteJson(stream, 200, new { launched = true });
                    return;
                }

                WriteJson(stream, 404, new { error = "integration_endpoint_not_found" });
            }
            catch (Exception error)
            {
                WriteJson(stream, 400, new { error = error.Message });
            }
        }

        private static string PayloadString(Dictionary<string, object> payload, string key)
        {
            object value;
            return payload != null && payload.TryGetValue(key, out value)
                ? Convert.ToString(value)
                : "";
        }

        private static void WriteJson(NetworkStream stream, int status, object payload)
        {
            WriteResponse(
                stream,
                status,
                "application/json; charset=utf-8",
                Encoding.UTF8.GetBytes(Json.Serialize(payload)),
                false);
        }

        private static string FindBeyondCompare()
        {
            var candidates = new List<string>();
            var registryLocations = new[]
            {
                @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\BCompare.exe",
                @"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\BCompare.exe",
                @"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\BCompare.exe"
            };
            foreach (var registryLocation in registryLocations)
            {
                try
                {
                    var value = Convert.ToString(Registry.GetValue(registryLocation, "", null));
                    if (!string.IsNullOrWhiteSpace(value)) candidates.Add(value.Trim('"'));
                }
                catch { }
            }

            var programFolders = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
            };
            foreach (var folder in programFolders)
            {
                if (string.IsNullOrWhiteSpace(folder)) continue;
                candidates.Add(Path.Combine(folder, "Beyond Compare 5", "BCompare.exe"));
                candidates.Add(Path.Combine(folder, "Beyond Compare 4", "BCompare.exe"));
                candidates.Add(Path.Combine(folder, "Beyond Compare 3", "BCompare.exe"));
            }
            return candidates.Find(File.Exists);
        }

        private static string PickLocalPath(bool program)
        {
            string selectedPath = null;
            Exception dialogError = null;
            var dialogThread = new Thread((ThreadStart)delegate
            {
                try
                {
                    using (var dialog = new OpenFileDialog())
                    {
                        dialog.Title = program ? "选择 Beyond Compare 程序" : "选择要对比的文档";
                        dialog.Filter = program
                            ? "Beyond Compare (BCompare.exe)|BCompare.exe|Windows 程序 (*.exe)|*.exe"
                            : "需求文档 (*.doc;*.docx;*.wps;*.pdf)|*.doc;*.docx;*.wps;*.pdf|所有文件 (*.*)|*.*";
                        dialog.CheckFileExists = true;
                        dialog.Multiselect = false;
                        dialog.RestoreDirectory = true;
                        if (ShowOwnedDialog(dialog) == DialogResult.OK) selectedPath = dialog.FileName;
                    }
                }
                catch (Exception error)
                {
                    dialogError = error;
                }
            });
            dialogThread.SetApartmentState(ApartmentState.STA);
            dialogThread.Start();
            dialogThread.Join();
            if (dialogError != null) throw dialogError;
            return selectedPath;
        }

        private static LocalDocumentSelection PickLocalDocuments(bool folder)
        {
            LocalDocumentSelection selection = null;
            Exception dialogError = null;
            var dialogThread = new Thread((ThreadStart)delegate
            {
                try
                {
                    if (folder)
                    {
                        using (var dialog = new FolderBrowserDialog())
                        {
                            dialog.Description = "Select a folder containing Word, WPS, or PDF documents";
                            dialog.ShowNewFolderButton = false;
                            if (ShowOwnedDialog(dialog) != DialogResult.OK) return;
                            var paths = new List<string>();
                            foreach (var path in Directory.GetFiles(dialog.SelectedPath, "*", SearchOption.AllDirectories))
                            {
                                if (IsSupportedDocument(path)) paths.Add(Path.GetFullPath(path));
                                if (paths.Count >= 1000) break;
                            }
                            selection = new LocalDocumentSelection
                            {
                                RootPath = Path.GetFullPath(dialog.SelectedPath),
                                Paths = paths
                            };
                        }
                    }
                    else
                    {
                        using (var dialog = new OpenFileDialog())
                        {
                            dialog.Title = "Select requirement documents";
                            dialog.Filter = "Requirement documents (*.doc;*.docx;*.wps;*.pdf)|*.doc;*.docx;*.wps;*.pdf";
                            dialog.CheckFileExists = true;
                            dialog.Multiselect = true;
                            dialog.RestoreDirectory = true;
                            if (ShowOwnedDialog(dialog) != DialogResult.OK) return;
                            selection = new LocalDocumentSelection
                            {
                                RootPath = "",
                                Paths = new List<string>(dialog.FileNames)
                            };
                        }
                    }
                }
                catch (Exception error)
                {
                    dialogError = error;
                }
            });
            dialogThread.SetApartmentState(ApartmentState.STA);
            dialogThread.Start();
            dialogThread.Join();
            if (dialogError != null) throw dialogError;
            return selection;
        }

        private static DialogResult ShowOwnedDialog(CommonDialog dialog)
        {
            using (var owner = new Form())
            {
                var workingArea = Screen.FromPoint(Cursor.Position).WorkingArea;
                owner.ShowInTaskbar = false;
                owner.TopMost = true;
                owner.Opacity = 0.01;
                owner.FormBorderStyle = FormBorderStyle.None;
                owner.StartPosition = FormStartPosition.Manual;
                owner.Size = new Size(1, 1);
                owner.Location = new Point(
                    workingArea.Left + workingArea.Width / 2,
                    workingArea.Top + workingArea.Height / 2);
                var currentThreadId = GetCurrentThreadId();
                owner.Show();
                owner.BringToFront();
                owner.Activate();

                using (var foregroundTimer = new System.Windows.Forms.Timer())
                {
                    foregroundTimer.Interval = 80;
                    foregroundTimer.Tick += delegate
                    {
                        EnumThreadWindows(currentThreadId, delegate(IntPtr windowHandle, IntPtr state)
                        {
                            if (windowHandle == owner.Handle || !IsWindowVisible(windowHandle)) return true;
                            SetWindowPos(
                                windowHandle,
                                new IntPtr(-1),
                                0,
                                0,
                                0,
                                0,
                                0x0001 | 0x0002 | 0x0040);
                            BringWindowToTop(windowHandle);
                            SetForegroundWindow(windowHandle);
                            foregroundTimer.Stop();
                            return false;
                        }, IntPtr.Zero);
                    };
                    foregroundTimer.Start();
                    return dialog.ShowDialog(owner);
                }
            }
        }

        private static bool IsSupportedDocument(string path)
        {
            var extension = Path.GetExtension(path);
            return string.Equals(extension, ".doc", StringComparison.OrdinalIgnoreCase)
                || string.Equals(extension, ".docx", StringComparison.OrdinalIgnoreCase)
                || string.Equals(extension, ".wps", StringComparison.OrdinalIgnoreCase)
                || string.Equals(extension, ".pdf", StringComparison.OrdinalIgnoreCase);
        }

        private static string ValidateBeyondCompareExecutable(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) throw new InvalidDataException("未填写 Beyond Compare 程序路径。");
            var fullPath = Path.GetFullPath(path.Trim().Trim('"'));
            if (!File.Exists(fullPath)) throw new FileNotFoundException("Beyond Compare 程序不存在。", fullPath);
            var fileNameMatches = string.Equals(Path.GetFileName(fullPath), "BCompare.exe", StringComparison.OrdinalIgnoreCase);
            var productName = FileVersionInfo.GetVersionInfo(fullPath).ProductName ?? "";
            if (!fileNameMatches && productName.IndexOf("Beyond Compare", StringComparison.OrdinalIgnoreCase) < 0)
            {
                throw new InvalidDataException("选择的程序不是 Beyond Compare。");
            }
            return fullPath;
        }

        private static string ValidateDocumentPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) throw new InvalidDataException("左右文档路径不能为空。");
            var fullPath = Path.GetFullPath(path.Trim().Trim('"'));
            if (!File.Exists(fullPath)) throw new FileNotFoundException("对比文档不存在。", fullPath);
            return fullPath;
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value + "\"";
        }

        private static HttpRequest ReadRequest(NetworkStream stream)
        {
            var headerBytes = new List<byte>();
            var matched = 0;
            while (headerBytes.Count < 64 * 1024)
            {
                var value = stream.ReadByte();
                if (value < 0) return null;
                headerBytes.Add((byte)value);
                var expected = matched == 0 || matched == 2 ? '\r' : '\n';
                if (value == expected)
                {
                    matched++;
                    if (matched == 4) break;
                }
                else
                {
                    matched = value == '\r' ? 1 : 0;
                }
            }

            var headerText = Encoding.ASCII.GetString(headerBytes.ToArray());
            var lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            var first = lines[0].Split(' ');
            if (first.Length < 2) return null;

            var contentLength = 0;
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (var index = 1; index < lines.Length; index++)
            {
                var separator = lines[index].IndexOf(':');
                if (separator > 0)
                {
                    var name = lines[index].Substring(0, separator).Trim();
                    var value = lines[index].Substring(separator + 1).Trim();
                    headers[name] = value;
                }
            }
            string contentLengthValue;
            if (headers.TryGetValue("Content-Length", out contentLengthValue))
            {
                int.TryParse(contentLengthValue, out contentLength);
            }
            if (contentLength < 0 || contentLength > 25 * 1024 * 1024)
            {
                throw new InvalidDataException("Invalid request size.");
            }

            var body = new byte[contentLength];
            var offset = 0;
            while (offset < body.Length)
            {
                var read = stream.Read(body, offset, body.Length - offset);
                if (read <= 0) throw new EndOfStreamException();
                offset += read;
            }

            return new HttpRequest
            {
                Method = first[0].ToUpperInvariant(),
                Path = first[1],
                Body = body,
                Headers = headers
            };
        }

        private static void WriteResponse(NetworkStream stream, int status, string contentType, byte[] body, bool headersOnly)
        {
            var statusText = status == 200 ? "OK"
                : status == 400 ? "Bad Request"
                : status == 403 ? "Forbidden"
                : status == 404 ? "Not Found"
                : status == 405 ? "Method Not Allowed"
                : status == 413 ? "Payload Too Large"
                : "Internal Server Error";
            var header = "HTTP/1.1 " + status + " " + statusText + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.Length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Referrer-Policy: no-referrer\r\n"
                + "Connection: close\r\n\r\n";
            var headerBytes = Encoding.ASCII.GetBytes(header);
            stream.Write(headerBytes, 0, headerBytes.Length);
            if (!headersOnly) stream.Write(body, 0, body.Length);
        }

        private static string ContentType(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".ico": return "image/x-icon";
                default: return "application/octet-stream";
            }
        }

        protected override void ExitThreadCore()
        {
            cancellation.Cancel();
            listener.Stop();
            trayIcon.Visible = false;
            trayIcon.Dispose();
            if (appIcon != null) appIcon.Dispose();
            base.ExitThreadCore();
        }

        private sealed class HttpRequest
        {
            internal string Method;
            internal string Path;
            internal byte[] Body;
            internal Dictionary<string, string> Headers;
        }

        private sealed class LocalDocumentSelection
        {
            internal string RootPath;
            internal List<string> Paths;
        }
    }
}

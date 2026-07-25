using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

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
        private readonly string appRoot;
        private readonly string statePath;
        private readonly TcpListener listener;
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private readonly NotifyIcon trayIcon;

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
            menu.Items.Add("打开 ReqFlow", null, delegate { Program.OpenBrowser(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitThread(); });

            trayIcon = new NotifyIcon
            {
                Icon = SystemIcons.Application,
                Text = "ReqFlow - 本地需求管理",
                ContextMenuStrip = menu,
                Visible = true
            };
            trayIcon.DoubleClick += delegate { Program.OpenBrowser(); };
            trayIcon.ShowBalloonTip(1500, "ReqFlow 已启动", "数据保存在本机，双击托盘图标可重新打开。", ToolTipIcon.Info);

            if (!Program.SuppressBrowser) Program.OpenBrowser();
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
                    : Encoding.UTF8.GetBytes("{\"schemaVersion\":1,\"history\":[]}");
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
            for (var index = 1; index < lines.Length; index++)
            {
                if (lines[index].StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                {
                    int.TryParse(lines[index].Substring("Content-Length:".Length).Trim(), out contentLength);
                }
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
                Body = body
            };
        }

        private static void WriteResponse(NetworkStream stream, int status, string contentType, byte[] body, bool headersOnly)
        {
            var statusText = status == 200 ? "OK"
                : status == 403 ? "Forbidden"
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
            base.ExitThreadCore();
        }

        private sealed class HttpRequest
        {
            internal string Method;
            internal string Path;
            internal byte[] Body;
        }
    }
}

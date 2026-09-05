using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Windows.Forms;
using System.Drawing;
using System.Threading.Tasks;

[assembly: System.Reflection.AssemblyTitle("SYE Embedded Updater")]
[assembly: System.Reflection.AssemblyProduct("SYE Embedded Updater")]
[assembly: System.Reflection.AssemblyCompany("SYE")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace SYEUpdater
{
    internal static class Program
    {
        private const string DownloadUrl =
            "https://raw.githubusercontent.com/byxhouhou/requirements-lifecycle-platform/main/release/SYE.exe";

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            var targetPath = args.Length == 1
                ? Path.GetFullPath(args[0])
                : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "SYE.exe");
            if (!File.Exists(targetPath))
            {
                MessageBox.Show("未找到需要更新的 SYE.exe。请将 SYEUpdater.exe 与 SYE.exe 放在同一个文件夹。",
                    "SYE 更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (MessageBox.Show(
                "将从 GitHub 仓库下载最新版 SYE.exe。\n\n仅本次更新会访问外部网络，本地归档记录不会被覆盖。\n\n是否继续？",
                "SYE 自动更新",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question) != DialogResult.Yes) return;

            bool created;
            using (var mutex = new System.Threading.Mutex(true, @"Local\SYEUpdater", out created))
            {
                if (!created)
                {
                    MessageBox.Show("更新器已经在运行，请查看现有更新窗口。", "SYE 更新");
                    return;
                }
                Application.Run(new UpdateForm(targetPath));
            }
        }

        internal static async Task<string> UpdateApplication(string targetPath, Action<int, string, string> report)
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            var directory = Path.GetDirectoryName(targetPath);
            var downloadPath = Path.Combine(directory, "SYE." + Guid.NewGuid().ToString("N") + ".download");
            var backupPath = Path.Combine(directory, "SYE.previous.exe");
            try
            {
                report(-1, "正在连接仓库", "下载并校验完成后才会关闭当前 SYE。");
                using (var client = new WebClient())
                {
                    client.Headers[HttpRequestHeader.UserAgent] = "SYE-Updater/2.0";
                    client.DownloadProgressChanged += delegate(object sender, DownloadProgressChangedEventArgs e)
                    {
                        report(e.TotalBytesToReceive > 0 ? Math.Min(80, e.ProgressPercentage * 80 / 100) : -1,
                            "正在下载更新" + (e.TotalBytesToReceive > 0 ? " · " + e.ProgressPercentage + "%" : ""),
                            (e.BytesReceived / 1024) + " KB 已下载" + (e.TotalBytesToReceive > 0 ? " / " + (e.TotalBytesToReceive / 1024) + " KB" : ""));
                    };
                    var download = client.DownloadFileTaskAsync(new Uri(DownloadUrl + "?v=" + DateTime.UtcNow.Ticks), downloadPath);
                    if (await Task.WhenAny(download, Task.Delay(120000)) != download)
                    {
                        client.CancelAsync();
                        try { await download; } catch { }
                        throw new WebException("下载超时，请重试。");
                    }
                    await download;
                }
                report(82, "正在校验程序", "检查下载文件并比较本地与仓库版本。");
                return await Task.Run(delegate
                {
                    ValidateExecutable(downloadPath);
                    if (string.Equals(ComputeSha256(targetPath), ComputeSha256(downloadPath), StringComparison.OrdinalIgnoreCase))
                        return "当前已经是仓库中的最新版本，无需替换。";
                    report(88, "正在关闭主程序", "准备替换程序，本地数据不会被覆盖。");
                    StopRunningApplication(targetPath);
                    report(92, "正在替换程序", "保留 SYE.previous.exe 作为旧版备份。");
                    File.Replace(downloadPath, targetPath, backupPath);
                    try { ValidateExecutable(targetPath); }
                    catch (Exception validationError)
                    {
                        try { File.Replace(backupPath, targetPath, null); }
                        catch (Exception restoreError) { throw new IOException("新程序校验失败，自动恢复失败。请从 SYE.previous.exe 手动恢复。" + restoreError.Message); }
                        throw new IOException("新程序校验失败，已恢复旧程序。" + validationError.Message);
                    }
                    report(97, "正在启动 SYE", "新版已替换，正在请求启动。");
                    try { Process.Start(new ProcessStartInfo(targetPath) { UseShellExecute = true }); }
                    catch { return "更新已完成，但自动启动失败。请手动打开 SYE.exe。旧版备份已保留。"; }
                    return "更新完成，已请求启动 SYE。旧版备份保存在 SYE.previous.exe。";
                });
            }
            finally { try { SafeDelete(downloadPath); } catch { } }
        }
        private static void ValidateExecutable(string path)
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length < 32 * 1024) throw new InvalidDataException("下载的程序文件不完整。");
            using (var stream = File.OpenRead(path))
            {
                if (stream.ReadByte() != 'M' || stream.ReadByte() != 'Z')
                    throw new InvalidDataException("下载内容不是有效的 Windows 程序。");
            }
            var info = FileVersionInfo.GetVersionInfo(path);
            if (!string.Equals(info.ProductName, "ReqFlow", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("下载内容不是有效的 SYE 主程序。");
        }

        private static string ComputeSha256(string path)
        {
            using (var algorithm = SHA256.Create())
            using (var stream = File.OpenRead(path))
                return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "");
        }

        private static void StopRunningApplication(string targetPath)
        {
            foreach (var process in Process.GetProcessesByName("SYE"))
            {
                try
                {
                    if (!string.Equals(Path.GetFullPath(process.MainModule.FileName), targetPath, StringComparison.OrdinalIgnoreCase))
                        continue;
                    process.Kill();
                    if (!process.WaitForExit(10000)) throw new IOException("无法关闭正在运行的 SYE。");
                }
                finally { process.Dispose(); }
            }
        }

        private static void SafeDelete(string path) { if (File.Exists(path)) File.Delete(path); }

        internal static string FriendlyError(Exception error)
        {
            if (error is WebException) return "无法连接 GitHub，请检查网络或公司安全策略。";
            if (error is UnauthorizedAccessException) return "当前文件夹没有替换权限。";
            return error.Message;
        }
    }
    internal sealed class UpdateForm : Form
    {
        private readonly string targetPath;
        private readonly Label status = new Label();
        private readonly Label detail = new Label();
        private readonly ProgressBar progress = new ProgressBar();
        private readonly Button action = new Button();
        private bool running;
        private bool failed;

        internal UpdateForm(string path)
        {
            targetPath = path;
            Text = "SYE 更新";
            ClientSize = new Size(510, 260);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 10);
            BackColor = Color.White;
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            status.SetBounds(26, 26, 458, 40);
            status.Font = new Font(Font.FontFamily, 15, FontStyle.Bold);
            detail.SetBounds(26, 78, 458, 66);
            progress.SetBounds(26, 154, 458, 16);
            action.SetBounds(364, 198, 120, 36);
            action.Text = "更新中…";
            Controls.AddRange(new Control[] { status, detail, progress, action });
            action.Click += async delegate { if (failed) await RunUpdate(); else Close(); };
            Shown += async delegate { await RunUpdate(); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (running) e.Cancel = true; };
        }

        private void Report(int percent, string title, string description)
        {
            if (InvokeRequired) { BeginInvoke(new Action<int, string, string>(Report), percent, title, description); return; }
            status.Text = title;
            detail.Text = description;
            progress.Style = percent < 0 ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
            if (percent >= 0) progress.Value = Math.Max(0, Math.Min(100, percent));
        }

        private async Task RunUpdate()
        {
            running = true;
            failed = false;
            action.Enabled = false;
            action.Text = "更新中…";
            try
            {
                var result = await Program.UpdateApplication(targetPath, Report);
                Report(100, result.StartsWith("当前已经") ? "已是最新版本" : "更新完成", result);
                action.Text = "完成";
            }
            catch (Exception error)
            {
                failed = true;
                Report(0, "更新失败", Program.FriendlyError(error) + "\n本地业务数据不受影响。可以重试，或关闭此窗口。");
                action.Text = "重试";
            }
            finally { running = false; action.Enabled = true; }
        }
    }}

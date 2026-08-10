using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Windows.Forms;

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

            try { UpdateApplication(targetPath); }
            catch (Exception error)
            {
                MessageBox.Show("更新未完成，原程序和本地数据均未改变。\n\n" + FriendlyError(error),
                    "SYE 更新失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void UpdateApplication(string targetPath)
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            var directory = Path.GetDirectoryName(targetPath);
            var downloadPath = Path.Combine(directory, "SYE.download");
            var backupPath = Path.Combine(directory, "SYE.previous.exe");
            SafeDelete(downloadPath);
            SafeDelete(backupPath);

            using (var client = new WebClient())
            {
                client.Headers[HttpRequestHeader.UserAgent] = "SYE-Updater/1.0";
                client.DownloadFile(DownloadUrl + "?v=" + DateTime.UtcNow.Ticks, downloadPath);
            }

            ValidateExecutable(downloadPath);
            if (string.Equals(ComputeSha256(targetPath), ComputeSha256(downloadPath), StringComparison.OrdinalIgnoreCase))
            {
                SafeDelete(downloadPath);
                MessageBox.Show("当前已经是仓库中的最新版本。", "SYE 已是最新版本",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            StopRunningApplication(targetPath);
            File.Move(targetPath, backupPath);
            try
            {
                File.Move(downloadPath, targetPath);
                ValidateExecutable(targetPath);
                SafeDelete(backupPath);
            }
            catch
            {
                SafeDelete(targetPath);
                if (File.Exists(backupPath)) File.Move(backupPath, targetPath);
                throw;
            }

            Process.Start(new ProcessStartInfo(targetPath) { UseShellExecute = true });
            MessageBox.Show("更新完成，SYE 已重新启动。", "SYE 更新成功",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
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

        private static string FriendlyError(Exception error)
        {
            if (error is WebException) return "无法连接 GitHub，请检查网络或公司安全策略。";
            if (error is UnauthorizedAccessException) return "当前文件夹没有替换权限。";
            return error.Message;
        }
    }
}

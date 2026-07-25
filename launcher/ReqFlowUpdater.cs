using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("ReqFlow Updater")]
[assembly: System.Reflection.AssemblyProduct("ReqFlow Updater")]
[assembly: System.Reflection.AssemblyCompany("ReqFlow")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

namespace ReqFlowUpdater
{
    internal static class Program
    {
        private const string DownloadUrl =
            "https://raw.githubusercontent.com/byxhouhou/requirements-lifecycle-platform/main/release/ReqFlow.exe";
        private const string HashUrl =
            "https://raw.githubusercontent.com/byxhouhou/requirements-lifecycle-platform/main/release/ReqFlow.exe.sha256";

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var answer = MessageBox.Show(
                "将从 GitHub 仓库下载最新版 ReqFlow.exe。\n\n"
                + "更新器仅在本次操作中访问外部网络；归档记录和源文档不会被覆盖。\n\n"
                + "是否继续？",
                "ReqFlow 本地更新",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);

            if (answer != DialogResult.Yes) return;

            try
            {
                UpdateApplication();
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "更新未完成，原程序和本地数据均未改变。\n\n" + FriendlyError(error),
                    "ReqFlow 更新失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private static void UpdateApplication()
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;

            var updaterDirectory = AppDomain.CurrentDomain.BaseDirectory;
            var targetPath = Path.Combine(updaterDirectory, "ReqFlow.exe");
            var downloadPath = Path.Combine(updaterDirectory, "ReqFlow.download");
            var backupPath = Path.Combine(updaterDirectory, "ReqFlow.previous.exe");
            var cacheKey = DateTime.UtcNow.Ticks.ToString();

            if (!File.Exists(targetPath))
            {
                throw new FileNotFoundException(
                    "请将 ReqFlowUpdater.exe 与 ReqFlow.exe 放在同一个文件夹后再运行。",
                    targetPath);
            }

            SafeDelete(downloadPath);

            string expectedHash;
            using (var client = CreateWebClient())
            {
                var hashText = client.DownloadString(HashUrl + "?v=" + cacheKey);
                var match = Regex.Match(hashText, @"\b[A-Fa-f0-9]{64}\b");
                if (!match.Success)
                {
                    throw new InvalidDataException("仓库中的 SHA-256 校验文件无效。");
                }
                expectedHash = match.Value.ToUpperInvariant();
                client.DownloadFile(DownloadUrl + "?v=" + cacheKey, downloadPath);
            }

            ValidateExecutable(downloadPath, expectedHash);

            var currentHash = ComputeSha256(targetPath);
            if (string.Equals(currentHash, expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                SafeDelete(downloadPath);
                MessageBox.Show(
                    "当前已经是仓库中的最新版本，无需替换。",
                    "ReqFlow 已是最新版本",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            StopRunningApplication(targetPath);
            SafeDelete(backupPath);

            try
            {
                File.Replace(downloadPath, targetPath, backupPath, true);
            }
            catch
            {
                SafeDelete(downloadPath);
                throw;
            }

            var downloadedVersion = FileVersionInfo.GetVersionInfo(targetPath).FileVersion;
            MessageBox.Show(
                "更新完成。\n\n"
                + "当前版本：" + downloadedVersion + "\n"
                + "旧版备份：ReqFlow.previous.exe\n"
                + "本地归档记录已保留。",
                "ReqFlow 更新成功",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);

            Process.Start(new ProcessStartInfo(targetPath) { UseShellExecute = true });
        }

        private static WebClient CreateWebClient()
        {
            var client = new WebClient();
            client.Headers[HttpRequestHeader.UserAgent] = "ReqFlow-Updater/1.0";
            client.Encoding = System.Text.Encoding.UTF8;
            return client;
        }

        private static void ValidateExecutable(string path, string expectedHash)
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length < 32 * 1024)
            {
                throw new InvalidDataException("下载的程序文件不完整。");
            }

            using (var stream = File.OpenRead(path))
            {
                if (stream.ReadByte() != 'M' || stream.ReadByte() != 'Z')
                {
                    throw new InvalidDataException("下载内容不是有效的 Windows 程序。");
                }
            }

            var actualHash = ComputeSha256(path);
            if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("SHA-256 校验不一致，请稍后重试。");
            }

            var versionInfo = FileVersionInfo.GetVersionInfo(path);
            if (!string.Equals(versionInfo.ProductName, "ReqFlow", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("下载的程序不是有效的 ReqFlow 主程序。");
            }
        }

        private static string ComputeSha256(string path)
        {
            using (var algorithm = SHA256.Create())
            using (var stream = File.OpenRead(path))
            {
                return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "");
            }
        }

        private static void StopRunningApplication(string targetPath)
        {
            foreach (var process in Process.GetProcessesByName("ReqFlow"))
            {
                try
                {
                    var runningPath = process.MainModule.FileName;
                    if (!string.Equals(
                        Path.GetFullPath(runningPath),
                        Path.GetFullPath(targetPath),
                        StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    process.Kill();
                    if (!process.WaitForExit(10000))
                    {
                        throw new IOException("无法关闭正在运行的 ReqFlow，请先从托盘退出后重试。");
                    }
                }
                finally
                {
                    process.Dispose();
                }
            }
        }

        private static void SafeDelete(string path)
        {
            if (File.Exists(path)) File.Delete(path);
        }

        private static string FriendlyError(Exception error)
        {
            if (error is WebException)
            {
                return "无法连接 GitHub。请检查网络或公司安全策略后重试。";
            }
            if (error is UnauthorizedAccessException)
            {
                return "当前文件夹没有替换权限，请将两个 EXE 放到可写文件夹后重试。";
            }
            return error.Message;
        }
    }
}

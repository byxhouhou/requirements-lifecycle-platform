param(
    [switch]$SkipWebBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $projectRoot "release"
$workingDir = Join-Path $projectRoot ".launcher-build"
$webArchive = Join-Path $workingDir "ReqFlow.Web.zip"
$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$source = Join-Path $PSScriptRoot "ReqFlowLauncher.cs"
$output = Join-Path $releaseDir "ReqFlow.exe"
$updaterSource = Join-Path $PSScriptRoot "ReqFlowUpdater.cs"
$updaterOutput = Join-Path $releaseDir "ReqFlowUpdater.exe"
$assemblyInfo = Join-Path $workingDir "ReqFlowAssemblyInfo.cs"
$hashOutput = Join-Path $releaseDir "ReqFlow.exe.sha256"
$iconOutput = Join-Path $releaseDir "SYE.ico"
$iconPreview = Join-Path $releaseDir "SYE-icon.png"
$iconSource = Join-Path $projectRoot "assets\branding\SYE-tile-green.png"

if (-not (Test-Path $compiler)) {
    throw "Windows C# compiler was not found: $compiler"
}
if (-not (Test-Path $iconSource)) {
    throw "SYE icon source was not found: $iconSource"
}

if (-not $SkipWebBuild) {
    Push-Location $projectRoot
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "Web application build failed." }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path (Join-Path $projectRoot "dist\index.html"))) {
    throw "dist\index.html was not found. Run npm run build first."
}

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
if (Test-Path $workingDir) {
    $resolvedWorking = (Resolve-Path $workingDir).Path
    $resolvedProject = (Resolve-Path $projectRoot).Path
    if (-not $resolvedWorking.StartsWith($resolvedProject)) {
        throw "Refusing to clean a temporary path outside the project."
    }
    Remove-Item -LiteralPath $resolvedWorking -Recurse -Force
}
New-Item -ItemType Directory -Path $workingDir -Force | Out-Null

Add-Type -AssemblyName System.Drawing
$sourceIconImage = [System.Drawing.Image]::FromFile($iconSource)
$iconBitmap = New-Object System.Drawing.Bitmap 256, 256
$iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
try {
    $iconGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $iconGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $iconGraphics.DrawImage($sourceIconImage, 0, 0, 256, 256)
    $iconBitmap.Save($iconPreview, [System.Drawing.Imaging.ImageFormat]::Png)
    $iconHandle = $iconBitmap.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
    $iconStream = [System.IO.File]::Create($iconOutput)
    try { $icon.Save($iconStream) } finally { $iconStream.Dispose(); $icon.Dispose() }
}
finally {
    $iconGraphics.Dispose()
    $iconBitmap.Dispose()
    $sourceIconImage.Dispose()
}

Compress-Archive -Path (Join-Path $projectRoot "dist\*") -DestinationPath $webArchive -CompressionLevel Optimal

$package = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$versionParts = @($package.version.Split("-")[0].Split("."))
while ($versionParts.Count -lt 4) { $versionParts += "0" }
$fileVersion = ($versionParts[0..3] -join ".")

@"
using System.Reflection;
[assembly: AssemblyTitle("ReqFlow")]
[assembly: AssemblyProduct("ReqFlow")]
[assembly: AssemblyCompany("ReqFlow")]
[assembly: AssemblyDescription("Local-first requirements lifecycle platform")]
[assembly: AssemblyVersion("$fileVersion")]
[assembly: AssemblyFileVersion("$fileVersion")]
[assembly: AssemblyInformationalVersion("$($package.version)")]
"@ | Set-Content -Encoding UTF8 $assemblyInfo

& $compiler `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /optimize+ `
    /win32icon:$iconOutput `
    /out:$output `
    /resource:"$webArchive,ReqFlow.Web.zip" `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.IO.Compression.dll `
    /reference:System.IO.Compression.FileSystem.dll `
    /reference:System.Web.Extensions.dll `
    /reference:System.Windows.Forms.dll `
    $source `
    $assemblyInfo

if ($LASTEXITCODE -ne 0) {
    throw "ReqFlow.exe compilation failed."
}

$hash = (Get-FileHash -Algorithm SHA256 $output).Hash
Set-Content -Encoding ASCII -Path $hashOutput -Value "$hash *ReqFlow.exe"

& $compiler `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /optimize+ `
    /out:$updaterOutput `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Windows.Forms.dll `
    $updaterSource

if ($LASTEXITCODE -ne 0) {
    throw "ReqFlowUpdater.exe compilation failed."
}

$updaterHash = (Get-FileHash -Algorithm SHA256 $updaterOutput).Hash
Write-Output "Created: $output"
Write-Output "SHA256: $hash"
Write-Output "Created: $updaterOutput"
Write-Output "SHA256: $updaterHash"

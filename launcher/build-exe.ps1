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
$output = Join-Path $releaseDir "SYE.exe"
$updaterSource = Join-Path $PSScriptRoot "ReqFlowUpdater.cs"
$updaterOutput = Join-Path $releaseDir "SYEUpdater.exe"
$assemblyInfo = Join-Path $workingDir "ReqFlowAssemblyInfo.cs"
$iconOutput = Join-Path $workingDir "SYE.ico"
$iconPreview = Join-Path $workingDir "SYE-icon.png"
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
$iconSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$iconFrames = @()
try {
    foreach ($iconSize in $iconSizes) {
        $frameBitmap = New-Object System.Drawing.Bitmap $iconSize, $iconSize
        $frameGraphics = [System.Drawing.Graphics]::FromImage($frameBitmap)
        try {
            $frameGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $frameGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $frameGraphics.DrawImage($sourceIconImage, 0, 0, $iconSize, $iconSize)
            if ($iconSize -eq 256) {
                $frameBitmap.Save($iconPreview, [System.Drawing.Imaging.ImageFormat]::Png)
            }
            $frameStream = New-Object System.IO.MemoryStream
            try {
                $frameBitmap.Save($frameStream, [System.Drawing.Imaging.ImageFormat]::Png)
                $iconFrames += ,$frameStream.ToArray()
            }
            finally {
                $frameStream.Dispose()
            }
        }
        finally {
            $frameGraphics.Dispose()
            $frameBitmap.Dispose()
        }
    }

    $iconStream = [System.IO.File]::Create($iconOutput)
    $iconWriter = New-Object System.IO.BinaryWriter $iconStream
    try {
        $iconWriter.Write([uint16]0)
        $iconWriter.Write([uint16]1)
        $iconWriter.Write([uint16]$iconSizes.Count)
        $frameOffset = 6 + (16 * $iconSizes.Count)
        for ($index = 0; $index -lt $iconSizes.Count; $index++) {
            $iconSize = $iconSizes[$index]
            $dimension = if ($iconSize -eq 256) { 0 } else { $iconSize }
            $iconWriter.Write([byte]$dimension)
            $iconWriter.Write([byte]$dimension)
            $iconWriter.Write([byte]0)
            $iconWriter.Write([byte]0)
            $iconWriter.Write([uint16]1)
            $iconWriter.Write([uint16]32)
            $iconWriter.Write([uint32]$iconFrames[$index].Length)
            $iconWriter.Write([uint32]$frameOffset)
            $frameOffset += $iconFrames[$index].Length
        }
        foreach ($frame in $iconFrames) {
            $iconWriter.Write($frame)
        }
    }
    finally {
        $iconWriter.Dispose()
        $iconStream.Dispose()
    }
}
finally {
    $sourceIconImage.Dispose()
}

Compress-Archive -Path (Join-Path $projectRoot "dist\*") -DestinationPath $webArchive -CompressionLevel Optimal

$package = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$versionParts = @($package.version.Split("-")[0].Split("."))
while ($versionParts.Count -lt 4) { $versionParts += "0" }
$fileVersion = ($versionParts[0..3] -join ".")

& $compiler `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /optimize+ `
    /win32icon:$iconOutput `
    /out:$updaterOutput `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Windows.Forms.dll `
    $updaterSource

if ($LASTEXITCODE -ne 0) {
    throw "Embedded SYE updater compilation failed."
}

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
    throw "SYE.exe compilation failed."
}

$hash = (Get-FileHash -Algorithm SHA256 $output).Hash
Write-Output "Created: $output"
Write-Output "SHA256: $hash"
Write-Output "Created: $updaterOutput"

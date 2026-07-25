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

if (-not (Test-Path $compiler)) {
    throw "Windows C# compiler was not found: $compiler"
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

Compress-Archive -Path (Join-Path $projectRoot "dist\*") -DestinationPath $webArchive -CompressionLevel Optimal

& $compiler `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /optimize+ `
    /out:$output `
    /resource:"$webArchive,ReqFlow.Web.zip" `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.IO.Compression.dll `
    /reference:System.IO.Compression.FileSystem.dll `
    /reference:System.Windows.Forms.dll `
    $source

if ($LASTEXITCODE -ne 0) {
    throw "ReqFlow.exe compilation failed."
}

$hash = (Get-FileHash -Algorithm SHA256 $output).Hash
Write-Output "Created: $output"
Write-Output "SHA256: $hash"

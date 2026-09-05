$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$assembly = [Reflection.Assembly]::LoadFile((Resolve-Path "$PSScriptRoot\..\release\SYEUpdater.exe").Path)
$flags = [Reflection.BindingFlags]'Instance,NonPublic'
$type = $assembly.GetType('SYEUpdater.UpdateForm')
$form = [Activator]::CreateInstance($type, $flags, $null, @('C:\test\SYE.exe'), $null)
try {
    $report = $type.GetMethod('Report', $flags)
    $bar = $type.GetField('progress', $flags).GetValue($form)
    $status = $type.GetField('status', $flags).GetValue($form)
    $report.Invoke($form, @(-1, 'Connecting', 'Waiting')) | Out-Null
    if ($bar.Style -ne 'Marquee') { throw 'Connection progress must be indeterminate' }
    $report.Invoke($form, @(40, 'Downloading 50%', '100 / 200 KB')) | Out-Null
    if ($bar.Style -ne 'Continuous' -or $bar.Value -ne 40) { throw 'Download progress mismatch' }
    $report.Invoke($form, @(100, 'Completed', 'Done')) | Out-Null
    if ($bar.Value -ne 100 -or $status.Text -ne 'Completed') { throw 'Completion state mismatch' }
    $report.Invoke($form, @(0, 'Failed', 'Retry')) | Out-Null
    if ($bar.Value -ne 0 -or $status.Text -ne 'Failed') { throw 'Failure state mismatch' }
} finally { $form.Dispose() }
$program = $assembly.GetType('SYEUpdater.Program')
$validate = $program.GetMethod('ValidateExecutable', [Reflection.BindingFlags]'Static,NonPublic')
$validate.Invoke($null, @((Resolve-Path "$PSScriptRoot\..\release\SYE.exe").Path)) | Out-Null
$rejected = $false
try { $validate.Invoke($null, @((Resolve-Path "$PSScriptRoot\..\package.json").Path)) | Out-Null } catch { $rejected = $true }
if (-not $rejected) { throw 'Invalid download accepted' }
Write-Output 'PASS: connection, download, completion, failure, valid executable and invalid download rejection'

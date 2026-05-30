<#
.SYNOPSIS
  Register the oh-my-tokens native messaging host with Chrome/Edge on Windows.

.DESCRIPTION
  Mirrors host/install-macos.sh for Windows. Copies the host runtime under
  %USERPROFILE%\.oh-my-tokens\native-host, writes the native-messaging manifest, and
  registers it in the browser's per-user registry key (no admin required). Unlike macOS
  (a JSON file in a fixed directory), Chrome on Windows finds the host via the registry.

.PARAMETER ExtensionId
  The unpacked extension's ID. Defaults to the fixed ID baked into manifest.json's "key".

.PARAMETER Browser
  chrome | beta | canary | chromium | edge. Selects which browser's registry root to write.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File host\install-windows.ps1
  powershell -ExecutionPolicy Bypass -File host\install-windows.ps1 -Browser edge
#>
[CmdletBinding()]
param(
  [string]$ExtensionId = "obmkhlamcmbmacadoolbfaagmojdobah",
  [ValidateSet("chrome", "beta", "canary", "chromium", "edge")]
  [string]$Browser = "chrome"
)

$ErrorActionPreference = "Stop"
$HostName = "com.ohmytokens.host"

# Browser -> HKCU NativeMessagingHosts root. Chrome's release channels share the
# Google\Chrome key; Chromium and Edge each have their own.
switch ($Browser) {
  "chrome"   { $regRoot = "HKCU:\Software\Google\Chrome\NativeMessagingHosts" }
  "beta"     { $regRoot = "HKCU:\Software\Google\Chrome\NativeMessagingHosts" }
  "canary"   { $regRoot = "HKCU:\Software\Google\Chrome\NativeMessagingHosts" }
  "chromium" { $regRoot = "HKCU:\Software\Chromium\NativeMessagingHosts" }
  "edge"     { $regRoot = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts" }
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $dir
$installRoot = Join-Path $env:USERPROFILE ".oh-my-tokens\native-host"
$installHostDir = Join-Path $installRoot "host"
$installParsersDir = Join-Path $installHostDir "parsers"
$installSharedDir = Join-Path $installRoot "shared"

# Install the runtime under the user profile instead of pointing the browser at the
# arbitrary clone location, so updates to the working tree never surprise the host.
if (Test-Path $installRoot) { Remove-Item -Recurse -Force $installRoot }
New-Item -ItemType Directory -Force -Path $installHostDir, $installParsersDir, $installSharedDir | Out-Null

Copy-Item (Join-Path $dir "*.js") $installHostDir
Copy-Item (Join-Path $dir "package.json") $installHostDir
Copy-Item (Join-Path $dir "run-host.cmd") $installHostDir
Copy-Item (Join-Path $dir "parsers\*.js") $installParsersDir
Copy-Item (Join-Path $repoRoot "shared\*.js") $installSharedDir

$hostPath = Join-Path $installHostDir "run-host.cmd"
$manifestPath = Join-Path $installHostDir "$HostName.json"

# Write the manifest. ConvertTo-Json escapes the backslashes in the Windows path
# correctly; WriteAllText emits UTF-8 with no BOM (a BOM breaks Chrome's JSON parser).
$manifest = [ordered]@{
  name            = $HostName
  description     = "oh-my-tokens usage native host"
  path            = $hostPath
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5))

# Register: the host key's default value points at the manifest file. Create keys only
# when missing — `New-Item -Force` on an existing key (the browser's NativeMessagingHosts
# key usually already exists) attempts to clear it and fails with "unauthorized operation".
$hostKey = Join-Path $regRoot $HostName
if (-not (Test-Path $regRoot)) { New-Item -Path $regRoot -Force | Out-Null }
if (-not (Test-Path $hostKey)) { New-Item -Path $hostKey | Out-Null }
Set-ItemProperty -Path $hostKey -Name "(Default)" -Value $manifestPath

Write-Host "Installed native host manifest:"
Write-Host "  $manifestPath"
Write-Host "  runtime     = $installRoot"
Write-Host "  path        = $hostPath"
Write-Host "  registered  = $hostKey"
Write-Host "  allowed for = chrome-extension://$ExtensionId/"
Write-Host ""
Write-Host "Reload the extension at chrome://extensions (or edge://extensions), then open the popup."

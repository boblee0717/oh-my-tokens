<#
.SYNOPSIS
  One-command setup for oh-my-tokens (Windows). The PowerShell analog of install.sh.

.DESCRIPTION
  Does everything that can be scripted:
    - registers the Native Messaging host (with the fixed Extension ID) in the registry
    - optionally writes the DeepSeek key to ~/.oh-my-tokens/config.json
    - with -Launch, starts Chrome with the extension preloaded
  The one step the browser won't allow from the CLI is loading an unpacked extension into
  an already-running browser; without -Launch this script prints that single manual step.

.PARAMETER Browser
  chrome | beta | canary | chromium | edge (default chrome).

.PARAMETER DeepSeekKey
  Optional DeepSeek API key; written to ~/.oh-my-tokens/config.json (kept out of the browser).

.PARAMETER Launch
  Relaunch Chrome with the extension preloaded (best-effort; ignored if Chrome is running).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
  powershell -ExecutionPolicy Bypass -File install.ps1 -Browser edge -DeepSeekKey sk-...
#>
[CmdletBinding()]
param(
  [ValidateSet("chrome", "beta", "canary", "chromium", "edge")]
  [string]$Browser = "chrome",
  [string]$DeepSeekKey = $env:DEEPSEEK_API_KEY,
  [switch]$Launch
)

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$extId = "obmkhlamcmbmacadoolbfaagmojdobah"  # fixed via manifest "key"
$extDir = Join-Path $dir "extension"

# 0. Preflight: Node must exist and be >= 18 (the host is plain JS). Fail early with a
#    clear message instead of the browser later reporting "Native host has exited".
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node not found. Install Node >= 18 (https://nodejs.org) and re-run."
  exit 1
}
$nodeMajor = [int](& node -e "console.log(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 18) {
  Write-Error "Node $nodeMajor is too old; need >= 18. Upgrade Node and re-run."
  exit 1
}

# 1. Native messaging host (reads ~/.claude, ~/.codex, ~/.cursor; calls nothing else).
& (Join-Path $dir "host\install-windows.ps1") -ExtensionId $extId -Browser $Browser

# 2. Optional DeepSeek key — kept out of the browser, in a local config file.
if ($DeepSeekKey) {
  $cfgDir = Join-Path $env:USERPROFILE ".oh-my-tokens"
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  $cfgPath = Join-Path $cfgDir "config.json"
  [System.IO.File]::WriteAllText($cfgPath, (@{ deepseekApiKey = $DeepSeekKey } | ConvertTo-Json))
  Write-Host "Wrote DeepSeek key to ~/.oh-my-tokens/config.json"
}

# 3. Load the extension. Auto-launch only supports a standard Chrome/Edge install (the
#    others — chromium/beta/canary — fall through to the manual step rather than risk
#    launching the wrong browser, which wouldn't match the registry root we registered).
if ($Launch) {
  $candidates = switch ($Browser) {
    "edge" {
      @((Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"))
    }
    "chrome" {
      @((Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"))
    }
    default { @() }
  }
  $browserExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($browserExe) {
    Write-Host "Launching $(Split-Path -Leaf $browserExe) with the extension preloaded (a full restart may be needed if it's already running)..."
    Start-Process -FilePath $browserExe -ArgumentList "--load-extension=`"$extDir`"" | Out-Null
    Write-Host "If the browser was already open, fully quit it and run this again, or load it manually (below)."
  } else {
    Write-Host "-Launch supports a standard Chrome/Edge install; load the extension manually (below)."
  }
}

Write-Host ""
Write-Host "oh-my-tokens host is registered (Extension ID: $extId)."
Write-Host "Final step - load the extension (the browser can't do this from the CLI):"
Write-Host "  1. Open chrome://extensions (or edge://extensions) and enable 'Developer mode'"
Write-Host "  2. Click 'Load unpacked' and select:"
Write-Host "       $extDir"
Write-Host "  3. Click the oh-my-tokens toolbar icon."
Write-Host ""
Write-Host "(DeepSeek balance is optional: set it now with -DeepSeekKey, in the Options page, or in ~/.oh-my-tokens/config.json.)"

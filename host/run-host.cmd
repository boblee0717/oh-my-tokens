@echo off
rem Wrapper Chrome/Edge launches as the native messaging host on Windows.
rem Chrome runs a .cmd via "cmd.exe /c"; node inherits the browser's binary stdio
rem pipes directly, so the length-prefixed native-messaging protocol is preserved.
rem Two rules keep that stream intact: (1) nothing here may write to stdout, and
rem (2) host diagnostics go to stderr, which we append to a log file.
setlocal enableextensions
set "OMT_DIR=%~dp0"
set "OMT_HOME=%USERPROFILE%\.oh-my-tokens"
if not exist "%OMT_HOME%" mkdir "%OMT_HOME%" >nul 2>&1

rem Resolve node. Chrome may launch the host with a stripped PATH, so probe PATH first,
rem then common install locations (official installer, 32-bit, nvm-windows/winget/Volta
rem under LOCALAPPDATA). Mirror run-host.sh: emit a clear diagnostic if none is found.
set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  echo oh-my-tokens host: node not found on PATH or common install locations>>"%OMT_HOME%\host.log"
  exit /b 1
)

"%NODE_EXE%" "%OMT_DIR%native-host.js" %* 2>>"%OMT_HOME%\host.log"

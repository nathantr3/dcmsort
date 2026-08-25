@echo off
rem dcmsort command line entry point, shipped beside the installed app.
rem
rem The install already carries a complete Node runtime - dcmsort.exe runs any
rem script as plain Node when ELECTRON_RUN_AS_NODE is set - so the CLI needs no
rem second runtime and cannot drift from the app it ships with.
rem
rem Add the containing folder to your PATH for a bare `dcmsort` command:
rem   setx PATH "%PATH%;C:\Program Files\dcmsort\resources"

setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\dcmsort.exe" "%~dp0app.asar\src\cli\cli.js" %*
exit /b %ERRORLEVEL%

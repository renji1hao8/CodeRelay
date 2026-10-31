' remote-cc: run a PowerShell script with no console window whatsoever.
'
' WHY THIS FILE EXISTS
' --------------------
' A scheduled task that launches powershell.exe directly makes Windows allocate a
' console first, and only then does PowerShell apply -WindowStyle Hidden. On some
' configurations you therefore see a black box flash on screen every time the task
' fires -- ours fires every 5 minutes, so it flashed every 5 minutes.
'
' wscript.exe is a GUI-subsystem binary: it never asks Windows for a console, so
' there is no window for any console host (classic conhost, OpenConsole, or
' Windows Terminal delegating the launch) to display in the first place.
' WshShell.Run(..., 0, ...) then also hides the child's own window.
'
' This file is deliberately ASCII-only: WSH reads .vbs as ANSI or UTF-16LE, never
' as UTF-8, so non-ASCII text here would be mangled on a machine whose ANSI code
' page is not UTF-8. The script paths are passed in as arguments instead, which
' WSH hands over as proper Unicode.
'
' USAGE
' -----
'   wscript.exe //B //Nologo run-hidden.vbs <script-name>
'
' The script name is resolved relative to this file's own folder, so callers never
' have to spell out the project path (which contains non-ASCII characters) on a
' command line.

Option Explicit

Dim fso, sh, scriptPath, cmd

If WScript.Arguments.Count < 1 Then
    WScript.Quit 2
End If

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), WScript.Arguments(0))

If Not fso.FileExists(scriptPath) Then
    WScript.Quit 3
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """"
sh.Run cmd, 0, False

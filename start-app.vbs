' Startet start-app.ps1 unsichtbar (kein Konsolenfenster) - das ist das Ziel der Desktop-Verknüpfung.
Dim objShell, fso, scriptDir, psPath
Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psPath = scriptDir & "\start-app.ps1"
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psPath & """", 0, False

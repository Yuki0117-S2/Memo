Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = scriptPath
WshShell.Run """" & scriptPath & "\node_modules\electron\dist\electron.exe"" .", 1, False

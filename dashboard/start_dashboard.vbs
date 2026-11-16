' Starts the Mount Coffee dashboard in the background (no window). Used by the "MCSolar Dashboard" task.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c node node_modules\next\dist\bin\next start -p 3000 -H 0.0.0.0 > dashboard.log 2>&1", 0, False

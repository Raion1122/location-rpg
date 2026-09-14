' ============================================================
'  Fake GPS map tool - local launcher (no console window)
'  Double-click: starts the Node relay server (server.js) and
'  opens the map tool in the browser. The server also lets a
'  phone on the same Wi-Fi open the game and receive the pin
'  position. fake-gps.js only activates on localhost / home LAN,
'  so a publicly deployed game cannot be spoofed.
'  Windows Firewall may ask to allow Node on first run; allow
'  it on private networks so the phone can connect.
'  Comments are ASCII on purpose: .vbs is read as ANSI.
' ============================================================
Option Explicit
Dim shell, fso, here, port, url, serverCmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
port = "8790"
url  = "http://127.0.0.1:" & port & "/map.html"

' Start the relay server in a HIDDEN window (style 0). If a server is already
' running on this port the new one just fails and the browser uses the old one.
serverCmd = "cmd /c cd /d """ & here & """ && node server.js"
shell.Run serverCmd, 0, False

WScript.Sleep 1500
shell.Run url, 1, False

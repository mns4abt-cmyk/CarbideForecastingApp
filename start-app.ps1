# Startet den Carbide-Marktradar-Server (falls nicht bereits laufend) und öffnet die App im Standardbrowser.
# Wird normalerweise nicht direkt aufgerufen, sondern über start-app.vbs (verhindert ein sichtbares Konsolenfenster).

$ErrorActionPreference = "SilentlyContinue"
$root = $PSScriptRoot
$port = 3000

function Test-PortOpen($port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect("127.0.0.1", $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(300, $false)
        $client.Close()
        return $ok
    } catch {
        return $false
    }
}

if (-not (Test-PortOpen $port)) {
    $nodeExe = "node.exe"
    if (Test-Path "C:\Program Files\nodejs\node.exe") {
        $nodeExe = "C:\Program Files\nodejs\node.exe"
    }
    Start-Process -FilePath $nodeExe -ArgumentList "server.js" -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

Start-Process "http://localhost:$port"

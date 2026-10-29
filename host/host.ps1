# yt-dlp Launcher - native messaging helper for Firefox.
# Works in Windows PowerShell 5.1 and PowerShell 7. Keep this file ASCII-only.
$ErrorActionPreference = 'Stop'

# ---- Locations known to work. Left blank so it searches dynamically via WinGet globs.
$KnownYtDlp      = ''
$KnownFfmpegDir = ''

$script:isWin      = ($env:OS -eq 'Windows_NT')
$script:exeSuffix  = ''
if ($script:isWin) { $script:exeSuffix = '.exe' }
$script:tools      = $null
$script:inStream   = [Console]::OpenStandardInput()
$script:outStream  = [Console]::OpenStandardOutput()
$script:pipeBroken = $false
$script:lenBuf     = New-Object byte[] 4
$script:inTask     = $null

# ---------- messaging ----------
function Send-Msg($obj) {
    if ($script:pipeBroken) { return }
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
        $script:outStream.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
        $script:outStream.Write($bytes, 0, $bytes.Length)
        $script:outStream.Flush()
    } catch { $script:pipeBroken = $true }
}

function Read-Bytes([byte[]]$buf, [int]$offset, [int]$count) {
    $got = 0
    while ($got -lt $count) {
        $r = $script:inStream.Read($buf, $offset + $got, $count - $got)
        if ($r -le 0) { return $false }
        $got += $r
    }
    return $true
}

function Read-Body([byte[]]$lenBuf) {
    $len = [BitConverter]::ToInt32($lenBuf, 0)
    if ($len -le 0 -or $len -gt 1048576) { return $null }
    $buf = New-Object byte[] $len
    if (-not (Read-Bytes $buf 0 $len)) { return $null }
    return ([Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json)
}

function Read-Msg {
    $b = New-Object byte[] 4
    if (-not (Read-Bytes $b 0 4)) { return $null }
    return (Read-Body $b)
}

function Start-StdinWatch {
    if ($null -eq $script:inTask) { $script:inTask = $script:inStream.ReadAsync($script:lenBuf, 0, 4) }
}

# Test-Path throws on a drive that doesn't exist; these never do.
function Test-File([string]$p) {
    try { return [bool](Test-Path -LiteralPath $p -PathType Leaf -ErrorAction SilentlyContinue) } catch { return $false }
}
function Test-Dir([string]$p) {
    try { return [bool](Test-Path -LiteralPath $p -PathType Container -ErrorAction SilentlyContinue) } catch { return $false }
}

# ---------- finding yt-dlp / ffmpeg / deno ----------
# Firefox starts this helper with whatever PATH Firefox itself had when it launched, which can be
# stale (missing tools installed since). So we look in many places, not just PATH.
function Get-LocalAppData {
    if ($env:LOCALAPPDATA) { return $env:LOCALAPPDATA }
    try { $d = [Environment]::GetFolderPath('LocalApplicationData'); if ($d) { return $d } } catch {}
    if ($env:USERPROFILE) { return [IO.Path]::Combine($env:USERPROFILE, 'AppData', 'Local') }
    return $null
}

function Get-WinGetDir([string]$leaf) {
    $local = Get-LocalAppData
    if (-not $local) { return $null }
    return [IO.Path]::Combine($local, 'Microsoft', 'WinGet', $leaf)
}

# PATH as currently stored by Windows (registry), which includes installs made after Firefox started.
function Get-FreshPathDirs {
    $dirs = @()
    if ($script:isWin) {
        foreach ($t in 'Machine', 'User') {
            $v = $null
            try { $v = [Environment]::GetEnvironmentVariable('Path', $t) } catch {}
            if ($v) { $dirs += ([Environment]::ExpandEnvironmentVariables($v) -split ';') }
        }
    }
    return @($dirs | Where-Object { $_ -and $_.Trim() })
}

function Find-InDirs([string]$file, $dirs) {
    foreach ($d in @($dirs)) {
        try {
            $p = [IO.Path]::Combine([string]$d, $file)
            if (Test-File $p) { return $p }
        } catch {}
    }
    return $null
}

function Find-Tool([string]$name, [string[]]$packageGlobs, [string[]]$known) {
    $file = $name + $script:exeSuffix
    $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
    $p = Find-InDirs $file (Get-FreshPathDirs)
    if ($p) { return $p }
    $links = Get-WinGetDir 'Links'
    if ($links) {
        $p = Find-InDirs $file @($links)
        if ($p) { return $p }
    }
    $pkgRoot = Get-WinGetDir 'Packages'
    if ($pkgRoot -and (Test-Dir $pkgRoot)) {
        foreach ($g in $packageGlobs) {
            foreach ($dir in @(Get-ChildItem -LiteralPath $pkgRoot -Directory -Filter $g -ErrorAction SilentlyContinue)) {
                $f = Get-ChildItem -LiteralPath $dir.FullName -Filter $file -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($f) { return $f.FullName }
            }
        }
    }
    foreach ($k in $known) {
        if ($k -and (Test-File $k)) { return $k }
    }
    return $null
}

function Get-Tools {
    if ($script:tools) { return $script:tools }
    $y = Find-Tool 'yt-dlp' @('yt-dlp.yt-dlp_*') @($KnownYtDlp)
    $f = Find-Tool 'ffmpeg' @('yt-dlp.FFmpeg_*', '*FFmpeg*') @(if ($KnownFfmpegDir) { [IO.Path]::Combine($KnownFfmpegDir, 'ffmpeg' + $script:exeSuffix) } else { '' })
    $d = Find-Tool 'deno' @('DenoLand.Deno_*') @()
    $ffDir = $null
    if ($f) { $ffDir = ([IO.Path]::GetDirectoryName($f)).TrimEnd('\', '/') }
    $dnDir = $null
    if ($d) { $dnDir = [IO.Path]::GetDirectoryName($d) }
    $script:tools = @{ ytdlp = $y; ffmpegDir = $ffDir; denoDir = $dnDir }
    return $script:tools
}

function Get-SearchNote {
    $local = Get-LocalAppData
    if (-not $local) { $local = '(LOCALAPPDATA is not set)' }
    return "Looked in PATH, the saved Windows PATH, $local\Microsoft\WinGet\Links, and $local\Microsoft\WinGet\Packages. None of them had yt-dlp."
}

function Get-DownloadsDir {
    $d = $null
    if ($script:isWin) {
        try {
            $k = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
            $raw = $k.'{374DE290-123F-4565-9164-39C4925E467B}'
            if ($raw) { $d = [Environment]::ExpandEnvironmentVariables([string]$raw) }
        } catch {}
    }
    if ((-not $d) -or (-not (Test-Dir $d))) {
        $base = $env:USERPROFILE
        if (-not $base) { $base = $env:HOME }
        $d = [IO.Path]::Combine($base, 'Downloads')
    }
    if (-not (Test-Dir $d)) { [void](New-Item -ItemType Directory -Path $d -Force) }
    return $d.TrimEnd('\', '/')
}

function Start-Tool([string]$exe, [string]$argString) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $argString
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $psi.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
    $psi.EnvironmentVariables['PYTHONUTF8'] = '1'

    $tools = Get-Tools
    $parts = New-Object System.Collections.ArrayList
    foreach ($d in @($tools.ffmpegDir, $tools.denoDir, (Get-WinGetDir 'Links'))) {
        if ($d -and (Test-Dir $d)) { [void]$parts.Add($d) }
    }
    if ($env:PATH) { [void]$parts.Add($env:PATH) }
    foreach ($d in (Get-FreshPathDirs)) { [void]$parts.Add($d) }
    $psi.EnvironmentVariables['PATH'] = ($parts -join [string][IO.Path]::PathSeparator)

    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    return $p
}

function Stop-Tree($p) {
    try {
        if ($script:isWin) {
            $k = New-Object System.Diagnostics.ProcessStartInfo 'taskkill.exe', "/PID $($p.Id) /T /F"
            $k.UseShellExecute = $false
            $k.CreateNoWindow = $true
            $k.RedirectStandardOutput = $true
            $k.RedirectStandardError = $true
            $kp = [System.Diagnostics.Process]::Start($k)
            [void]$kp.StandardOutput.ReadToEnd()
            $kp.WaitForExit()
        } else {
            $p.Kill()
        }
    } catch {}
}

function Get-Friendly([string]$errText, [bool]$usedLogin) {
    $lines = @($errText -split "`r?`n" | Where-Object { $_.Trim() })
    $last = $lines | Where-Object { $_ -match '^ERROR' } | Select-Object -Last 1
    if (-not $last) { $last = $lines | Select-Object -Last 1 }
    if (-not $last) { $last = 'yt-dlp stopped without saying why.' }
    $hint = $null
    if ($errText -match '(?i)not a bot') {
        if ($usedLogin) { $hint = "YouTube still wants proof you're not a bot, even with your Firefox login. Make sure you're signed in to YouTube in Firefox, or wait a while / switch network." }
        else { $hint = "YouTube wants proof you're not a bot on this connection. Turn on Settings > Use my Firefox login and try again, or wait a while / switch network." }
    } elseif ($errText -match '(?i)\b429\b|too many requests') {
        $hint = 'YouTube is limiting this connection. Wait a while, or switch network (a phone hotspot works), then try again.'
    } elseif ($errText -match '(?i)ffmpeg.*(not found|not installed)|ffprobe.*not found') {
        $hint = "ffmpeg wasn't found. Install it with: winget install yt-dlp.yt-dlp"
    } elseif ($errText -match '(?i)private video|confirm your age|members-only|video unavailable|not available') {
        $hint = "YouTube won't let this video be downloaded without signing in, or it isn't available."
    }
    $text = if ($hint) { $hint } else { [string]$last }
    return @{ message = $text; detail = [string]$last }
}

function Invoke-YtDlp([string]$exe, [string]$argString) {
    $p = Start-Tool $exe $argString
    $cancelled = $false
    $finalPath = ''
    $already = $false
    $err = ''
    try {
        $outTask = $p.StandardOutput.ReadLineAsync()
        $errTask = $p.StandardError.ReadToEndAsync()
        Start-StdinWatch
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $lastProgress = -1000
        while ($true) {
            if ($outTask.Wait(100)) {
                $line = $outTask.Result
                if ($null -eq $line) { break }
                if ($line.StartsWith('FILEPATH|')) {
                    $finalPath = $line.Substring(9)
                } else {
                    if ($line -match 'has already been downloaded') { $already = $true }
                    $isProgress = ($line -match '^\[download\]\s+[\d.]+%')
                    $now = $sw.ElapsedMilliseconds
                    if ((-not $isProgress) -or (($now - $lastProgress) -ge 250) -or ($line -match '\s100(\.0+)?%')) {
                        if ($isProgress) { $lastProgress = $now }
                        Send-Msg @{ type = 'log'; line = $line }
                    }
                }
                $outTask = $p.StandardOutput.ReadLineAsync()
            }
            if ($script:pipeBroken) { $cancelled = $true; Stop-Tree $p; break }
            if ($script:inTask.IsCompleted) {
                $n = 0
                try { $n = [int]$script:inTask.Result } catch { $n = 0 }
                $script:inTask = $null
                if ($n -le 0) { $cancelled = $true; Stop-Tree $p; break }
                if (($n -lt 4) -and (-not (Read-Bytes $script:lenBuf $n (4 - $n)))) { $cancelled = $true; Stop-Tree $p; break }
                $m = Read-Body $script:lenBuf
                if ($m -and $m.action -eq 'cancel') { $cancelled = $true; Stop-Tree $p; break }
                Start-StdinWatch
            }
        }
        if (-not $p.WaitForExit(15000)) { Stop-Tree $p }
        $p.WaitForExit()
        if ($errTask.Wait(3000)) { $err = [string]$errTask.Result }
    } finally {
        if (-not $p.HasExited) { Stop-Tree $p }
    }
    return @{ code = $p.ExitCode; err = $err; cancelled = $cancelled; finalPath = $finalPath; already = $already }
}

function Invoke-Check {
    $t = Get-Tools
    if (-not $t.ytdlp) {
        Send-Msg @{ type = 'check'; ok = $false; message = 'yt-dlp was not found.'; detail = (Get-SearchNote) }
        return
    }
    Send-Msg @{ type = 'check'; ok = $true; ytdlp = [string]$t.ytdlp; ffmpeg = [bool]$t.ffmpegDir; deno = [bool]$t.denoDir }
}

function Invoke-Download($msg) {
    $url = [string]$msg.url
    if ($url -cnotmatch '^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}$') {
        throw "That doesn't look like a YouTube video link."
    }
    $height = 0
    if ((-not [int]::TryParse([string]$msg.height, [ref]$height)) -or $height -lt 0 -or $height -gt 4320) {
        throw 'Unsupported resolution.'
    }
    $tools = Get-Tools
    $exe = $tools.ytdlp
    if (-not $exe) {
        Send-Msg @{ type = 'done'; ok = $false; message = 'yt-dlp was not found.'; detail = (Get-SearchNote) }
        return
    }
    $ffArg = ''
    if ($tools.ffmpegDir) { $ffArg = "--ffmpeg-location `"$($tools.ffmpegDir)`" " }

    $dl = Get-DownloadsDir

    $audio = [string]$msg.audio
    if (@('low', 'medium', 'high', 'super') -notcontains $audio) { $audio = 'high' }
    switch ($audio) {
        'low'    { $aSel = 'ba[abr<=70]' }
        'medium' { $aSel = 'ba[abr<=130]' }
        'high'   { $aSel = 'ba[abr<=170]' }
        default  { $aSel = 'ba' }
    }
    if ($height -gt 0) { $v = "bv*[height<=$height]"; $hf = "[height<=$height]" } else { $v = 'bv*'; $hf = '' }
    if ($aSel -eq 'ba') { $fmt = "$v+ba/b$hf" } else { $fmt = "$v+$aSel/$v+ba/b$hf" }

    $tpl = '%(title)s.%(ext)s'
    if ($msg.idInName) { $tpl = '%(title)s [%(id)s].%(ext)s' }
    $login = [bool]$msg.login
    $loginArg = ''
    if ($login) { $loginArg = '--cookies-from-browser firefox ' }

    $base = '--newline --no-colors --no-quiet --no-playlist --encoding utf-8 --trim-filenames 200 ' +
            "-f `"$fmt`" --merge-output-format mkv --remux-video mkv " + $ffArg + $loginArg +
            '--embed-metadata --embed-chapters --embed-thumbnail ' +
            "-P `"$dl`" -o `"$tpl`" " +
            '--print "after_move:FILEPATH|%(filepath)s"'
    $subArgs = '--write-subs --write-auto-subs --sub-langs en --sleep-subtitles 2 --embed-subs'

    $note = ''
    if ($msg.subs) {
        $r = Invoke-YtDlp $exe "$base $subArgs `"$url`""
        if ((-not $r.cancelled) -and $r.code -ne 0 -and $r.err -match '(?i)subtitle') {
            Send-Msg @{ type = 'log'; line = 'Captions were blocked by YouTube. Downloading without captions...' }
            $note = ' (YouTube blocked the captions)'
            $r = Invoke-YtDlp $exe "$base `"$url`""
        }
    } else {
        $r = Invoke-YtDlp $exe "$base `"$url`""
    }

    if ($r.cancelled) {
        Send-Msg @{ type = 'done'; ok = $false; cancelled = $true; message = 'Download cancelled.' }
    } elseif ($r.code -eq 0) {
        $text = if ($r.already) { 'A file with this title is already in your Downloads folder.' } else { 'Saved to your Downloads folder.' }
        Send-Msg @{ type = 'done'; ok = $true; message = ($text + $note); filePath = [string]$r.finalPath }
    } else {
        $f = Get-Friendly $r.err $login
        Send-Msg @{ type = 'done'; ok = $false; message = $f.message; detail = $f.detail }
    }
}

function Invoke-Reveal($msg) {
    $sep = [string][IO.Path]::DirectorySeparatorChar
    $dl = [IO.Path]::GetFullPath((Get-DownloadsDir)).TrimEnd($sep) + $sep
    $path = [IO.Path]::GetFullPath([string]$msg.path)
    $ok = $path.StartsWith($dl, [StringComparison]::OrdinalIgnoreCase) -and (Test-File $path)
    if (-not $ok) {
        Send-Msg @{ type = 'reveal'; ok = $false; message = 'That file is not in your Downloads folder.' }
        return
    }
    if ($script:isWin) {
        try {
            $ep = [System.Diagnostics.Process]::Start('explorer.exe', "/select,`"$path`"")
            if ($ep) { [void]$ep.WaitForExit(5000) }
            Start-Sleep -Milliseconds 300
        } catch {
            Send-Msg @{ type = 'reveal'; ok = $false; message = $_.Exception.Message }
            return
        }
    }
    Send-Msg @{ type = 'reveal'; ok = $true }
}

try {
    $req = Read-Msg
    if ($null -eq $req) { exit 0 }
    switch ([string]$req.action) {
        'check'    { Invoke-Check }
        'download' { Invoke-Download $req }
        'reveal'   { Invoke-Reveal $req }
        default    { Send-Msg @{ type = 'done'; ok = $false; message = 'Unknown request.' } }
    }
} catch {
    $text = $_.Exception.Message
    Send-Msg @{ type = 'done'; ok = $false; message = $text; detail = $text }
}
exit 0
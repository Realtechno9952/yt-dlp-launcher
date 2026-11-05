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
    } elseif ($errText -match '(?i)requested format is not available') {
        $hint = "That resolution or file type isn't offered for this video. Try Best, or another resolution."
    } elseif ($errText -match '(?i)unsupported url|no video could be found|no video formats found') {
        $hint = "yt-dlp can't find a video it can download on this page."
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
    $files = 0
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
                    $finalPath = $line.Substring(9); $files++
                } else {
                    if ($line -match 'has already been downloaded|already present|already exists') { $already = $true }
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
    return @{ code = $p.ExitCode; err = $err; cancelled = $cancelled; finalPath = $finalPath; already = $already; files = $files }
}

function Invoke-Check {
    $t = Get-Tools
    if (-not $t.ytdlp) {
        Send-Msg @{ type = 'check'; ok = $false; message = 'yt-dlp was not found.'; detail = (Get-SearchNote) }
        return
    }
    Send-Msg @{ type = 'check'; ok = $true; ytdlp = [string]$t.ytdlp; ffmpeg = [bool]$t.ffmpegDir; deno = [bool]$t.denoDir }
}

function Test-TargetUrl([string]$u) {
    if ($u.Length -gt 2000 -or $u -cnotmatch '^https?://[^\s"<>]+$') { throw "That doesn't look like a link I can download from." }
    return $u
}

function Get-OutDir([string]$folder) {
    if (-not $folder) { return (Get-DownloadsDir) }
    if ($folder.Contains('"')) { throw 'The download folder path has a character that is not allowed.' }
    try {
        if (-not [IO.Path]::IsPathRooted($folder)) { throw 'The download folder must be a full path such as D:\Videos.' }
        $full = [IO.Path]::GetFullPath($folder).TrimEnd('\', '/')
        if ($full.Length -le 2) { throw 'Choose a folder, not a whole drive.' }
        if (-not (Test-Dir $full)) { [void](New-Item -ItemType Directory -Path $full -Force) }
        return $full
    } catch {
        throw ("Can't use that download folder: " + $_.Exception.Message)
    }
}

function Format-Clock([double]$sec) {
    $ts = [TimeSpan]::FromSeconds($sec)
    return ('{0}:{1:00}:{2:00}' -f [int][math]::Floor($ts.TotalHours), $ts.Minutes, $ts.Seconds)
}
function Format-ClockLabel([double]$sec) {
    $ts = [TimeSpan]::FromSeconds($sec)
    return ('{0}h{1:00}m{2:00}s' -f [int][math]::Floor($ts.TotalHours), $ts.Minutes, $ts.Seconds)
}

function Invoke-Quick([string]$exe, [string]$argString, [int]$timeoutMs = 60000) {
    $p = Start-Tool $exe $argString
    $o = $p.StandardOutput.ReadToEndAsync()
    $e = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($timeoutMs)) { Stop-Tree $p }
    [void]$o.Wait(3000)
    [void]$e.Wait(3000)
    $out = ''
    if ($o.IsCompleted) { $out = [string]$o.Result }
    $err = ''
    if ($e.IsCompleted) { $err = [string]$e.Result }
    return @{ code = $p.ExitCode; out = $out; err = $err }
}

function Find-Winget {
    $apps = $null
    $local = Get-LocalAppData
    if ($local) { $apps = [IO.Path]::Combine($local, 'Microsoft', 'WindowsApps', 'winget.exe') }
    return (Find-Tool 'winget' @() @($apps))
}

function Invoke-Download($msg) {
    $url = Test-TargetUrl ([string]$msg.url)
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
    if ($tools.ffmpegDir) { $ffArg = "--ffmpeg-location `"$($tools.ffmpegDir)`"" }

    $dl = Get-OutDir ([string]$msg.folder)
    $where = 'your Downloads folder'
    if ($msg.folder) { $where = 'your download folder' }

    $ext = [string]$msg.ext
    if (@('mkv', 'mp4', 'webm', 'mp3', 'm4a', 'opus', 'flac') -notcontains $ext) { $ext = 'mkv' }
    $isAudio = (@('mp3', 'm4a', 'opus', 'flac') -contains $ext)
    $playlist = [bool]$msg.playlist
    $plMax = 0
    if ($playlist) {
        [void][int]::TryParse([string]$msg.playlistMax, [ref]$plMax)
        if ($plMax -lt 0 -or $plMax -gt 1000) { $plMax = 100 }
    }
    $subLangs = [string]$msg.subLangs
    if (-not $subLangs) { $subLangs = 'en' }
    if ($subLangs -notmatch '^[A-Za-z0-9*_.,-]{1,60}$') { throw 'Bad subtitle language setting.' }

    # just a section of the video
    $clipArg = ''
    $clipLabel = ''
    if ($msg.clip -and -not $playlist) {
        try { $cs = [double]$msg.clip.start; $ce = [double]$msg.clip.end } catch { throw 'Bad clip times.' }
        if ($cs -lt 0 -or $ce -le $cs -or $ce -gt 86400) { throw 'Bad clip times.' }
        $cs = [math]::Floor($cs)
        $ce = [math]::Ceiling($ce)
        $clipArg = '--download-sections "*' + (Format-Clock $cs) + '-' + (Format-Clock $ce) + '"'
        if ($msg.clipAccurate) { $clipArg = $clipArg + ' --force-keyframes-at-cuts' }
        $clipLabel = (Format-ClockLabel $cs) + '-' + (Format-ClockLabel $ce)
    }

    # Audio quality tiers. YouTube's audio is ~48k AAC, ~128k AAC, ~50-160k Opus (and 256k AAC on some videos).
    $audio = [string]$msg.audio
    if (@('low', 'medium', 'high', 'super') -notcontains $audio) { $audio = 'high' }
    switch ($audio) {
        'low'    { $aSel = 'ba[abr<=?70]' }
        'medium' { $aSel = 'ba[abr<=?130]' }
        'high'   { $aSel = 'ba[abr<=?170]' }
        default  { $aSel = 'ba' }
    }

    $all = New-Object System.Collections.Generic.List[string]
    $all.Add('--newline --no-colors --no-quiet --encoding utf-8 --trim-filenames 200')
    if ($playlist) {
        $all.Add('--yes-playlist')
        if ($plMax -gt 0) { $all.Add("--playlist-end $plMax") }
    } else {
        $all.Add('--no-playlist')
    }

    if ($isAudio) {
        if ($aSel -eq 'ba') { $fmt = 'ba/b' } else { $fmt = "$aSel/ba/b" }
        $all.Add("-f `"$fmt`" -x --audio-format $ext --audio-quality 0")
    } else {
        if ($height -gt 0) { $v = "bv*[height<=?$height]"; $hf = "[height<=?$height]" } else { $v = 'bv*'; $hf = '' }
        if ($ext -eq 'webm') {
            if ($height -gt 0) { $vw = "bv*[height<=?$height][ext=webm]" } else { $vw = 'bv*[ext=webm]' }
            $aw = $aSel -replace '^ba', 'ba[ext=webm]'
            $fmt = "$vw+$aw/$vw+ba[ext=webm]/$v+ba/b$hf"
        } elseif ($aSel -eq 'ba') {
            $fmt = "$v+ba/b$hf"
        } else {
            $fmt = "$v+$aSel/$v+ba/b$hf"
        }
        $all.Add("-f `"$fmt`"")
        if ($ext -eq 'mp4') { $all.Add('-S "res,vcodec:h264,acodec:aac"') }
        if ($ext -eq 'webm') {
            # Merge only: yt-dlp falls back to mkv if the codecs don't fit WebM, whereas a forced remux would fail.
            $all.Add("--merge-output-format $ext")
        } else {
            $all.Add("--merge-output-format $ext --remux-video $ext")
        }
    }
    if ($ffArg) { $all.Add($ffArg) }
    $login = [bool]$msg.login
    if ($login) { $all.Add('--cookies-from-browser firefox') }

    # what gets embedded in the file
    if (([bool]$msg.thumb) -and ($ext -ne 'webm')) { $all.Add('--embed-thumbnail') }
    if ($msg.meta) {
        $all.Add('--embed-metadata')
        if (-not $msg.desc) { $all.Add('--parse-metadata ":(?P<meta_description>)" --parse-metadata ":(?P<meta_comment>)"') }
    }
    if ($msg.chapters) { $all.Add('--embed-chapters') }
    if ($msg.infoJson -and $ext -eq 'mkv') { $all.Add('--embed-info-json') }
    if ($msg.sponsor) { $all.Add('--sponsorblock-mark all') }
    if ($clipArg) { $all.Add($clipArg) }

    if ($playlist) { $tpl = '%(playlist_title)s/%(playlist_index)s - %(title)s' } else { $tpl = '%(title)s' }
    if ($clipLabel) { $tpl = $tpl + ' (clip ' + $clipLabel + ')' }
    if ($msg.idInName) { $tpl = $tpl + ' [%(id)s]' }
    $tpl = $tpl + '.%(ext)s'
    $all.Add("-P `"$dl`" -o `"$tpl`"")
    $all.Add('--print "after_move:FILEPATH|%(filepath)s"')
    $base = $all -join ' '

    $subArgs = "--write-subs --write-auto-subs --sub-langs `"$subLangs`" --sleep-subtitles 2 --embed-subs"
    $withSubs = ([bool]$msg.subs) -and (-not $isAudio)

    $note = ''
    if ($withSubs) {
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
        if ($playlist) { $text = "Saved $($r.files) video(s) to $where." }
        elseif ($r.already) { $text = "A file with this title is already in $where." }
        else { $text = "Saved to $where." }
        Send-Msg @{ type = 'done'; ok = $true; message = ($text + $note); filePath = [string]$r.finalPath }
    } else {
        $f = Get-Friendly $r.err $login
        Send-Msg @{ type = 'done'; ok = $false; message = $f.message; detail = $f.detail }
    }
}

function Invoke-Thumbnail($msg) {
    $url = Test-TargetUrl ([string]$msg.url)
    $fmt = [string]$msg.format
    if (@('png', 'jpg', 'jpeg', 'webp', 'jxl') -notcontains $fmt) { $fmt = 'png' }
    $tools = Get-Tools
    if (-not $tools.ytdlp) {
        Send-Msg @{ type = 'thumbnail'; ok = $false; message = 'yt-dlp was not found.' }
        return
    }
    $dl = Get-OutDir ([string]$msg.folder)
    $conv = $fmt
    if ($fmt -eq 'jpeg') { $conv = 'jpg' } elseif ($fmt -eq 'jxl') { $conv = 'png' }
    $all = New-Object System.Collections.Generic.List[string]
    $all.Add("--no-playlist --skip-download --write-thumbnail --convert-thumbnails $conv --newline --no-colors --encoding utf-8 --trim-filenames 200")
    if ($tools.ffmpegDir) { $all.Add("--ffmpeg-location `"$($tools.ffmpegDir)`"") }
    $all.Add("-P `"$dl`" -o `"%(title)s.%(ext)s`" `"$url`"")
    $t0 = (Get-Date).AddSeconds(-3)
    $r = Invoke-YtDlp $tools.ytdlp ($all -join ' ')
    if ($r.cancelled) {
        Send-Msg @{ type = 'thumbnail'; ok = $false; message = 'Cancelled.' }
        return
    }
    if ($r.code -ne 0) {
        $f = Get-Friendly $r.err $false
        Send-Msg @{ type = 'thumbnail'; ok = $false; message = $f.message; detail = $f.detail }
        return
    }
    $imgExt = @('.png', '.jpg', '.jpeg', '.webp')
    $cand = @(Get-ChildItem -LiteralPath $dl -File -ErrorAction SilentlyContinue | Where-Object { $imgExt -contains $_.Extension.ToLower() } | Sort-Object LastWriteTime -Descending)
    $fresh = @($cand | Where-Object { $_.LastWriteTime -gt $t0 })
    $file = $null
    if ($fresh.Count -gt 0) { $file = $fresh[0] } elseif ($r.already -and $cand.Count -gt 0) { $file = $cand[0] }
    if (-not $file) {
        Send-Msg @{ type = 'thumbnail'; ok = $false; message = "yt-dlp finished, but I couldn't find the saved thumbnail." }
        return
    }
    $path = $file.FullName
    $text = 'Saved.'
    if ($fmt -eq 'jpeg') {
        $dest = [IO.Path]::ChangeExtension($path, '.jpeg')
        Move-Item -LiteralPath $path -Destination $dest -Force
        $path = $dest
    } elseif ($fmt -eq 'jxl') {
        $ffm = $null
        if ($tools.ffmpegDir) { $ffm = [IO.Path]::Combine($tools.ffmpegDir, 'ffmpeg' + $script:exeSuffix) }
        $hasJxl = $false
        if ($ffm -and (Test-File $ffm)) { $hasJxl = ((Invoke-Quick $ffm '-hide_banner -encoders' 30000).out -match 'libjxl') }
        $dest = [IO.Path]::ChangeExtension($path, '.jxl')
        if ($hasJxl) {
            [void](Invoke-Quick $ffm "-y -loglevel error -i `"$path`" -c:v libjxl -distance 1 `"$dest`"" 120000)
        }
        if ($hasJxl -and (Test-File $dest)) {
            Remove-Item -LiteralPath $path -Force
            $path = $dest
        } else {
            $text = "Saved as PNG, because this ffmpeg can't write JPEG XL."
        }
    }
    Send-Msg @{ type = 'thumbnail'; ok = $true; name = [IO.Path]::GetFileName($path); filePath = $path; message = $text }
}

function Invoke-Versions {
    $t = Get-Tools
    $y = ''
    if ($t.ytdlp) {
        try { $y = (Invoke-Quick $t.ytdlp '--version' 30000).out.Trim() } catch {}
        $y = ($y -split "`r?`n")[0]
    }
    $f = ''
    if ($t.ffmpegDir) {
        $ffm = [IO.Path]::Combine($t.ffmpegDir, 'ffmpeg' + $script:exeSuffix)
        if (Test-File $ffm) {
            try {
                $o = (Invoke-Quick $ffm '-version' 30000).out
                if ($o -match '(?m)^ffmpeg version (\S+)') { $f = $Matches[1] }
            } catch {}
        }
    }
    Send-Msg @{ type = 'versions'; ok = $true; ytdlp = [string]$y; ffmpeg = [string]$f; winget = [bool](Find-Winget) }
}

function Invoke-Update($msg) {
    $target = [string]$msg.target
    if ($target -ne 'ytdlp' -and $target -ne 'ffmpeg') { throw 'Unknown update target.' }
    $id = 'yt-dlp.yt-dlp'
    if ($target -eq 'ffmpeg') { $id = 'yt-dlp.FFmpeg' }
    $t = Get-Tools
    $wg = Find-Winget
    if ($wg) {
        Send-Msg @{ type = 'log'; line = 'Asking winget to update...' }
        $r = Invoke-YtDlp $wg "upgrade --id $id --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity"
    } elseif ($target -eq 'ytdlp' -and $t.ytdlp) {
        Send-Msg @{ type = 'log'; line = 'winget was not found, so using the built-in yt-dlp updater...' }
        $r = Invoke-YtDlp $t.ytdlp '-U'
    } else {
        Send-Msg @{ type = 'done'; ok = $false; message = "winget wasn't found. Update it yourself with: winget upgrade --id $id" }
        return
    }
    $script:tools = $null
    if ($r.cancelled) {
        Send-Msg @{ type = 'done'; ok = $false; message = 'The update was interrupted.' }
    } elseif ($r.code -eq 0) {
        Send-Msg @{ type = 'done'; ok = $true; message = 'Updated.' }
    } elseif ($r.code -eq -1978335189) {
        # winget: no applicable upgrade found
        Send-Msg @{ type = 'done'; ok = $true; message = 'Already up to date.' }
    } else {
        $f = Get-Friendly $r.err $false
        Send-Msg @{ type = 'done'; ok = $false; message = "The update didn't finish (code $($r.code))."; detail = $f.detail }
    }
}

function Invoke-PickFolder($msg) {
    if (-not $script:isWin) {
        Send-Msg @{ type = 'pickfolder'; ok = $false; message = 'The folder picker only works on Windows.' }
        return
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    # A tiny invisible top-most window gives the dialog something to sit on top of.
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.Opacity = 0
    $owner.StartPosition = 'CenterScreen'
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Show()
    try {
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Choose where downloads are saved'
        $dlg.ShowNewFolderButton = $true
        $start = [string]$msg.start
        if ($start -and (Test-Dir $start)) { $dlg.SelectedPath = $start }
        $res = $dlg.ShowDialog($owner)
        if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
            Send-Msg @{ type = 'pickfolder'; ok = $true; path = [string]$dlg.SelectedPath }
        } else {
            Send-Msg @{ type = 'pickfolder'; ok = $false; cancelled = $true }
        }
    } finally {
        $owner.Close()
    }
}

function Invoke-CheckFolder($msg) {
    $p = Get-OutDir ([string]$msg.path)
    Send-Msg @{ type = 'checkfolder'; ok = $true; path = $p }
}

function Invoke-Reveal($msg) {
    $path = [IO.Path]::GetFullPath([string]$msg.path)
    if (-not (Test-File $path)) {
        Send-Msg @{ type = 'reveal'; ok = $false; message = "That file isn't there any more." }
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
        'check'       { Invoke-Check }
        'download'    { Invoke-Download $req }
        'thumbnail'   { Invoke-Thumbnail $req }
        'versions'    { Invoke-Versions }
        'update'      { Invoke-Update $req }
        'pickfolder'  { Invoke-PickFolder $req }
        'checkfolder' { Invoke-CheckFolder $req }
        'reveal'      { Invoke-Reveal $req }
        default       { Send-Msg @{ type = 'done'; ok = $false; message = 'Unknown request.' } }
    }
} catch {
    $text = $_.Exception.Message
    Send-Msg @{ type = 'done'; ok = $false; message = $text; detail = $text }
}
exit 0

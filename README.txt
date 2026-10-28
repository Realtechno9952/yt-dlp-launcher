yt-dlp Launcher for Firefox (Windows) - v2
==========================================

Needs: yt-dlp installed   ->  winget install yt-dlp.yt-dlp   (this also brings ffmpeg)

SETUP
1. Put this folder somewhere permanent (e.g. Documents). Don't move or delete it later.
2. Register the helper (one time). In PowerShell, inside the "host" folder:
       powershell -ExecutionPolicy Bypass -File .\install.ps1
3. In Firefox open  about:debugging#/runtime/this-firefox  -> "Load Temporary Add-on..."
   -> choose  extension\manifest.json
4. If you don't see the button: click the puzzle-piece (Extensions) button, then the gear
   next to "yt-dlp Launcher" -> "Pin to Toolbar".

USING IT
  Open a YouTube video, click the button, pick a resolution, "Download as MKV".
  Bottom bar:  Settings | Download | History.  Tap to switch, or press and hold the bar and
  drag the glass lens. Other downloads in progress appear as small cards at the top.

SETTINGS
  Default resolution / captions, Sound quality (Low, Medium, High, Super High),
  Downloads at once (1-3), add the video ID to filenames, use your Firefox login
  (helps with "Sign in to confirm you're not a bot"), theme, accent colour, animations.

UPDATING
  Replace the folder's files, then on about:debugging click "Reload" next to the extension.
  Re-run install.ps1 only if you moved the folder.

WHERE IT LOOKS FOR yt-dlp / ffmpeg
  PATH, the saved Windows PATH, WinGet's Links and Packages folders, and finally the two
  exact paths at the top of host\host.ps1 ($KnownYtDlp / $KnownFfmpegDir). Edit those if you
  ever move them.

TROUBLESHOOTING
  - "Helper not set up": run step 2 again, then Reload the extension.
  - "yt-dlp not found": the popup shows where it looked.
  - Anything else: about:debugging -> This Firefox -> yt-dlp Launcher -> Inspect -> Console.
  - Remove the helper: powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall

PERMANENT INSTALL
  Zip the "extension" folder's CONTENTS and upload it at addons.mozilla.org
  (Developer Hub -> "On your own" / unlisted). It's free and returns a signed .xpi in minutes.

import { ChildProcess, spawn } from 'node:child_process'

// Reads what media apps on this PC are playing (Spotify, browsers, Apple Music, Media Player…) from Windows' System
// Media Transport Controls, so lyrics can sync to the music you are actually listening to. The only controls it ever
// sends are the ones you ask for: a seek when you click a lyric line, and play/pause/next/previous. One PowerShell process runs only while something is watching.

import type { Playing } from './parse'
export type { Playing }

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
# Cover art the app gives Windows, read once per song (as a data: URL) and sent only on the report where it's new.
$arts = @{}
# Windows PowerShell returns the stream as a bare COM object, so its members are reached through the interface type.
$ras = [Windows.Storage.Streams.IRandomAccessStream]
function ReadArt($ref) {
  $st = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $size = [uint32]$ras.GetProperty('Size').GetValue($st)
  if ($size -eq 0 -or $size -gt 4000000) { return '' }
  $rd = New-Object Windows.Storage.Streams.DataReader($ras.GetMethod('GetInputStreamAt').Invoke($st, @([uint64]0)))
  [void](Await ($rd.LoadAsync($size)) ([uint32]))
  $bytes = New-Object byte[] $size
  $rd.ReadBytes($bytes)
  $type = if ($bytes[0] -eq 0x89) { 'image/png' } else { 'image/jpeg' }
  'data:' + $type + ';base64,' + [Convert]::ToBase64String($bytes)
}
# Commands from Verse arrive on stdin. Console.In.ReadLineAsync blocks in Windows PowerShell, so read the raw stream
# instead: Stream.ReadAsync runs on a background thread and lets the report loop keep going.
$stdin = [Console]::OpenStandardInput()
$inBuf = New-Object byte[] 4096
$pending = ''
$read = $stdin.ReadAsync($inBuf, 0, $inBuf.Length)
while ($true) {
  $out = New-Object System.Collections.ArrayList
  foreach ($s in $mgr.GetSessions()) {
    try {
      $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
      $tl = $s.GetTimelineProperties(); $pb = $s.GetPlaybackInfo()
      $row = @{
        app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist
        status = [string]$pb.PlaybackStatus
        position = $tl.Position.TotalSeconds; end = $tl.EndTime.TotalSeconds
        updated = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
      }
      $key = $s.SourceAppUserModelId + '|' + $p.Title + '|' + $p.Artist
      if (-not $arts.ContainsKey($key)) {
        # The app can set the art a moment after the title; retry on the next report if it isn't there yet.
        $art = ''
        if ($p.Thumbnail) { try { $art = ReadArt $p.Thumbnail } catch { } }
        if ($art) { $arts[$key] = 1; $row.art = $art }
      }
      [void]$out.Add($row)
    } catch { }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 3 -InputObject @($out)))
  [Console]::Out.Flush()
  # Wait up to 400 ms for a command from Verse, so a seek is acted on at once.
  if ($read.Wait(400)) {
    $n = $read.Result
    if ($n -le 0) { exit }  # Verse closed our input: stop
    $pending += [Text.Encoding]::UTF8.GetString($inBuf, 0, $n)
    while (($i = $pending.IndexOf([char]10)) -ge 0) {
      $line = $pending.Substring(0, $i); $pending = $pending.Substring($i + 1)
      try {
        $c = ConvertFrom-Json $line
        foreach ($s in $mgr.GetSessions()) {
          if ($s.SourceAppUserModelId -ne $c.app) { continue }
          $op = switch ($c.action) {
            'toggle' { $s.TryTogglePlayPauseAsync() }
            'next' { $s.TrySkipNextAsync() }
            'prev' { $s.TrySkipPreviousAsync() }
            default { $s.TryChangePlaybackPositionAsync([long]([double]$c.position * 10000000)) }
          }
          [void](Await $op ([bool]))
        }
      } catch { }
    }
    $read = $stdin.ReadAsync($inBuf, 0, $inBuf.Length)
  }
}
`

let proc: ChildProcess | null = null
const listeners = new Set<(p: Playing[]) => void>()

function start() {
  if (process.platform !== 'win32' || proc) return
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true })
  proc = p
  let buf = ''
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (d: string) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        const v = JSON.parse(line)
        const all = (Array.isArray(v) ? v : [v]) as Playing[]
        for (const l of listeners) l(all)
      } catch { /* not a complete JSON line */ }
    }
  })
  p.on('error', () => { if (proc === p) proc = null })
  p.on('exit', () => { if (proc === p) proc = null; if (listeners.size) setTimeout(start, 3000) }) // restart if it dies while needed
}

export function watchNowPlaying(cb: (p: Playing[]) => void): () => void {
  listeners.add(cb)
  start()
  return () => { listeners.delete(cb); if (!listeners.size) stopNowPlaying() }
}

// Asks the app playing `app` to jump to `seconds` (Windows' own seek, the one in the volume flyout).
export function seekNowPlaying(app: string, seconds: number) {
  if (!proc?.stdin?.writable || !Number.isFinite(seconds) || seconds < 0) return false
  proc.stdin.write(JSON.stringify({ app, position: seconds }) + '\n')
  return true
}

// Play/pause, next or previous in that app (the same buttons as the keyboard media keys).
export function controlNowPlaying(app: string, action: 'toggle' | 'next' | 'prev') {
  if (!proc?.stdin?.writable) return false
  proc.stdin.write(JSON.stringify({ app, action }) + '\n')
  return true
}

export function stopNowPlaying() { listeners.clear(); const p = proc; proc = null; p?.kill() }

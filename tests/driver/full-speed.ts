/**
 * Keeps a test app on Windows running at full speed.
 *
 * Windows 11 throttles a process that has no window on screen (power throttling, "EcoQoS"): it runs at a fraction of its
 * speed, and can stop for seconds at a time. A test app's window is never shown, so Windows throttles its main process and
 * the helper processes it starts (the media worker, the preview's dev server). Measured on the test laptop: importing four
 * large photos took 150–320 s instead of 47 s, with the main process not answering the window for up to 5 s at a time.
 * The editor's renderers are not affected: Chromium sets their priority itself. A window on screen is not throttled, so a
 * test app is opted out, with every process it starts, for as long as it runs.
 */
import { spawn } from 'node:child_process';

/**
 * The PowerShell that opts the processes under `rootPid` out of power throttling, looking again every second for new
 * ones, until that process has gone. A process counts as under it only when it started after its parent, so a process
 * that took a dead parent's ID is never touched.
 */
export function fullSpeedScript(rootPid: number): string {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error(`Not a process ID: ${rootPid}`);
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SiteOriginFullSpeed {
  [StructLayout(LayoutKind.Sequential)] struct State { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref State state, int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  // PROCESS_SET_INFORMATION; ProcessPowerThrottling; execution speed controlled, and not throttled.
  public static bool Set(int pid) {
    IntPtr h = OpenProcess(0x0200, false, pid);
    if (h == IntPtr.Zero) return false;
    State s = new State(); s.Version = 1; s.ControlMask = 1; s.StateMask = 0;
    bool ok = SetProcessInformation(h, 4, ref s, Marshal.SizeOf(typeof(State)));
    CloseHandle(h);
    return ok;
  }
}
'@
$root = ${rootPid}
$done = @{}
while (Get-Process -Id $root) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
  $byId = @{}
  foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  $open = [System.Collections.Generic.Queue[int]]::new()
  $open.Enqueue($root)
  $under = @()
  while ($open.Count) {
    $at = $open.Dequeue()
    $under += $at
    foreach ($p in $all) {
      if ([int]$p.ParentProcessId -eq $at -and [int]$p.ProcessId -ne $at -and $byId[$at] -and $p.CreationDate -ge $byId[$at].CreationDate) { $open.Enqueue([int]$p.ProcessId) }
    }
  }
  foreach ($id in $under) { if (-not $done[$id]) { if ([SiteOriginFullSpeed]::Set($id)) { $done[$id] = $true } } }
  Start-Sleep -Milliseconds 1000
}
`;
}

/**
 * On Windows, opt the process `rootPid` and every process it starts out of power throttling while it runs; elsewhere,
 * nothing. Returns how to stop early (the helper also stops by itself once the process has gone).
 */
export function keepAtFullSpeed(rootPid: number, platform: NodeJS.Platform = process.platform): () => void {
  if (platform !== 'win32') return () => {};
  // Encoded, so no quoting of the command line can change it.
  const encoded = Buffer.from(fullSpeedScript(rootPid), 'utf16le').toString('base64');
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
  helper.on('error', () => undefined);
  helper.unref();
  return () => {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
  };
}

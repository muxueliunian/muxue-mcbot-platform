# mcbot 窗口截图辅助脚本（由 mcp-server 的 player-view 调用，PowerShell 7）
# -Action list    : 列出可见的顶层窗口（句柄、标题、进程、客户区尺寸、是否最小化），输出一行 JSON
# -Action capture : 只截 -Handle 指定窗口的客户区（PrintWindow + PW_RENDERFULLCONTENT），
#                   原始 BGRA 像素写到 -OutFile，输出一行 JSON（宽高等）。找不到窗口时报错，绝不截整个屏幕
# 不依赖 System.Drawing：只用 user32/gdi32，图片编码在 Node 里完成
param(
  [Parameter(Mandatory = $true)][ValidateSet('list', 'capture')][string]$Action,
  [long]$Handle = 0,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

if (-not ('McbotWin' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class McbotWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
    public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public uint biClrUsed; public uint biClrImportant;
  }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bmi, uint usage);

  public static void DpiAware() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
  }

  public static List<IntPtr> TopLevel() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(GetWindowTextLength(h) + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

  public static int[] ClientSize(IntPtr h) {
    try { SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(h)); } catch { }
    RECT c; GetClientRect(h, out c);
    return new int[] { c.Right - c.Left, c.Bottom - c.Top };
  }

  // 客户区的 BGRA 像素（从上到下），size 返回 [宽, 高]
  public static byte[] CaptureClient(IntPtr h, int[] size) {
    // 按目标窗口自己的 DPI 模式测量和截图，否则缩放显示下不感知 DPI 的窗口会只占画面的一角
    try { SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(h)); } catch { }
    RECT w; GetWindowRect(h, out w);
    RECT c; GetClientRect(h, out c);
    POINT o = new POINT { X = 0, Y = 0 };
    ClientToScreen(h, ref o);
    int ww = w.Right - w.Left, wh = w.Bottom - w.Top;
    int cw = c.Right - c.Left, ch = c.Bottom - c.Top;
    if (ww <= 0 || wh <= 0 || cw <= 0 || ch <= 0) throw new Exception("window has no visible area");
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(screen);
    IntPtr bmp = CreateCompatibleBitmap(screen, ww, wh);
    IntPtr old = SelectObject(mem, bmp);
    try {
      if (!PrintWindow(h, mem, 2)) throw new Exception("PrintWindow failed");
      var bmi = new BITMAPINFOHEADER();
      bmi.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
      bmi.biWidth = ww;
      bmi.biHeight = -wh;
      bmi.biPlanes = 1;
      bmi.biBitCount = 32;
      var full = new byte[ww * wh * 4];
      SelectObject(mem, old);
      if (GetDIBits(mem, bmp, 0, (uint)wh, full, ref bmi, 0) == 0) throw new Exception("GetDIBits failed");
      int ox = Math.Max(0, o.X - w.Left), oy = Math.Max(0, o.Y - w.Top);
      cw = Math.Min(cw, ww - ox);
      ch = Math.Min(ch, wh - oy);
      var outBuf = new byte[cw * ch * 4];
      for (int y = 0; y < ch; y++) {
        Buffer.BlockCopy(full, ((oy + y) * ww + ox) * 4, outBuf, y * cw * 4, cw * 4);
      }
      size[0] = cw;
      size[1] = ch;
      return outBuf;
    } finally {
      DeleteObject(bmp);
      DeleteDC(mem);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }
}
'@
}

[McbotWin]::DpiAware()

function Out-Json($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
}

try {
  if ($Action -eq 'list') {
    $items = foreach ($h in [McbotWin]::TopLevel()) {
      $procId = [McbotWin]::Pid($h)
      $name = ''
      try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
      $size = [McbotWin]::ClientSize($h)
      [pscustomobject]@{
        handle    = $h.ToInt64()
        title     = [McbotWin]::Title($h)
        pid       = [int]$procId
        process   = $name
        width     = $size[0]
        height    = $size[1]
        minimized = [McbotWin]::IsIconic($h)
      }
    }
    Out-Json @{ ok = $true; windows = @($items) }
    exit 0
  }

  $hwnd = [IntPtr]::new($Handle)
  if ($Handle -eq 0 -or -not [McbotWin]::IsWindow($hwnd)) { Out-Json @{ ok = $false; error = 'window-gone' }; exit 0 }
  if ([McbotWin]::IsIconic($hwnd)) { Out-Json @{ ok = $false; error = 'minimized' }; exit 0 }
  if (-not $OutFile) { throw 'OutFile is required' }

  $size = [int[]]::new(2)
  $bytes = [McbotWin]::CaptureClient($hwnd, $size)
  [IO.File]::WriteAllBytes($OutFile, $bytes)
  Out-Json @{ ok = $true; width = $size[0]; height = $size[1]; title = [McbotWin]::Title($hwnd); pid = [int][McbotWin]::Pid($hwnd) }
} catch {
  Out-Json @{ ok = $false; error = 'exception'; message = $_.Exception.Message }
  exit 0
}

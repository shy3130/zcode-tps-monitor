# zcode-tps-monitor Token 速率监控条:完全透明、纯文字、无彩色、字号统一。
# 跟随 ZCode 深浅主题(像素采样);统计范围为当前会话。
# DPI:进程强制 DPI 感知,所有坐标按缩放比换算,确保落在 ZCode 布局内部。
# 启动:powershell -NoProfile -ExecutionPolicy Bypass -File overlay.ps1
# 关闭:右键菜单 → 关闭监控条。

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

# 必须在创建任何窗口前调用:让 GetWindowRect/CopyFromScreen 返回物理像素
[void][Win32]::SetProcessDPIAware()

# 物理像素规格
$STRIP_W = 560; $STRIP_H = 36
$FSZ = 13                    # 统一字号(物理像素)
$URL = "http://127.0.0.1:7423/api/token-rate"
$script:offX = -($STRIP_W + 20)   # 相对 ZCode 窗口右下角的物理偏移(输入框上方偏右)
$script:offY = -168
$script:lastRect = $null
$script:isLight = $null
$script:S = 1.0             # DPI 缩放比(物理px / WPF DIP),SourceInitialized 时实测

$INK = @{
  dark  = @{ main = "#FFE8ECF7"; dim = "#FF8B94AD" }
  light = @{ main = "#FF2A3346"; dim = "#FF7A829A" }
}

function Get-ZCodeLuminance($r) {
  try {
    $x = $r.Right - 8
    $y = $r.Top + 40
    $sh = [Math]::Max(60, $r.Bottom - $r.Top - 120)
    $bmp = New-Object System.Drawing.Bitmap(4, $sh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size(4, $sh)))
    $g.Dispose()
    $vals = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $sh; $i += 8) {
      $c = $bmp.GetPixel(2, $i)
      [void]$vals.Add(($c.R * 0.299 + $c.G * 0.587 + $c.B * 0.114))
    }
    $bmp.Dispose()
    if ($vals.Count -eq 0) { return $null }
    $vals.Sort()
    return $vals[[int]($vals.Count / 2)]
  } catch { return $null }
}

function Convert-Hex([string]$hex) {
  $a = [byte]::Parse($hex.Substring(1, 2), 'HexNumber')
  $r = [byte]::Parse($hex.Substring(3, 2), 'HexNumber')
  $g = [byte]::Parse($hex.Substring(5, 2), 'HexNumber')
  $b = [byte]::Parse($hex.Substring(7, 2), 'HexNumber')
  return [Windows.Media.Color]::FromArgb($a, $r, $g, $b)
}

function BrushFrom([string]$hex) {
  $c = Convert-Hex $hex
  return [Windows.Media.SolidColorBrush]::new($c)
}

function Apply-Theme([bool]$light) {
  $t = if ($light) { $INK.light } else { $INK.dark }
  $big.Foreground = BrushFrom $t.main
  $unit.Foreground = BrushFrom $t.main
  $stat.Foreground = BrushFrom $t.dim
}

# 按 DPI 缩放比换算物理尺寸 → WPF DIP
function Apply-Scale {
  $win.Width = [Math]::Round($STRIP_W / $script:S, 1)
  $win.Height = [Math]::Round($STRIP_H / $script:S, 1)
  $fsDip = [Math]::Round($FSZ / $script:S, 1)   # 统一字号
  $big.FontSize = $fsDip
  $unit.FontSize = $fsDip
  $stat.FontSize = $fsDip
  $unit.Margin = [Windows.Thickness]::new(4 / $script:S, 0, 0, 0)
  $stat.Margin = [Windows.Thickness]::new(12 / $script:S, 0, 0, 0)
}

# 物理 → DIP 定位
function Place-At([int]$physX, [int]$physY) {
  $win.Left = $physX / $script:S
  $win.Top = $physY / $script:S
}

$xamlText = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" Topmost="False" Opacity="0.72" ShowInTaskbar="False"
        ShowActivated="False" ResizeMode="NoResize"
        FontFamily="Segoe UI, Microsoft YaHei">
  <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
    <TextBlock x:Name="Big" Text="--" FontWeight="SemiBold" VerticalAlignment="Center"/>
    <TextBlock x:Name="Unit" Text="tok/s" VerticalAlignment="Center"/>
    <TextBlock x:Name="Stat" Text="等待数据…" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
  </StackPanel>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xamlText)
$win = [Windows.Markup.XamlReader]::Load($reader)
$big = $win.FindName("Big"); $unit = $win.FindName("Unit"); $stat = $win.FindName("Stat")

# 左键拖动(物理坐标换算,记住相对偏移);右键菜单唯一关闭入口
$win.Add_MouseLeftButtonDown({
  try {
    $win.DragMove()
    $r = Get-ZCodeRect
    if ($r) {
      $script:offX = [int]($win.Left * $script:S) - $r.Right
      $script:offY = [int]($win.Top * $script:S) - $r.Bottom
    }
  } catch {}
})
$menu = [Windows.Controls.ContextMenu]::new()
$mi = [Windows.Controls.MenuItem]::new(); $mi.Header = "关闭监控条"
$mi.Add_Click({ $win.Close() })
[void]$menu.Items.Add($mi)
$win.ContextMenu = $menu

function Get-ZCodeRect {
  $p = Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) {
    $r = New-Object RECT
    [void][Win32]::GetWindowRect($p.MainWindowHandle, [ref]$r)
    return $r
  }
  return $null
}

$script:tickCount = 0
$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({
  try {
    $script:tickCount++
    $r = Get-ZCodeRect
    # 每 5 秒采样 ZCode 窗口,跟随其深浅主题
    if ($r -and ($script:tickCount % 5) -eq 1) {
      $lum = Get-ZCodeLuminance $r
      if ($null -ne $lum) {
        $l = ($lum -gt 127)
        if ($l -ne $script:isLight) { $script:isLight = $l; Apply-Theme $l }
      }
    }
    # 每秒按偏移计算期望位置,并钳制在 ZCode 窗口内部(窗口缩小也不会跑出界)
    if ($r) {
      $minX = $r.Left + 8
      $maxX = [Math]::Max($minX, $r.Right - $STRIP_W - 8)
      $minY = $r.Top + 8
      $maxY = [Math]::Max($minY, $r.Bottom - $STRIP_H - 8)
      $px = [Math]::Max($minX, [Math]::Min($r.Right + $script:offX, $maxX))
      $py = [Math]::Max($minY, [Math]::Min($r.Bottom + $script:offY, $maxY))
      $curPhysX = if ([double]::IsNaN($win.Left)) { -1 } else { [int]($win.Left * $script:S) }
      $curPhysY = if ([double]::IsNaN($win.Top)) { -1 } else { [int]($win.Top * $script:S) }
      if ($curPhysX -ne $px -or $curPhysY -ne $py) {
        Place-At $px $py
      }
      $script:lastRect = $r
    }
    $d = Invoke-RestMethod -Uri $URL -TimeoutSec 2
    if ($d.latest) {
      $big.Text = if ($null -ne $d.latest.tokPerSec) { [Math]::Round($d.latest.tokPerSec, 0) } else { "-" }
      $ttft = if ($null -ne $d.latest.ttftMs) { [Math]::Round($d.latest.ttftMs / 1000, 1) } else { "-" }
      $stat.Text = "均$($d.session.avg)  峰$($d.session.max)  ·  TTFT ${ttft}s"
    }
  } catch {
    $stat.Text = "连接失败,重试中…"
  }
})
$timer.Start()

$win.Add_SourceInitialized({
  # 不抢焦点、不进 Alt+Tab
  $hwnd = ([System.Windows.Interop.WindowInteropHelper]::new($win)).Handle
  if ($hwnd -ne [IntPtr]::Zero) {
    $cur = [Win32]::GetWindowLongPtr($hwnd, -20)
    [void][Win32]::SetWindowLongPtr($hwnd, -20, [IntPtr]([int64]$cur -bor 0x8000000 -bor 0x80))
  }
  # 层级跟随:把监控条设为 ZCode 主窗口的"所属窗口"(GWL_HWNDPARENT)
  # 效果:永远在 ZCode 之上,但被其他应用正常遮挡;ZCode 最小化/恢复时同步
  $z = Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($z -and $hwnd -ne [IntPtr]::Zero) {
    [void][Win32]::SetWindowLongPtr($hwnd, -8, $z.MainWindowHandle)
  }
  # 实测 DPI 缩放比,应用尺寸/字号换算
  $src = [System.Windows.PresentationSource]::FromVisual($win)
  if ($src -and $src.CompositionTarget) {
    $script:S = [Math]::Max(1.0, $src.CompositionTarget.TransformToDevice.M11)
  }
  Apply-Scale
  # 缩放比就绪后才能正确定位(物理坐标 → DIP)
  $rInit = Get-ZCodeRect
  if ($rInit) {
    Place-At ($rInit.Right + $script:offX) ($rInit.Bottom + $script:offY)
    $script:lastRect = $rInit
    [Console]::Error.WriteLine("dpi S=$($script:S) zcodeRect=($($rInit.Left),$($rInit.Top),$($rInit.Right),$($rInit.Bottom)) strip=($($win.Left * $script:S),$($win.Top * $script:S))")
  }
})
$win.Add_Closed({ $win.Dispatcher.InvokeShutdown() })

# 首次主题采样(ZCode 窗口)
$r0 = Get-ZCodeRect
if ($r0) {
  $lum0 = Get-ZCodeLuminance $r0
  if ($null -ne $lum0) { $script:isLight = ($lum0 -gt 127) }
}
if ($null -eq $script:isLight) { $script:isLight = $false }
Apply-Theme $script:isLight
$win.Show()
[System.Windows.Threading.Dispatcher]::Run()

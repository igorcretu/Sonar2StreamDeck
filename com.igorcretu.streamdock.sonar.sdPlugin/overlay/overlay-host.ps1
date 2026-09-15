# Persistent, always-on-top notification overlay for the Sonar StreamDock plugin.
# Started lazily by plugin/index.js (no admin rights needed) and reused for the
# life of the StreamDock session. Listens on a plain local HTTP port for "show"
# requests and renders a small auto-hiding card, styled to sit alongside Sonar's
# own overlay language without depending on Sonar/GG at all (see README for why:
# GG's native overlay is triggered via in-process Electron IPC, unreachable from
# outside). HTTP rather than a named pipe because the plugin runs in a browser-
# like webview, which can only reach a local process over fetch()-style HTTP.
#
# Protocol: GET http://127.0.0.1:<HttpPort>/show?kind=volume&label=Game&value=95&muted=false&color=%233B82F6
#           GET http://127.0.0.1:<HttpPort>/show?kind=device&label=Chat+Device&deviceName=Arctis+Nova+Pro&color=%2322C55E
# Response is just a status code (204/404/500) — the plugin doesn't need the body.

$TraceLog = "$env:TEMP\overlay-host-trace.log"
function Trace([string]$msg) { Add-Content -Path $TraceLog -Value "$(Get-Date -Format 'HH:mm:ss.fff') $msg" }
trap { Trace "TRAP: $($_.Exception.ToString())"; continue }
Trace "script start"

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Trace "assemblies loaded"
Add-Type -Namespace Native -Name Win32 -MemberDefinition @"
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern int GetWindowLong(System.IntPtr hwnd, int index);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern int SetWindowLong(System.IntPtr hwnd, int index, int newStyle);
"@

$HttpPort = 58471
$CardW = 320
$CardH = 118
$HideDelayMs = 1800

# ── Window & content ──────────────────────────────────────────────────────

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" Focusable="False"
        ResizeMode="NoResize" WindowStartupLocation="Manual"
        Width="$CardW" Height="$CardH" SizeToContent="Manual">
  <Grid>
    <Border x:Name="Card" CornerRadius="16" Background="#E6151A26"
            BorderBrush="#33FFFFFF" BorderThickness="1" Opacity="0">
      <Border.Effect>
        <DropShadowEffect Color="Black" BlurRadius="24" ShadowDepth="6" Opacity="0.45"/>
      </Border.Effect>
      <Border.RenderTransform>
        <TranslateTransform x:Name="CardOffset" Y="10"/>
      </Border.RenderTransform>
      <Grid Margin="16,0,18,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="48"/>
          <ColumnDefinition Width="*"/>
        </Grid.ColumnDefinitions>
        <Border x:Name="IconBadge" Width="48" Height="48" CornerRadius="12" VerticalAlignment="Center">
          <Canvas x:Name="IconCanvas" Width="24" Height="24"/>
        </Border>
        <StackPanel Grid.Column="1" Margin="14,0,0,0" VerticalAlignment="Center">
          <Grid>
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="*"/>
              <ColumnDefinition Width="Auto"/>
            </Grid.ColumnDefinitions>
            <TextBlock x:Name="TitleText" FontSize="16" FontWeight="SemiBold" Foreground="White"/>
            <TextBlock x:Name="ValueText" Grid.Column="1" FontSize="15" FontWeight="SemiBold"/>
          </Grid>
          <TextBlock x:Name="SubtitleText" FontSize="12.5" Foreground="#94A3B8" Margin="0,2,0,0"
                     TextTrimming="CharacterEllipsis"/>
          <TextBlock x:Name="MicText" FontSize="11" Foreground="#64748B" Margin="0,2,0,0"
                     TextTrimming="CharacterEllipsis" Visibility="Collapsed"/>
          <Grid x:Name="BarRow" Height="7" Margin="0,8,0,0">
            <Border CornerRadius="4" Background="#26FFFFFF"/>
            <Border x:Name="BarFill" CornerRadius="4" HorizontalAlignment="Left" Width="0"/>
          </Grid>
        </StackPanel>
      </Grid>
    </Border>
  </Grid>
</Window>
"@

Trace "loading xaml"
$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
Trace "xaml loaded"

$card = $window.FindName('Card')
$cardOffset = $window.FindName('CardOffset')
$iconBadge = $window.FindName('IconBadge')
$iconCanvas = $window.FindName('IconCanvas')
$titleText = $window.FindName('TitleText')
$valueText = $window.FindName('ValueText')
$subtitleText = $window.FindName('SubtitleText')
$micText = $window.FindName('MicText')
$barRow = $window.FindName('BarRow')
$barFill = $window.FindName('BarFill')

$workArea = [System.Windows.SystemParameters]::WorkArea
$margin = 28
$window.Left = $workArea.Right - $CardW - $margin
$window.Top = $workArea.Bottom - $CardH - $margin

# ── Icon glyphs (built from primitive shapes, no icon fonts) ──────────────

function Set-Icon([string]$name, [string]$color) {
    $iconCanvas.Children.Clear()
    $brush = $color
    switch ($name) {
        'speaker' {
            $cone = New-Object System.Windows.Shapes.Path
            $cone.Fill = $brush
            $cone.Data = [Windows.Media.Geometry]::Parse("M3,9 L8,9 L13,5 L13,19 L8,15 L3,15 Z")
            $iconCanvas.Children.Add($cone) | Out-Null
            foreach ($d in @("M16,8 A6,6 0 0 1 16,16", "M18.5,5.5 A10,10 0 0 1 18.5,18.5")) {
                $arc = New-Object System.Windows.Shapes.Path
                $arc.Stroke = $brush; $arc.StrokeThickness = 1.6
                $arc.StrokeStartLineCap = 'Round'; $arc.StrokeEndLineCap = 'Round'
                $arc.Data = [Windows.Media.Geometry]::Parse($d)
                $iconCanvas.Children.Add($arc) | Out-Null
            }
        }
        'speaker-muted' {
            $cone = New-Object System.Windows.Shapes.Path
            $cone.Fill = $brush
            $cone.Data = [Windows.Media.Geometry]::Parse("M3,9 L8,9 L13,5 L13,19 L8,15 L3,15 Z")
            $iconCanvas.Children.Add($cone) | Out-Null
            foreach ($d in @("M16,8 L21,16", "M21,8 L16,16")) {
                $line = New-Object System.Windows.Shapes.Path
                $line.Stroke = $brush; $line.StrokeThickness = 1.8
                $line.StrokeStartLineCap = 'Round'; $line.StrokeEndLineCap = 'Round'
                $line.Data = [Windows.Media.Geometry]::Parse($d)
                $iconCanvas.Children.Add($line) | Out-Null
            }
        }
        'headphones' {
            $band = New-Object System.Windows.Shapes.Path
            $band.Stroke = $brush; $band.StrokeThickness = 1.8
            $band.StrokeStartLineCap = 'Round'; $band.StrokeEndLineCap = 'Round'
            $band.Data = [Windows.Media.Geometry]::Parse("M5,13 A7,6 0 0 1 19,13")
            $iconCanvas.Children.Add($band) | Out-Null
            foreach ($x in @(3, 16)) {
                $cup = New-Object System.Windows.Controls.Border
                $cup.Width = 5; $cup.Height = 7; $cup.CornerRadius = [Windows.CornerRadius]::new(2)
                $cup.Background = $brush
                [System.Windows.Controls.Canvas]::SetLeft($cup, $x)
                [System.Windows.Controls.Canvas]::SetTop($cup, 12)
                $iconCanvas.Children.Add($cup) | Out-Null
            }
        }
        'mic' {
            $capsule = New-Object System.Windows.Controls.Border
            $capsule.Width = 8; $capsule.Height = 13; $capsule.CornerRadius = [Windows.CornerRadius]::new(4)
            $capsule.Background = $brush
            [System.Windows.Controls.Canvas]::SetLeft($capsule, 8)
            [System.Windows.Controls.Canvas]::SetTop($capsule, 2)
            $iconCanvas.Children.Add($capsule) | Out-Null
            $stand = New-Object System.Windows.Shapes.Path
            $stand.Stroke = $brush; $stand.StrokeThickness = 1.6
            $stand.StrokeStartLineCap = 'Round'; $stand.StrokeEndLineCap = 'Round'
            $stand.Data = [Windows.Media.Geometry]::Parse("M6,13 A6,6 0 0 0 18,13 M12,19 L12,22 M9,22 L15,22")
            $iconCanvas.Children.Add($stand) | Out-Null
        }
        'laptop' {
            $screen = New-Object System.Windows.Controls.Border
            $screen.Width = 16; $screen.Height = 11
            $screen.CornerRadius = [Windows.CornerRadius]::new(2)
            $screen.BorderBrush = $brush; $screen.BorderThickness = [Windows.Thickness]::new(1.6)
            [System.Windows.Controls.Canvas]::SetLeft($screen, 4)
            [System.Windows.Controls.Canvas]::SetTop($screen, 2)
            $iconCanvas.Children.Add($screen) | Out-Null
            $base = New-Object System.Windows.Controls.Border
            $base.Width = 20; $base.Height = 3
            $base.CornerRadius = [Windows.CornerRadius]::new(1.5)
            $base.Background = $brush
            [System.Windows.Controls.Canvas]::SetLeft($base, 2)
            [System.Windows.Controls.Canvas]::SetTop($base, 16)
            $iconCanvas.Children.Add($base) | Out-Null
        }
        'display' {
            $screen = New-Object System.Windows.Controls.Border
            $screen.Width = 18; $screen.Height = 12
            $screen.CornerRadius = [Windows.CornerRadius]::new(2)
            $screen.BorderBrush = $brush; $screen.BorderThickness = [Windows.Thickness]::new(1.6)
            [System.Windows.Controls.Canvas]::SetLeft($screen, 3)
            [System.Windows.Controls.Canvas]::SetTop($screen, 2)
            $iconCanvas.Children.Add($screen) | Out-Null
            $stand = New-Object System.Windows.Controls.Border
            $stand.Width = 3; $stand.Height = 3
            $stand.Background = $brush
            [System.Windows.Controls.Canvas]::SetLeft($stand, 10.5)
            [System.Windows.Controls.Canvas]::SetTop($stand, 14)
            $iconCanvas.Children.Add($stand) | Out-Null
            $dbase = New-Object System.Windows.Controls.Border
            $dbase.Width = 10; $dbase.Height = 1.6
            $dbase.CornerRadius = [Windows.CornerRadius]::new(1)
            $dbase.Background = $brush
            [System.Windows.Controls.Canvas]::SetLeft($dbase, 7)
            [System.Windows.Controls.Canvas]::SetTop($dbase, 17)
            $iconCanvas.Children.Add($dbase) | Out-Null
        }
    }
}

# ── Show/update ─────────────────────────────────────────────────────────

$hideTimer = New-Object System.Windows.Threading.DispatcherTimer
$hideTimer.Interval = [TimeSpan]::FromMilliseconds($HideDelayMs)

function Fade([double]$to, [int]$ms, [double]$offsetTo) {
    $anim = New-Object System.Windows.Media.Animation.DoubleAnimation($to, [TimeSpan]::FromMilliseconds($ms))
    $anim.EasingFunction = New-Object System.Windows.Media.Animation.CubicEase
    $card.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $anim)
    $offAnim = New-Object System.Windows.Media.Animation.DoubleAnimation($offsetTo, [TimeSpan]::FromMilliseconds($ms))
    $offAnim.EasingFunction = New-Object System.Windows.Media.Animation.CubicEase
    $cardOffset.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $offAnim)
}

$hideTimer.Add_Tick({
    $hideTimer.Stop()
    Fade 0 220 10
})

function Show-Card($msg) {
    $color = if ($msg.color) { $msg.color } else { '#3B82F6' }
    $iconBadge.Background = "#29" + $color.TrimStart('#')

    if ($msg.kind -eq 'volume') {
        $iconName = if ($msg.muted) { 'speaker-muted' } else { 'speaker' }
        Set-Icon $iconName $color
        $titleText.Text = 'Volume'
        $subtitleText.Text = $msg.label
        $subtitleText.Margin = '0,1,0,8'
        if ($msg.muted) {
            $valueText.Text = 'MUTED'
            $valueText.Foreground = '#EF4444'
            $barFill.Background = '#EF4444'
            $barFill.Opacity = 0.55
            $barFill.Width = 60
        } else {
            $valueText.Text = "$([int]$msg.value)%"
            $valueText.Foreground = $color
            $barFill.Background = $color
            $barFill.Opacity = 1
            $trackWidth = $CardW - 16 - 18 - 48 - 14
            $barFill.Width = [Math]::Max(6, $trackWidth * ([Math]::Min(100, [Math]::Max(0, $msg.value)) / 100.0))
        }
        $barRow.Visibility = 'Visible'
    } elseif ($msg.kind -eq 'device') {
        $iconName = if ($msg.icon) { $msg.icon } else { 'headphones' }
        Set-Icon $iconName $color
        $titleText.Text = $msg.label
        $subtitleText.Text = $msg.deviceName
        $subtitleText.Margin = '0,2,0,0'
        $valueText.Text = ''
        $barRow.Visibility = 'Collapsed'
        if ($msg.micName) {
            $micText.Text = "Mic: $($msg.micName)"
            $micText.Visibility = 'Visible'
        } else {
            $micText.Visibility = 'Collapsed'
        }
    }
    if ($msg.kind -eq 'volume') { $micText.Visibility = 'Collapsed' }

    # Just retarget the animation — do NOT clear it first. BeginAnimation(prop, $null)
    # reverts the property to its XAML base value (Opacity="0") for a frame before the
    # new animation takes over, which is what caused a visible flash on every update.
    Fade 1 140 0

    $hideTimer.Stop()
    $hideTimer.Start()
}

# ── HTTP listener ──────────────────────────────────────────────────────
# The plugin runs in a browser-like webview (not a Node.js process like the
# Legion plugin), so a named pipe is unreachable from it — only fetch()-style
# HTTP works there, the same way it already talks to Sonar's own local API.
# Runs in its own PowerShell runspace (a plain background .NET Thread has no
# PowerShell execution context at all, so it can't run script code). The
# listener only ever hands a plain data object back to the UI thread via a
# delegate built here, in the main runspace where Show-Card actually lives.

$dispatcher = $window.Dispatcher
$showCardCallback = [System.Windows.Threading.DispatcherOperationCallback]{
    param($msg)
    try { Show-Card $msg } catch { Trace "Show-Card error: $($_.Exception.ToString())" }
    return $null
}.GetNewClosure()

$listenerRunspace = [runspacefactory]::CreateRunspace()
$listenerRunspace.ApartmentState = [System.Threading.ApartmentState]::MTA
$listenerRunspace.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::UseNewThread
$listenerRunspace.Open()
$listenerRunspace.SessionStateProxy.SetVariable('HttpPort', $HttpPort)
$listenerRunspace.SessionStateProxy.SetVariable('dispatcher', $dispatcher)
$listenerRunspace.SessionStateProxy.SetVariable('showCardCallback', $showCardCallback)
$listenerRunspace.SessionStateProxy.SetVariable('TraceLog', $TraceLog)

$listenerPS = [powershell]::Create()
$listenerPS.Runspace = $listenerRunspace
[void]$listenerPS.AddScript({
    function Trace([string]$msg) { Add-Content -Path $TraceLog -Value "$(Get-Date -Format 'HH:mm:ss.fff') [listener] $msg" }
    Add-Type -AssemblyName System.Web
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://127.0.0.1:$HttpPort/")
    $listener.Start()
    Trace "http listener alive on port $HttpPort"
    while ($true) {
        try {
            $context = $listener.GetContext()
            $req = $context.Request
            $res = $context.Response
            $res.Headers.Add('Access-Control-Allow-Origin', '*')
            try {
                if ($req.Url.AbsolutePath -eq '/show') {
                    $q = [System.Web.HttpUtility]::ParseQueryString($req.Url.Query)
                    $msg = [PSCustomObject]@{
                        kind       = $q['kind']
                        label      = $q['label']
                        value      = $q['value']
                        muted      = ($q['muted'] -eq 'true')
                        color      = $q['color']
                        deviceName = $q['deviceName']
                        micName    = $q['micName']
                        icon       = $q['icon']
                    }
                    $dispatcher.Invoke($showCardCallback, $msg) | Out-Null
                    $res.StatusCode = 204
                } else {
                    $res.StatusCode = 404
                }
            } catch {
                Trace "handle error: $($_.Exception.ToString())"
                $res.StatusCode = 500
            }
            $res.Close()
        } catch {
            Trace "loop error: $($_.Exception.ToString())"
            Start-Sleep -Milliseconds 200
        }
    }
})
Trace "starting listener runspace"
$listenerHandle = $listenerPS.BeginInvoke()
Trace "listener runspace started"

# ── Make the window non-activating and click-through, then run ───────────

$window.Add_SourceInitialized({
    $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
    $GWL_EXSTYLE = -20
    $WS_EX_NOACTIVATE = 0x08000000
    $WS_EX_TOOLWINDOW = 0x00000080
    $WS_EX_TRANSPARENT = 0x00000020
    $cur = [Native.Win32]::GetWindowLong($hwnd, $GWL_EXSTYLE)
    [Native.Win32]::SetWindowLong($hwnd, $GWL_EXSTYLE, ($cur -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW -bor $WS_EX_TRANSPARENT)) | Out-Null
})

Trace "showing window"
$window.Show()
Trace "window shown, entering dispatcher loop"
[System.Windows.Threading.Dispatcher]::Run()
Trace "dispatcher loop exited"

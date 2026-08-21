# 트레이/창/exe 공용 아이콘 생성: 파란 원 + 흰 체크 (C# v1 트레이 아이콘과 동일 디자인)
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\app\assets"
New-Item -ItemType Directory -Force $outDir | Out-Null

function Draw-Icon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 32.0
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(37, 99, 235))
    $g.FillEllipse($brush, 1 * $s, 1 * $s, 30 * $s, 30 * $s)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, (4 * $s))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($pen, (8 * $s), (17 * $s), (14 * $s), (22 * $s))
    $g.DrawLine($pen, (14 * $s), (22 * $s), (24 * $s), (10 * $s))
    $g.Dispose(); $pen.Dispose(); $brush.Dispose()
    return $bmp
}

$sizes = 16, 24, 32, 48, 64, 256
$pngBytes = @{}
foreach ($sz in $sizes) {
    $bmp = Draw-Icon $sz
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes[$sz] = $ms.ToArray()
    $ms.Dispose()
    $bmp.Save((Join-Path $outDir "icon-$sz.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# ICO 패킹 (PNG 엔트리, Vista+ 지원)
$icoPath = Join-Path $outDir "icon.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($sz in $sizes) {
    $b = $pngBytes[$sz]
    $dim = if ($sz -ge 256) { 0 } else { $sz }
    $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
    $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$b.Length); $bw.Write([UInt32]$offset)
    $offset += $b.Length
}
foreach ($sz in $sizes) { $bw.Write($pngBytes[$sz]) }
$bw.Dispose(); $fs.Dispose()
Write-Output "generated: icon.ico + PNGs in $outDir"

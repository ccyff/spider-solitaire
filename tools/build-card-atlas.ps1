<#
把下载好的标准扑克牌素材裁切、缩放、合成一张图集（13 列 × 5 行）。

・第 0 行 黑桃 A→K，第 1 行 红桃，第 2 行 方块，第 3 行 梅花，第 4 行第 1 格是牌背
・每张牌先垫一层淡淡的黑色投影，这样牌桌上有立体感

用法：
  pwsh tools/build-card-atlas.ps1 -SourceDir .downloads/oga/Cards/Classic -BackFile .downloads/oga/Backs/Card-Back-01.png -OutFile public/assets/cards/atlas.png -CellW 176
#>
param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$BackFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$CellW = 176,
  [double]$Aspect = 1.3841,
  # 每格右侧/底部留出的像素余量，专门用来放投影（否则影子会被切到隔壁格）
  [int]$Margin = 6
)

Add-Type -AssemblyName System.Drawing

$cellH = [int][Math]::Round($CellW * $Aspect)
$cardW = $CellW - $Margin
$cardH = [int][Math]::Round($cardW * $Aspect)
$cols = 13
$rows = 5
$sheetW = $cols * $CellW
$sheetH = $rows * $cellH

$sheet = New-Object System.Drawing.Bitmap($sheetW, $sheetH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# 投影用的颜色矩阵：把图片变成纯黑，并压低不透明度
$shadowMatrix = New-Object System.Drawing.Imaging.ColorMatrix
$shadowMatrix.Matrix00 = 0; $shadowMatrix.Matrix01 = 0; $shadowMatrix.Matrix02 = 0; $shadowMatrix.Matrix03 = 0
$shadowMatrix.Matrix10 = 0; $shadowMatrix.Matrix11 = 0; $shadowMatrix.Matrix12 = 0; $shadowMatrix.Matrix13 = 0
$shadowMatrix.Matrix20 = 0; $shadowMatrix.Matrix21 = 0; $shadowMatrix.Matrix22 = 0; $shadowMatrix.Matrix23 = 0
$shadowMatrix.Matrix33 = 0.14
$shadowMatrix.Matrix44 = 1
$shadowAttrs = New-Object System.Drawing.Imaging.ImageAttributes
$shadowAttrs.SetColorMatrix($shadowMatrix)

$suitRows = @{ s = 0; h = 1; d = 2; c = 3 }

function Place-Card {
  param([System.Drawing.Image]$Image, [int]$Col, [int]$Row)
  $destX = $Col * $CellW
  $destY = $Row * $cellH
  $destRect = New-Object System.Drawing.Rectangle($destX, $destY, $cardW, $cardH)

  # 三层错位黑影，做出柔和的落影
  foreach ($offset in @(@(2, 2), @(3, 3), @(4, 4))) {
    $shadowRect = New-Object System.Drawing.Rectangle(($destX + $offset[0]), ($destY + $offset[1]), $cardW, $cardH)
    $g.DrawImage($Image, $shadowRect, 0, 0, $Image.Width, $Image.Height, [System.Drawing.GraphicsUnit]::Pixel, $shadowAttrs)
  }

  $g.DrawImage($Image, $destRect, 0, 0, $Image.Width, $Image.Height, [System.Drawing.GraphicsUnit]::Pixel)
}

$placed = 0
foreach ($suit in $suitRows.Keys) {
  $row = $suitRows[$suit]
  for ($rank = 1; $rank -le 13; $rank += 1) {
    $name = '{0}{1:d2}.png' -f $suit, $rank
    $path = Join-Path $SourceDir $name
    if (-not (Test-Path $path)) { throw "缺少素材：$path" }
    $img = [System.Drawing.Image]::FromFile((Resolve-Path $path).Path)
    Place-Card -Image $img -Col ($rank - 1) -Row $row
    $img.Dispose()
    $placed += 1
  }
}

$back = [System.Drawing.Image]::FromFile((Resolve-Path $BackFile).Path)
Place-Card -Image $back -Col 0 -Row 4
$back.Dispose()

$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Compression, [long]0)
$pngCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/png' }

$g.Dispose()
$sheet.Save((Join-Path (Get-Location) $OutFile), $pngCodec, $encoderParams)
$sheet.Dispose()

$size = (Get-Item $OutFile).Length
Write-Output "图集已生成：$OutFile  ${sheetW}x${sheetH}  $([Math]::Round($size / 1kb)) KB  （$placed 张牌面 + 1 张牌背）"

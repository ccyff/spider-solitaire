<#
一键重新发布到 GitHub Pages：
  1. 重新构建（npm run build）
  2. 把 dist/ 的内容提交到 gh-pages 分支并强推
GitHub Pages 会自动重新发布，几十秒后 https://ccyff.github.io/spider-solitaire/ 就是最新的。

用法：pwsh tools/deploy-gh-pages.ps1
#>
param(
  [string]$Remote = "https://github.com/ccyff/spider-solitaire.git",
  [string]$Branch = "gh-pages"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Output "▶ 构建静态站点…"
npm run build | Out-Host

# GitHub Pages 默认跑 Jekyll，加个 .nojekyll 跳过，避免下划线开头的文件被忽略
Set-Content -LiteralPath "dist\.nojekyll" -Value "" -NoNewline

Push-Location "dist"
try {
  if (-not (Test-Path ".git")) {
    git init -b $Branch | Out-Null
    git config user.name "ccyff"
    git config user.email "ccyff@users.noreply.github.com"
    git remote add origin $Remote
  }

  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    git commit -q -m "部署：$(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    git push -f -q origin "${Branch}:${Branch}"
    Write-Output "✔ 已推送到 $Branch 分支"
  } else {
    Write-Output "• 内容没有变化，跳过推送"
  }
} finally {
  Pop-Location
}

Write-Output "地址：https://ccyff.github.io/spider-solitaire/"

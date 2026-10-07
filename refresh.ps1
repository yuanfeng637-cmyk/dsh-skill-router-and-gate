# refresh.ps1 —— 把本目录的源码同步进 desktop profile 的 node_modules。
#
# 为什么需要它：`plugin_manager install_bundle file:<目录>` 走的是 pnpm 的
# `file:` 依赖，装完是**拷贝**而不是符号链接，而且第二次装会被判为
# `Already up to date` / `ambiguous-install`，**不会重新拷贝**。
# 所以改完源码后必须用本脚本同步，再重启 DSH 让 ESM 模块重新加载。
#
# 用法：  pwsh -File refresh.ps1
#         pwsh -File refresh.ps1 -Verify     # 只比对，不写

[CmdletBinding()]
param([switch]$Verify)

$ErrorActionPreference = 'Stop'
$src  = $PSScriptRoot
$dest = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-skill-router-and-gate'

if (-not (Test-Path $dest)) {
  throw "profile 里没有 dsh-skill-router-and-gate，请先安装：`n  plugin_manager install_bundle  file:$($src -replace '\\','/')"
}

# 只同步真正参与运行的产物
$items = @('lib', 'package.json', 'cordis.patch.yml', 'README.md')

$diffs = @()
foreach ($it in $items) {
  $s = Join-Path $src $it
  $d = Join-Path $dest $it
  if (-not (Test-Path $s)) { continue }
  if (Test-Path $s -PathType Container) {
    Get-ChildItem $s -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($src.Length + 1)
      $tgt = Join-Path $dest $rel
      $same = (Test-Path $tgt) -and ((Get-FileHash $_.FullName).Hash -eq (Get-FileHash $tgt).Hash)
      if (-not $same) { $diffs += $rel }
    }
  } else {
    $tgt = Join-Path $dest $it
    $same = (Test-Path $tgt) -and ((Get-FileHash $s).Hash -eq (Get-FileHash $tgt).Hash)
    if (-not $same) { $diffs += $it }
  }
}

if ($diffs.Count -eq 0) {
  Write-Host "  已是最新，无需同步。" -ForegroundColor Green
  exit 0
}

Write-Host "  需要同步 $($diffs.Count) 项：" -ForegroundColor Yellow
$diffs | ForEach-Object { Write-Host "    $_" }

if ($Verify) { exit 1 }

# 只拷贝真正有差异的项。
# ⚠ 不要无条件 Copy-Item 每个产物：pnpm 装出来的 package.json 与本目录的可能指向
#   同一底层文件，Copy-Item 会抛「无法用自身覆盖项」并中断整轮，把后面的项漏掉。
foreach ($rel in $diffs) {
  $s = Join-Path $src $rel
  $d = Join-Path $dest $rel
  if (-not (Test-Path $s)) { continue }
  $parent = Split-Path $d -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  try {
    Copy-Item $s $d -Force -ErrorAction Stop
  } catch {
    # 同一底层文件（pnpm 硬链接）就是"已经一致"，不是错误
    if ((Get-FileHash $s).Hash -ne (Get-FileHash $d).Hash) {
      Write-Host "  ⛔ 拷贝失败：$rel — $($_.Exception.Message)" -ForegroundColor Red
    }
  }
}

# 复核
$still = @()
foreach ($it in $items) {
  $s = Join-Path $src $it
  if (-not (Test-Path $s)) { continue }
  if (Test-Path $s -PathType Container) {
    Get-ChildItem $s -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($src.Length + 1)
      $tgt = Join-Path $dest $rel
      if (-not (Test-Path $tgt) -or (Get-FileHash $_.FullName).Hash -ne (Get-FileHash $tgt).Hash) { $still += $rel }
    }
  } else {
    $tgt = Join-Path $dest $it
    if (-not (Test-Path $tgt) -or (Get-FileHash $s).Hash -ne (Get-FileHash $tgt).Hash) { $still += $it }
  }
}

if ($still.Count -eq 0) {
  Write-Host "  ✅ 同步完成。重启 DSH 后生效。" -ForegroundColor Green
} else {
  Write-Host "  ⛔ 复核失败：$($still -join ', ')" -ForegroundColor Red
  exit 1
}

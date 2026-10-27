# 获取固定提交的 前置内核；不覆盖已有修改，不自动更新用户的全局安装。
[CmdletBinding()]
param(
    [string]$Repo = 'https://github.com/frontkernel-ai/frontkernel.git',
    [string]$Commit = '5d257c5a50291398d2bca34afb93c22f1ab5c295',
    [string]$Destination = (Join-Path $PSScriptRoot '..' 'vendor' 'frontkernel')
)
$ErrorActionPreference = 'Stop'
$destination = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path $destination) {
    $head = git -C $destination rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw '目标已存在但不是可识别的 Git 仓库；请使用新的目录。' }
    $changes = git -C $destination status --porcelain
    if ($LASTEXITCODE -ne 0) { throw '无法检查已有仓库状态。' }
    if ($changes) { throw '已有 前置内核 工作树包含修改；为保护原文件，本脚本停止。' }
    if ($head -ne $Commit) { throw "已有版本 $head 与锁定版本 $Commit 不符；请指定新的 -Destination，不自动覆盖。" }
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    git clone --filter=blob:none $Repo $destination
    if ($LASTEXITCODE -ne 0) { throw '前置内核 克隆失败。' }
    git -C $destination checkout --detach $Commit
    if ($LASTEXITCODE -ne 0) { throw '无法检出锁定提交。' }
}
corepack pnpm@10.33.0 --dir $destination install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw '前置内核 依赖安装失败。' }
node (Join-Path $destination 'bin/frontkernel.mjs') version --json
if ($LASTEXITCODE -ne 0) { throw '前置内核 启动自检失败。' }
Write-Host "[fetch-frontkernel] 已准备：$destination；可用 QIYIN_前置内核_ROOT 显式选择。"

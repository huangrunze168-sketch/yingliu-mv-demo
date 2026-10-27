#
# 关于是否入库：**用户要求"只要有代码发生，就保存到库里"**，
#
# 但有一处需要留意：这个目录自带 `.git`（它是 clone 下来的），
# 于是 git 会把它记成一个**嵌套仓库引用**而不是内容——
# 更新要重新 clone）。这一步是破坏性的，需要时由人决定。
#
# 用法：

[CmdletBinding()]
param(
    [string]$Repo = 'huangrunze168-sketch/LocalBackend-Ai-Studio',
    [string]$Ref = 'main',
    [string]$Destination = (Join-Path $PSScriptRoot '..' 'vendor' 'local-backend')
)

$ErrorActionPreference = 'Stop'
$destination = [System.IO.Path]::GetFullPath($Destination)

if (Test-Path (Join-Path $destination 'main.py')) {
    Write-Host "[fetch-local-backend] 已存在，跳过：$destination"
    exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null

Write-Host "[fetch-local-backend] 获取 $Repo ($Ref) -> $destination"

if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh repo clone $Repo $destination -- --depth 1 --branch $Ref
} else {
    git clone --depth 1 --branch $Ref "https://github.com/$Repo.git" $destination
}

if (-not (Test-Path (Join-Path $destination 'main.py'))) {
    throw "[fetch-local-backend] 获取失败：未找到 main.py"
}
if (-not (Test-Path (Join-Path $destination 'python' 'python.exe'))) {
    Write-Warning "[fetch-local-backend] 未找到嵌入式 Python，媒体预览与后端启动将不可用。"
}

Write-Host '[fetch-local-backend] 完成'

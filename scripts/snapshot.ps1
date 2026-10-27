# 本地快照：把当前工作区的一切代码改动提交到本地库。
#
# 这是"取消仓库卫生"之后的口径落地（见 docs/仓库与提交策略.md）：
#   代码一有动静就入库，不用先判断"这东西该不该进库"。
#   .gitignore 只挡跑出来的二进制（截图/成片/SQLite/日志/安装包/依赖），
#   所以 `git add -A` 在这里是安全的，不会把 600 MB 的 node_modules 卷进来。
#
# 不会做的事：
#   · 不配远端、不 push（用户要求先只留本地）；
#   · 不删任何文件、不回滚任何改动；
#   · 没有改动时直接跳过，不产生空提交。
#
# 用法：
#   pwsh -File scripts/snapshot.ps1                       # 自动时间戳提交信息
#   pwsh -File scripts/snapshot.ps1 -Message "画布：补边距"  # 自己写提交信息

[CmdletBinding()]
param(
    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'

# 仓库根 = 本脚本所在目录的上一级
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    throw "[snapshot] 找不到仓库：$repo"
}

# 统一带上 safe.directory：这台机器上仓库归 Administrator，直接用 git 会被
# "dubious ownership" 拦下来（本仓库历史上踩过）。
$gitArgs = @('-c', "safe.directory=$repo", '-C', $repo)

$dirty = & git @gitArgs status --porcelain
if (-not $dirty) {
    Write-Host '[snapshot] 工作区没有改动，跳过。'
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = '快照 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
}

& git @gitArgs add -A
if ($LASTEXITCODE -ne 0) { throw '[snapshot] git add 失败' }

& git @gitArgs commit -m $Message --quiet
if ($LASTEXITCODE -ne 0) { throw '[snapshot] git commit 失败' }

$head = (& git @gitArgs log -1 --oneline) -join ''
Write-Host "[snapshot] 已入库：$head"

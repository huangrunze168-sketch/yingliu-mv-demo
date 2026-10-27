# 从当前 Windows 用户级环境变量载入新密钥，不读取聊天记录或项目文件。
# 必须在撤销旧密钥、设置新密钥后，由用户明确确认再运行。
$ErrorActionPreference = 'Stop'
$key = [Environment]::GetEnvironmentVariable('QIYIN_PLANNER_API_KEY', 'User')
if ([string]::IsNullOrWhiteSpace($key)) {
  Write-Error '尚未设置 Windows 用户级环境变量 QIYIN_PLANNER_API_KEY；未启动服务，也未调用服务商。'
  exit 1
}

$env:QIYIN_PLANNER_BASE_URL = 'https://api.deepseek.com'
$env:QIYIN_PLANNER_MODEL = 'deepseek-flash'
$env:QIYIN_PLANNER_API_KEY = $key
Remove-Variable key

# 只启动原项目本地 API；不会主动发起模型请求或媒体生成。
corepack pnpm dev:api
exit $LASTEXITCODE

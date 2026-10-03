param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ConfigRoot = (Join-Path $env:USERPROFILE '.ai_assistant')
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$python = Join-Path $root '.venv\Scripts\python.exe'
$server = Join-Path $root 'scripts\mcp_server.py'
$database = Join-Path $root 'db\business.duckdb'

foreach ($path in @($python, $server, $database)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required path does not exist: $path"
    }
}

$target = Join-Path $ConfigRoot 'mcp.json'
New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
if (Test-Path -LiteralPath $target) {
    Copy-Item -Force -LiteralPath $target -Destination ($target + '.bak')
    $payload = Get-Content -LiteralPath $target -Raw | ConvertFrom-Json
} else {
    $payload = [PSCustomObject]@{}
}
if (-not $payload.mcpServers) {
    $payload | Add-Member -MemberType NoteProperty -Name mcpServers -Value ([PSCustomObject]@{})
}
$connector = [PSCustomObject]@{
    command = $python
    args = @($server)
    env = [PSCustomObject]@{ BUSINESS_DB_PATH = $database }
}
$payload.mcpServers | Add-Member -MemberType NoteProperty -Name 'business-duckdb' -Value $connector -Force
$json = $payload | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($target, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

Write-Host "Installed=$target"
Write-Host 'Restart AI助手 and verify business-duckdb exposes 3 tools.'

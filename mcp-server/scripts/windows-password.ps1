<#
  Windows password store for the SE63 MCP server. No extra software needed.

  The password is encrypted with Windows DPAPI: only the same Windows user on the same
  machine can decrypt it. It is never written in plain text and never put on a command line.

  Needs PowerShell 7+ (pwsh), because only there does ConvertFrom-SecureString have
  -AsPlainText. That is not a nicety: on a managed machine Windows PowerShell 5.1 runs
  under AppLocker / WDAC in *Constrained Language Mode*, where .NET method calls such as
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR() are blocked. A script using them
  exits 0 and prints nothing, which looks exactly like a wrong password. This script uses
  cmdlets only, so it also works in Constrained Language Mode.

    winget install Microsoft.PowerShell      # if pwsh is missing

  Store the password once (input is hidden):

    pwsh -NoProfile -File <path>\windows-password.ps1 -Store -User <SAP_USER>

  Then in mcp-server/.env (`npm run setup` writes this line for you):

    SAP_PASSWORD_CMD=pwsh -NoProfile -ExecutionPolicy Bypass -File "<path>\windows-password.ps1"

  Without -Store the script prints the password for -User, defaulting to $env:SAP_USER,
  which the MCP server always has set from .env.
#>
[CmdletBinding()]
param(
  [switch]$Store,
  [string]$User = $env:SAP_USER
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Error "This script needs PowerShell 7+ (pwsh). Windows PowerShell $($PSVersionTable.PSVersion) cannot turn a SecureString back into text without .NET calls, which Constrained Language Mode blocks. Install it with: winget install Microsoft.PowerShell"
  exit 1
}

if (-not $User) {
  Write-Error "No SAP user: pass -User <SAP_USER>, or set SAP_USER (the MCP server does this from .env)."
  exit 1
}

$dir  = Join-Path $env:APPDATA "sap-se63-mcp"
$file = Join-Path $dir ("{0}.pwd" -f $User.ToUpper())

if ($Store) {
  $null = New-Item -ItemType Directory -Force -Path $dir
  $secure = Read-Host "SAP password for $($User.ToUpper())" -AsSecureString
  if ($secure.Length -eq 0) {
    Write-Error "Empty password - nothing stored."
    exit 1
  }
  ConvertFrom-SecureString -SecureString $secure | Set-Content -LiteralPath $file -Encoding ascii
  Write-Host "Stored, encrypted for this Windows user: $file"
  exit 0
}

if (-not (Test-Path -LiteralPath $file)) {
  Write-Error "No stored password for $($User.ToUpper()). Run this script once with:  -Store -User $User"
  exit 1
}

# Plain pipeline output: the server strips the single trailing newline. pwsh writes UTF-8,
# which is what the server decodes, so characters such as e-acute or paragraph survive.
Get-Content -LiteralPath $file | ConvertTo-SecureString | ConvertFrom-SecureString -AsPlainText

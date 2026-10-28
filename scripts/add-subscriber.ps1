<#
.SYNOPSIS
  Admin tool to insert subscribers directly into the D1 database, bypassing the
  public /subscribe flow (no confirmation email is sent).

.DESCRIPTION
  Use this to seed addresses you already have consent for. Each row gets a
  generated confirm_token (the schema requires one). You choose whether rows are
  inserted as already-confirmed or as pending.

  Requires: wrangler installed and authenticated (npx wrangler login), run from
  the project root so wrangler.toml is picked up.

.PARAMETER Email
  A single email address to add.

.PARAMETER File
  Path to a text file with one email address per line (blank lines ignored).

.PARAMETER Confirmed
  Insert as already-confirmed (confirmed = 1). Omit to insert as pending (0).

.PARAMETER Local
  Target the local dev database instead of the remote production one.

.EXAMPLE
  ./scripts/add-subscriber.ps1 -Email someone@example.com -Confirmed

.EXAMPLE
  ./scripts/add-subscriber.ps1 -File .\emails.txt
#>
[CmdletBinding(DefaultParameterSetName = 'Single')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Single', Position = 0)]
  [string] $Email,

  [Parameter(Mandatory, ParameterSetName = 'Batch')]
  [string] $File,

  [switch] $Confirmed,

  [switch] $Local
)

$ErrorActionPreference = 'Stop'
$DbName = 'rogouski-subscribers'

# --- Collect and normalize the email list -----------------------------------
$emails = @()
if ($PSCmdlet.ParameterSetName -eq 'Batch') {
  if (-not (Test-Path $File)) { throw "File not found: $File" }
  $emails = Get-Content $File | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
} else {
  $emails = @($Email.Trim())
}

# Normalize (lowercase) and de-duplicate, matching the Worker's behavior.
$emails = $emails | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique

if ($emails.Count -eq 0) { throw 'No email addresses to add.' }

# --- Basic format validation (mirrors the API's intent) ----------------------
$emailRegex = '^[^@\s]+@[^@\s]+\.[^@\s]+$'
$valid = @()
foreach ($e in $emails) {
  if ($e -match $emailRegex) { $valid += $e }
  else { Write-Warning "Skipping invalid email: $e" }
}
if ($valid.Count -eq 0) { throw 'No valid email addresses after validation.' }

# --- Build the SQL ------------------------------------------------------------
# Values are escaped (single quotes doubled) to avoid breaking the statement.
# INSERT OR IGNORE so existing emails (UNIQUE) are skipped rather than erroring.
$confirmedValue = if ($Confirmed) { 1 } else { 0 }
$rows = foreach ($e in $valid) {
  $escaped = $e.Replace("'", "''")
  $token = [guid]::NewGuid().ToString()
  "INSERT OR IGNORE INTO subscribers (email, confirmed, confirm_token) VALUES ('$escaped', $confirmedValue, '$token');"
}

$sqlFile = Join-Path $env:TEMP ("add-subscribers-{0}.sql" -f ([guid]::NewGuid().ToString('N')))
$rows -join "`n" | Set-Content -Path $sqlFile -Encoding ascii

# --- Execute via wrangler -----------------------------------------------------
$target = if ($Local) { '--local' } else { '--remote' }
$stateWord = if ($Confirmed) { 'confirmed' } else { 'pending' }
$where = if ($Local) { 'LOCAL' } else { 'REMOTE (production)' }

Write-Host "Adding $($valid.Count) address(es) as $stateWord to $where database..." -ForegroundColor Cyan

try {
  npx wrangler d1 execute $DbName $target --file $sqlFile
  Write-Host "Done. (Existing addresses are left unchanged.)" -ForegroundColor Green
}
finally {
  Remove-Item -ErrorAction SilentlyContinue $sqlFile
}

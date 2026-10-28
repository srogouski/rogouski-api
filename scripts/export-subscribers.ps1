<#
.SYNOPSIS
  Admin tool to export subscribers to a CSV file (opens in Excel).

.DESCRIPTION
  Queries the D1 database directly via Wrangler and writes a CSV. This needs no
  API key (it uses your Wrangler login), unlike the GET /subscribers.csv endpoint.

  Requires: wrangler installed and authenticated (npx wrangler login), run from
  the project root so wrangler.toml is picked up.

.PARAMETER OutFile
  Path to write the CSV to. Defaults to .\subscribers.csv in the current directory.

.PARAMETER Confirmed
  Export only confirmed subscribers (confirmed = 1). Omit to export everyone.

.PARAMETER Local
  Query the local dev database instead of remote production.

.EXAMPLE
  ./scripts/export-subscribers.ps1

.EXAMPLE
  ./scripts/export-subscribers.ps1 -Confirmed -OutFile .\confirmed.csv
#>
[CmdletBinding()]
param(
  [string] $OutFile = ".\subscribers.csv",

  [switch] $Confirmed,

  [switch] $Local
)

$ErrorActionPreference = 'Stop'
$DbName = 'rogouski-subscribers'

# --- Build the query ----------------------------------------------------------
$where = if ($Confirmed) { 'WHERE confirmed = 1 ' } else { '' }
$query = "SELECT id, email, created_at, confirmed FROM subscribers ${where}ORDER BY id"

$target = if ($Local) { '--local' } else { '--remote' }
$where2 = if ($Local) { 'LOCAL' } else { 'REMOTE (production)' }
$scope  = if ($Confirmed) { 'confirmed-only' } else { 'all' }

Write-Host "Exporting $scope subscribers from $where2 database..." -ForegroundColor Cyan

# --- Run the query (JSON output) ---------------------------------------------
$raw = npx wrangler d1 execute $DbName $target --command $query --json 2>$null
if (-not $raw) { throw 'No output from wrangler. Are you logged in (npx wrangler login)?' }

# wrangler --json prints an array; the rows are in [0].results.
$parsed = $raw | ConvertFrom-Json
$rows = $parsed[0].results
if ($null -eq $rows) { throw 'Could not parse query results.' }

# --- Build CSV text -----------------------------------------------------------
# ConvertTo-Csv handles quoting/escaping. We write the file with a UTF-8 BOM so
# Excel renders accented characters correctly. Writing the BOM explicitly keeps
# this working on both Windows PowerShell 5.1 and PowerShell 7+.
$count = ($rows | Measure-Object).Count

$csvLines =
  if ($count -eq 0) {
    @('"id","email","created_at","confirmed"')
  } else {
    $rows |
      Select-Object id, email, created_at, confirmed |
      ConvertTo-Csv -NoTypeInformation
  }

$csvText = ($csvLines -join "`r`n") + "`r`n"
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
# Resolve to an absolute path (the file may not exist yet, so build it from cwd).
$fullOut = if ([System.IO.Path]::IsPathRooted($OutFile)) {
  $OutFile
} else {
  Join-Path (Get-Location).Path $OutFile
}
[System.IO.File]::WriteAllText($fullOut, $csvText, $utf8Bom)

if ($count -eq 0) {
  Write-Host "No subscribers matched. Wrote header-only file to $OutFile" -ForegroundColor Yellow
} else {
  Write-Host "Exported $count subscriber(s) to $OutFile" -ForegroundColor Green
  Write-Host "Open it in Excel to view as a spreadsheet." -ForegroundColor Green
}

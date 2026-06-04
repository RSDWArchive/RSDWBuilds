param(
  [string]$ProjectRef = "xvhcniquixigesgqojdk",
  [string]$EnvFile = ".env.supabase-upload",
  [switch]$SkipMigration,
  [switch]$SkipSecrets,
  [switch]$SkipFunction
)

$ErrorActionPreference = "Stop"

function Read-DotEnv {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing env file: $Path"
  }

  $vars = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }

    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $vars[$key] = $value
  }
  return $vars
}

function Require-Value {
  param(
    [hashtable]$Vars,
    [string]$Name
  )
  if (-not $Vars.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Vars[$Name])) {
    throw "Missing required value in env file: $Name"
  }
}

function Set-ProcessEnv {
  param([hashtable]$Vars)
  foreach ($key in $Vars.Keys) {
    [Environment]::SetEnvironmentVariable($key, $Vars[$key], "Process")
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$vars = Read-DotEnv $EnvFile
Require-Value $vars "SUPABASE_ACCESS_TOKEN"
Require-Value $vars "GITHUB_APP_ID"
Require-Value $vars "GITHUB_PRIVATE_KEY_B64"

Set-ProcessEnv $vars

Write-Host "Using Supabase CLI:"
npx supabase --version

Write-Host "Authenticating Supabase CLI..."
npx supabase login --token $vars["SUPABASE_ACCESS_TOKEN"]

if (-not $SkipMigration) {
  if ($vars.ContainsKey("SUPABASE_DB_PASSWORD") -and -not [string]::IsNullOrWhiteSpace($vars["SUPABASE_DB_PASSWORD"])) {
    Write-Host "Linking Supabase project and applying migrations..."
    npx supabase link --project-ref $ProjectRef --password $vars["SUPABASE_DB_PASSWORD"] --yes
    npx supabase db push --linked --password $vars["SUPABASE_DB_PASSWORD"]
  } else {
    Write-Host "Skipping migrations because SUPABASE_DB_PASSWORD is not set."
    Write-Host "Run supabase/migrations/20260604000000_upload_allowlist.sql in the Supabase SQL Editor."
  }
}

if (-not $SkipSecrets) {
  $secretFile = Join-Path ([System.IO.Path]::GetTempPath()) ("rsdw-supabase-secrets-" + [guid]::NewGuid() + ".env")
  try {
    $secretNames = @(
      "GITHUB_APP_ID",
      "GITHUB_INSTALLATION_ID",
      "GITHUB_PRIVATE_KEY_B64",
      "GITHUB_OWNER",
      "GITHUB_REPO",
      "GITHUB_BRANCH",
      "GITHUB_WORKFLOW_ID",
      "UPLOAD_ALLOWED_ORIGINS",
      "MAX_ZIP_BYTES"
    )

    $secretLines = foreach ($name in $secretNames) {
      if ($vars.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace($vars[$name])) {
        "$name=$($vars[$name])"
      }
    }
    Set-Content -LiteralPath $secretFile -Value $secretLines -Encoding UTF8

    Write-Host "Setting Edge Function secrets..."
    npx supabase secrets set --project-ref $ProjectRef --env-file $secretFile
  } finally {
    if (Test-Path -LiteralPath $secretFile) {
      Remove-Item -LiteralPath $secretFile -Force
    }
  }
}

if (-not $SkipFunction) {
  Write-Host "Deploying upload-submission Edge Function..."
  npx supabase functions deploy upload-submission --project-ref $ProjectRef --use-api --no-verify-jwt
}

Write-Host "Supabase upload backend setup complete."

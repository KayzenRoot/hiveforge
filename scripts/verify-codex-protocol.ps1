param(
  [string]$OutputDirectory = (Join-Path ([System.IO.Path]::GetTempPath()) ("hiveforge-protocol-" + [guid]::NewGuid().ToString("N")))
)

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
codex app-server generate-ts --out $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw "Could not generate Codex TypeScript protocol" }
codex app-server generate-json-schema --out $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw "Could not generate Codex JSON schema" }
Write-Output ("Codex protocol artifacts generated at " + $OutputDirectory)

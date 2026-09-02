[CmdletBinding()]
param(
  [switch]$SimulateFailureBeforeReplace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ReviewDirectory = Join-Path $RepoRoot "review"
$StagingDirectory = Join-Path $ReviewDirectory ".staging"
$RunId = [guid]::NewGuid().ToString("N")
$RunDirectory = Join-Path $StagingDirectory "review-$RunId"
$TemporaryZip = Join-Path $StagingDirectory "review-$RunId.zip"
$CanonicalZip = Join-Path $ReviewDirectory "HIVEFORGE-REVIEW-LATEST.zip"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$CommandRecords = [System.Collections.Generic.List[object]]::new()

function Write-Utf8File {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Relative-Path {
  param([string]$Path)
  $prefix = $RepoRoot.TrimEnd([char[]]@("\", "/")) + [System.IO.Path]::DirectorySeparatorChar
  return $Path.Substring($prefix.Length).Replace("\", "/")
}

function Test-ExcludedPath {
  param([string]$RelativePath)
  $normalized = $RelativePath.Replace("\", "/")
  $fileName = [System.IO.Path]::GetFileName($normalized)
  if ($normalized -match "(?i)(^|/)(\.git|node_modules|\.next|dist|build|coverage|\.cache|\.turbo|\.protocol-inspect|review|data|tmp|temp)(/|$)") { return $true }
  if ($normalized -match "(?i)\.zip$") { return $true }
  if ($fileName -match "(?i)\.sqlite(-shm|-wal)?$") { return $true }
  if ($normalized -match "(?i)(^|/)\.env($|\..*)") {
    if ($fileName -ne ".env.example") { return $true }
  }
  if ($fileName -match "(?i)\.(pem|key|p12|pfx)$") { return $true }
  if ($fileName -match "(?i)(^|[-_.])(credentials?|secrets?|cookies?|passwords?|api[-_]?keys?)([-_.]|$)") { return $true }
  if ($fileName -match "(?i)\.tsbuildinfo$") { return $true }
  return $false
}

function Invoke-CapturedCommand {
  param(
    [string]$Label,
    [string]$Executable,
    [string[]]$Arguments = @(),
    [switch]$AllowFailure
  )

  $stdoutPath = Join-Path $RunDirectory "$($CommandRecords.Count.ToString('000'))-stdout.txt"
  $stderrPath = Join-Path $RunDirectory "$($CommandRecords.Count.ToString('000'))-stderr.txt"
  $display = $Executable
  if ($Arguments.Count -gt 0) { $display += " " + ($Arguments -join " ") }
  $exitCode = 0
  try {
    & $Executable @Arguments 1> $stdoutPath 2> $stderrPath
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } catch {
    $exitCode = 127
    Write-Utf8File -Path $stdoutPath -Content ""
    Write-Utf8File -Path $stderrPath -Content $_.Exception.Message
  }
  $stdout = ""
  $stderr = ""
  if (Test-Path $stdoutPath) { $stdout = [System.IO.File]::ReadAllText($stdoutPath) }
  if (Test-Path $stderrPath) { $stderr = [System.IO.File]::ReadAllText($stderrPath) }
  $record = [pscustomobject]@{
    Label = $Label
    Command = $display
    ExitCode = $exitCode
    Stdout = $stdout.TrimEnd()
    Stderr = $stderr.TrimEnd()
  }
  $CommandRecords.Add($record)
  if (-not $AllowFailure -and $exitCode -ne 0) { throw "Command failed: $display ($exitCode)" }
  return $record
}

function Get-RecordText {
  param([object]$Record)
  $parts = @(
    "COMMAND: $($Record.Command)",
    "EXIT_CODE: $($Record.ExitCode)",
    "STDOUT:",
    $(if ($Record.Stdout) { $Record.Stdout } else { "<empty>" }),
    "STDERR:",
    $(if ($Record.Stderr) { $Record.Stderr } else { "<empty>" })
  )
  return ($parts -join "`r`n")
}

function Replace-CanonicalZip {
  param([string]$Source, [string]$Destination)
  if (Test-Path -LiteralPath $Destination) {
    try {
      [System.IO.File]::Replace($Source, $Destination, $null, $true)
      return
    } catch {
      $backup = "$Destination.$RunId.previous"
      Move-Item -LiteralPath $Destination -Destination $backup
      try {
        Move-Item -LiteralPath $Source -Destination $Destination
      } catch {
        if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $Destination }
        throw
      }
      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
      return
    }
  }
  Move-Item -LiteralPath $Source -Destination $Destination
}

function Assert-ZipIsValid {
  param([string]$ZipPath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
    $required = @(
      "REVIEW-MANIFEST.md", "REVIEW-MANIFEST.json",
      "evidence/git-status.txt", "evidence/git-log.txt", "evidence/git-branches.txt",
      "evidence/git-head.txt", "evidence/git-diff-stat.txt", "evidence/git-diff.patch",
      "evidence/changed-files.txt", "evidence/repository-tree.txt", "evidence/environment.txt",
      "evidence/remote.txt", "evidence/compare-base.txt", "evidence/pr.txt",
      "evidence/release.txt", "evidence/ci-status.txt",
      "evidence/commands-run.txt", "validation/tests.txt", "validation/lint.txt",
      "validation/typecheck.txt", "validation/build.txt"
    )
    foreach ($entry in $required) {
      if ($names -notcontains $entry) { throw "ZIP is missing required entry: $entry" }
    }
    foreach ($name in $names) {
      if ($name -match "(?i)(^|/)(\.git|node_modules|\.next|dist|build|coverage|data|review/)(/|$)|(^|/)\.env($|\..*)|(?i)\.(pem|key|p12|pfx|sqlite|sqlite-shm|sqlite-wal)$|(?i)\.zip$") {
        throw "ZIP contains an excluded or sensitive entry: $name"
      }
    }
    if (-not ($names | Where-Object { $_ -match "^repository/.+" })) { throw "ZIP does not contain repository snapshot" }
  } finally {
    $archive.Dispose()
  }
}

try {
  New-Item -ItemType Directory -Path $ReviewDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $RunDirectory "evidence") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $RunDirectory "validation") -Force | Out-Null

  $branchRecord = Invoke-CapturedCommand -Label "git branch" -Executable "git" -Arguments @("branch", "--show-current") -AllowFailure
  $statusRecord = Invoke-CapturedCommand -Label "git status" -Executable "git" -Arguments @("status", "--short", "--branch") -AllowFailure
  $porcelainRecord = Invoke-CapturedCommand -Label "git status porcelain" -Executable "git" -Arguments @("status", "--porcelain=v1") -AllowFailure
  $headRecord = Invoke-CapturedCommand -Label "git head" -Executable "git" -Arguments @("rev-parse", "--verify", "HEAD") -AllowFailure
  $remoteUrlRecord = Invoke-CapturedCommand -Label "git remote origin" -Executable "git" -Arguments @("remote", "get-url", "origin") -AllowFailure
  $fetchMainRecord = Invoke-CapturedCommand -Label "git fetch origin main" -Executable "git" -Arguments @("fetch", "origin", "main", "--quiet") -AllowFailure
  $remoteMainRecord = Invoke-CapturedCommand -Label "git remote main" -Executable "git" -Arguments @("rev-parse", "--verify", "origin/main") -AllowFailure
  $baseRecord = if ($remoteMainRecord.ExitCode -eq 0) { $remoteMainRecord } elseif ($headRecord.ExitCode -eq 0) { Invoke-CapturedCommand -Label "git base parent" -Executable "git" -Arguments @("rev-parse", "HEAD^") -AllowFailure } else { $null }
  $logRecord = Invoke-CapturedCommand -Label "git log" -Executable "git" -Arguments @("log", "-10", "--oneline", "--decorate") -AllowFailure
  $branchesRecord = Invoke-CapturedCommand -Label "git branches" -Executable "git" -Arguments @("branch", "--all", "--verbose") -AllowFailure
  $headSha = if ($headRecord.ExitCode -eq 0) { $headRecord.Stdout.Trim() } else { $null }
  $baseSha = if ($baseRecord -and $baseRecord.ExitCode -eq 0) { $baseRecord.Stdout.Trim() } else { $null }
  $compareArguments = if ($baseSha -and $headSha) { @("diff", "$baseSha..$headSha", "--stat") } else { @("diff", "--stat") }
  $diffStatRecord = Invoke-CapturedCommand -Label "git diff compare stat" -Executable "git" -Arguments $compareArguments -AllowFailure
  $comparePatchArguments = if ($baseSha -and $headSha) { @("diff", "$baseSha..$headSha", "--patch") } else { @("diff", "--patch") }
  $diffPatchRecord = Invoke-CapturedCommand -Label "git diff compare patch" -Executable "git" -Arguments $comparePatchArguments -AllowFailure
  $compareNamesArguments = if ($baseSha -and $headSha) { @("diff", "$baseSha..$headSha", "--name-only") } else { @("diff", "--name-only") }
  $changedCompareRecord = Invoke-CapturedCommand -Label "git changed compare" -Executable "git" -Arguments $compareNamesArguments -AllowFailure
  $changedTrackedRecord = Invoke-CapturedCommand -Label "git changed working tree" -Executable "git" -Arguments @("diff", "--name-only") -AllowFailure
  $changedStagedRecord = Invoke-CapturedCommand -Label "git changed staged" -Executable "git" -Arguments @("diff", "--cached", "--name-only") -AllowFailure
  $untrackedRecord = Invoke-CapturedCommand -Label "git untracked" -Executable "git" -Arguments @("ls-files", "--others", "--exclude-standard") -AllowFailure
  $prRecord = Invoke-CapturedCommand -Label "GitHub pull request" -Executable "gh" -Arguments @("pr", "list", "--repo", "KayzenRoot/hiveforge", "--head", $branchRecord.Stdout.Trim(), "--base", "main", "--state", "all", "--limit", "5", "--json", "number,url,state,baseRefName,headRefName") -AllowFailure
  $latestTagRecord = Invoke-CapturedCommand -Label "latest prerelease tag" -Executable "git" -Arguments @("tag", "--list", "v0.1.0-alpha.*", "--sort=-v:refname") -AllowFailure
  $latestTag = ($latestTagRecord.Stdout -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1)
  $releaseArguments = if ($latestTag) {
    @("release", "view", $latestTag.Trim(), "--repo", "KayzenRoot/hiveforge", "--json", "tagName,url,isPrerelease,targetCommitish,publishedAt")
  } else {
    @("release", "list", "--repo", "KayzenRoot/hiveforge", "--limit", "20", "--json", "tagName,isPrerelease,publishedAt,isDraft,isLatest")
  }
  $releaseRecord = Invoke-CapturedCommand -Label "GitHub releases" -Executable "gh" -Arguments $releaseArguments -AllowFailure
  $ciRecord = Invoke-CapturedCommand -Label "GitHub CI status" -Executable "gh" -Arguments @("run", "list", "--repo", "KayzenRoot/hiveforge", "--branch", $branchRecord.Stdout.Trim(), "--limit", "5", "--json", "name,status,conclusion,url,headSha") -AllowFailure

  $branch = $branchRecord.Stdout.Trim()
  if (-not $branch) { $branch = "DETACHED_OR_UNNAMED" }
  $gitDirty = $porcelainRecord.Stdout.Trim().Length -gt 0

  $repoFiles = @(
    Get-ChildItem -LiteralPath $RepoRoot -File -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { $relative = Relative-Path $_.FullName; -not (Test-ExcludedPath $relative) } |
      Sort-Object FullName |
      ForEach-Object { [pscustomobject]@{ FullName = $_.FullName; Relative = Relative-Path $_.FullName } }
  )
  $repositorySnapshot = Join-Path $RunDirectory "repository"
  New-Item -ItemType Directory -Path $repositorySnapshot -Force | Out-Null
  foreach ($file in $repoFiles) {
    $destination = Join-Path $repositorySnapshot ($file.Relative.Replace("/", "\"))
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  }

  $tree = if ($repoFiles.Count -gt 0) { $repoFiles.Relative -join "`r`n" } else { "<empty>" }
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/git-status.txt") -Content $statusRecord.Stdout
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/git-log.txt") -Content $(if ($logRecord.Stdout) { $logRecord.Stdout } else { "<no commits>" })
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/git-branches.txt") -Content $(if ($branchesRecord.Stdout) { $branchesRecord.Stdout } else { "<no branches>" })
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/git-head.txt") -Content $(if ($headSha) { $headSha } else { "<none: repository has no commit>" })
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/git-diff-stat.txt") -Content $(if ($diffStatRecord.Stdout) { $diffStatRecord.Stdout } else { "<empty: no tracked diff>" })
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/git-diff.patch") -Content $(if ($diffPatchRecord.Stdout) { $diffPatchRecord.Stdout } else { "<empty: no tracked patch; untracked files are included in repository snapshot>" })
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/repository-tree.txt") -Content $tree
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/remote.txt") -Content $(if ($remoteUrlRecord.Stdout) { $remoteUrlRecord.Stdout } else { "<origin unavailable>" })
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/compare-base.txt") -Content @(
    "COMPARE_BASE_SHA: $(if ($baseSha) { $baseSha } else { '<none>' })",
    "HEAD_SHA: $(if ($headSha) { $headSha } else { '<none>' })",
    "DIFF_MODE: $(if ($baseSha -and $headSha) { "$baseSha..$headSha" } else { 'working-tree fallback: no published base available' })",
    "REMOTE_MAIN_RECORD:",
    (Get-RecordText $remoteMainRecord)
  ) -join [Environment]::NewLine
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/pr.txt") -Content (Get-RecordText $prRecord)
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/release.txt") -Content (Get-RecordText $releaseRecord)
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/ci-status.txt") -Content (Get-RecordText $ciRecord)

  $os = [System.Environment]::OSVersion.VersionString
  $nodeRecord = Invoke-CapturedCommand -Label "node version" -Executable "node" -Arguments @("--version") -AllowFailure
  $npmRecord = Invoke-CapturedCommand -Label "npm version" -Executable "npm" -Arguments @("--version") -AllowFailure
  $gitRecord = Invoke-CapturedCommand -Label "git version" -Executable "git" -Arguments @("--version") -AllowFailure
  $codexRecord = Invoke-CapturedCommand -Label "codex version" -Executable "codex" -Arguments @("--version") -AllowFailure
  $environment = @(
    "OS: $os",
    "Node: $(if ($nodeRecord.ExitCode -eq 0) { $nodeRecord.Stdout } else { 'NOT_AVAILABLE' })",
    "Package manager: npm $(if ($npmRecord.ExitCode -eq 0) { $npmRecord.Stdout } else { 'NOT_AVAILABLE' })",
    "Git: $(if ($gitRecord.ExitCode -eq 0) { $gitRecord.Stdout } else { 'NOT_AVAILABLE' })",
    "Codex: $(if ($codexRecord.ExitCode -eq 0) { $codexRecord.Stdout } else { 'NOT_AVAILABLE' })"
  ) -join "`r`n"
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/environment.txt") -Content $environment

  $packagePath = Join-Path $RepoRoot "package.json"
  $package = if (Test-Path -LiteralPath $packagePath) { Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json } else { $null }
  $scriptNames = [ordered]@{ tests = "test"; lint = "lint"; typecheck = "typecheck"; build = "build" }
  $validation = [ordered]@{}
  foreach ($label in $scriptNames.Keys) {
    $scriptName = $scriptNames[$label]
    $configured = $false
    if ($package -and $package.scripts -and $package.scripts.PSObject.Properties.Name -contains $scriptName) { $configured = $true }
    if ($configured) {
      $record = Invoke-CapturedCommand -Label "validation/$label" -Executable "npm" -Arguments @("run", $scriptName) -AllowFailure
      $status = if ($record.ExitCode -eq 0) { "PASS" } else { "FAIL" }
      $validation[$label] = [ordered]@{ configured = $true; command = "npm run $scriptName"; exit_code = $record.ExitCode; status = $status }
      Write-Utf8File -Path (Join-Path $RunDirectory "validation/$label.txt") -Content (Get-RecordText $record)
    } else {
      $validation[$label] = [ordered]@{ configured = $false; command = $null; exit_code = $null; status = "NOT_CONFIGURED" }
      Write-Utf8File -Path (Join-Path $RunDirectory "validation/$label.txt") -Content "NOT_CONFIGURED: package.json does not define a $scriptName script."
    }
  }

  $changedFiles = [System.Collections.Generic.List[string]]::new()
  if ($headSha) {
    foreach ($record in @($changedCompareRecord, $changedTrackedRecord, $changedStagedRecord, $untrackedRecord)) {
      if ($record) { foreach ($line in ($record.Stdout -split "`r?`n")) { if ($line.Trim()) { $changedFiles.Add($line.Trim()) } } }
    }
  } else {
    foreach ($file in $repoFiles) { $changedFiles.Add($file.Relative) }
  }
  $changedFiles = @($changedFiles | Sort-Object -Unique)

  $warnings = [System.Collections.Generic.List[string]]::new()
  if (-not $headSha) { $warnings.Add("No Git commit exists; base_sha and head_sha are null rather than invented.") }
  $masterPath = Join-Path $RepoRoot "docs/HIVEFORGE-MASTER-SOURCE-V0.1.md"
  if (Test-Path -LiteralPath $masterPath) {
    $masterText = Get-Content -LiteralPath $masterPath -Raw
    if ($masterText -match "not present|not supplied|Bootstrap note") { $warnings.Add("The authoritative Master Source was not supplied; repository contains a bootstrap note.") }
  }
  foreach ($label in $validation.Keys) { if ($validation[$label].status -eq "FAIL") { $warnings.Add("Validation failed: $label; failure is preserved in validation/$label.txt.") } }
  $warnings.Add("archive_sha256 is not embedded in the manifest to avoid self-referential ZIP hashing.")

  $commandsText = ($CommandRecords | ForEach-Object { Get-RecordText $_ }) -join "`r`n`r`n==============================`r`n`r`n"
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/commands-run.txt") -Content $commandsText

  $packageContents = @(
    "REVIEW-MANIFEST.md", "REVIEW-MANIFEST.json",
    "evidence/git-status.txt", "evidence/git-log.txt", "evidence/git-branches.txt", "evidence/git-head.txt", "evidence/git-diff-stat.txt", "evidence/git-diff.patch", "evidence/changed-files.txt", "evidence/repository-tree.txt", "evidence/environment.txt", "evidence/commands-run.txt",
    "evidence/remote.txt", "evidence/compare-base.txt", "evidence/pr.txt", "evidence/release.txt", "evidence/ci-status.txt",
    "validation/tests.txt", "validation/lint.txt", "validation/typecheck.txt", "validation/build.txt", "repository/"
  )
  Write-Utf8File -Path (Join-Path $RunDirectory "evidence/changed-files.txt") -Content $(if ($changedFiles.Count -gt 0) { $changedFiles -join "`r`n" } else { "<none>" })

  $manifest = [ordered]@{
    schema_version = "hiveforge-review-zip/v1"
    project = "hiveforge"
    generated_at = [DateTime]::UtcNow.ToString("o")
    branch = $branch
    remote_url = if ($remoteUrlRecord.Stdout) { $remoteUrlRecord.Stdout.Trim() } else { $null }
    base_sha = $baseSha
    head_sha = $headSha
    compare_base_sha = $baseSha
    published_head_sha = $headSha
    git_dirty = $gitDirty
    pull_request = [ordered]@{
      exit_code = $prRecord.ExitCode
      output = $prRecord.Stdout
      error = $prRecord.Stderr
    }
    release = [ordered]@{
      exit_code = $releaseRecord.ExitCode
      output = $releaseRecord.Stdout
      error = $releaseRecord.Stderr
    }
    ci_status = [ordered]@{
      exit_code = $ciRecord.ExitCode
      output = $ciRecord.Stdout
      error = $ciRecord.Stderr
    }
    validation = $validation
    changed_files = $changedFiles
    excluded_sensitive_files = @(".git/", "node_modules/", ".next/", "dist/", "build/", "coverage/", "data/", "review/", ".env* except .env.example", "*.pem", "*.key", "*.p12", "*.pfx", "*.sqlite*", "*.zip", "credential/secret/cookie/password filename patterns", "cache and temporary directories")
    warnings = @($warnings)
    contents = $packageContents
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 12
  Write-Utf8File -Path (Join-Path $RunDirectory "REVIEW-MANIFEST.json") -Content $manifestJson

  $markdown = @(
    "# HiveForge Review ZIP",
    "",
    "- Project: hiveforge",
    "- Generated at (UTC): $($manifest.generated_at)",
    "- Branch: $branch",
    "- Remote: $(if ($manifest.remote_url) { $manifest.remote_url } else { '<origin unavailable>' })",
    "- Base SHA: $(if ($baseSha) { $baseSha } else { '<unknown>' })",
    "- Head SHA: $(if ($headSha) { $headSha } else { '<none: repository has no commit>' })",
    "- Comparison: $(if ($baseSha -and $headSha) { "$baseSha..$headSha" } else { 'working-tree fallback' })",
    "- Git dirty: $gitDirty",
    "",
    "## Validations",
    "",
    "| Check | Command | Exit code | Status |",
    "|---|---|---:|---|"
  )
  foreach ($label in $validation.Keys) {
    $item = $validation[$label]
    $markdown += "| $label | $($item.command ?? 'not configured') | $($item.exit_code ?? '-') | $($item.status) |"
  }
  $markdown += @(
    "",
    "## Git evidence",
    "",
    "Evidence files capture status, recent log, branches, HEAD, remote, compare base, diff stat/patch for base..HEAD when available, changed files, repository tree, environment, publication metadata and commands with stdout/stderr/exit code.",
    "",
    "## Security exclusions",
    "",
    "The package excludes Git metadata, dependencies, build/cache output, prior ZIPs, environment files other than `.env.example`, credential extensions and known credential filename patterns.",
    "",
    "## Warnings",
    "",
    $(if ($warnings.Count -gt 0) { $warnings | ForEach-Object { "- $_" } } else { "- none" }),
    "",
    "## Package contents",
    "",
    ($packageContents | ForEach-Object { "- $_" }),
    ""
  )
  Write-Utf8File -Path (Join-Path $RunDirectory "REVIEW-MANIFEST.md") -Content ($markdown -join "`r`n")

  Compress-Archive -Path (Join-Path $RunDirectory "*") -DestinationPath $TemporaryZip -CompressionLevel Optimal
  Assert-ZipIsValid -ZipPath $TemporaryZip
  if ($SimulateFailureBeforeReplace) { throw "Simulated failure before canonical replacement." }
  Replace-CanonicalZip -Source $TemporaryZip -Destination $CanonicalZip
  Assert-ZipIsValid -ZipPath $CanonicalZip
  Write-Host "Review ZIP ready: $([System.IO.Path]::GetRelativePath($RepoRoot, $CanonicalZip).Replace('\', '/'))"
} catch {
  Write-Error $_
  exit 1
} finally {
  if (Test-Path -LiteralPath $RunDirectory) { Remove-Item -LiteralPath $RunDirectory -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $TemporaryZip) { Remove-Item -LiteralPath $TemporaryZip -Force -ErrorAction SilentlyContinue }
}

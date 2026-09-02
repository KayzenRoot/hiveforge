[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$WorkOrderId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9._-]*$')]
    [string]$ShortSlug,

    [string]$CommitMessage,
    [string]$ReleaseNotes,
    [switch]$Bootstrap,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

$CanonicalRemote = "https://github.com/KayzenRoot/hiveforge.git"
$Repository = "KayzenRoot/hiveforge"
$RequiredChecks = @("test", "test:e2e", "lint", "typecheck", "build")

function Get-CommandText {
    param([Parameter(Mandatory = $true)][string[]]$Command)

    $arguments = @($Command | Select-Object -Skip 1)
    $output = & $Command[0] @arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        return ""
    }
    return $output.Trim()
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string[]]$Command,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Write-Host "[$Label]"
    $arguments = @($Command | Select-Object -Skip 1)
    $output = & $Command[0] @arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($output.Trim()) {
        Write-Host $output.TrimEnd()
    }
    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode."
    }
    return $output.Trim()
}

function Normalize-Remote {
    param([string]$Url)

    $normalized = $Url.Trim().TrimEnd("/")
    if ($normalized.EndsWith(".git", [System.StringComparison]::OrdinalIgnoreCase)) {
        $normalized = $normalized.Substring(0, $normalized.Length - 4)
    }
    return $normalized.ToLowerInvariant()
}

function Test-ForbiddenPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $normalized = $Path.Replace("\", "/")
    if ($normalized -eq ".env.example") {
        return $false
    }
    return (($normalized -match '(^|/)\.env($|[./])') -or ($normalized -match '(^|/)(credentials?|secrets?|tokens?)([./_-]|$)') -or ($normalized -match '(^|/)(id_rsa|id_ed25519|.*\.(pem|key|p12|pfx|jks))$') -or ($normalized -match '(^|/)\.npmrc$'))
}

function Get-CandidatePaths {
    $tracked = @(git ls-files)
    $untracked = @(git ls-files --others --exclude-standard)
    return @($tracked + $untracked | Where-Object { $_ -and ($_ -notlike "review/*") })
}

function Get-NextAlphaNumber {
    param([string]$TagOutput)

    $max = 0
    foreach ($line in ($TagOutput -split '\r?\n')) {
        $match = [regex]::Match($line.Trim(), '^v0\.1\.0-alpha\.(\d+)(?:\^\{\})?$')
        if ($match.Success) {
            $number = [int]$match.Groups[1].Value
            if ($number -gt $max) {
                $max = $number
            }
        }
    }
    return $max + 1
}

function Try-Protect-Main {
    $protection = [ordered]@{
        required_status_checks = [ordered]@{
            strict = $true
            contexts = @("Validate")
        }
        enforce_admins = $true
        required_pull_request_reviews = [ordered]@{
            dismiss_stale_reviews = $true
            require_code_owner_reviews = $true
            required_approving_review_count = 1
            require_last_push_approval = $true
        }
        restrictions = $null
        required_linear_history = $false
        allow_force_pushes = $false
        allow_deletions = $false
        block_creations = $false
        required_conversation_resolution = $true
    }
    $payload = $protection | ConvertTo-Json -Depth 10 -Compress
    $result = $payload | & gh api --method PUT "repos/$Repository/branches/main/protection" --input - 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        Write-Host "[main protection] applied"
        return "APPLIED"
    }

    $summary = ($result.Trim() -replace '\s+', ' ')
    if ($summary.Length -gt 300) {
        $summary = $summary.Substring(0, 300)
    }
    Write-Warning "main protection could not be applied: $summary"
    return "LIMITED: $summary"
}

if (-not $CommitMessage) {
    if ($Bootstrap) {
        $CommitMessage = "chore(governance): establish GitHub professional baseline [$WorkOrderId]"
    }
    else {
        $CommitMessage = "chore: execute $WorkOrderId"
    }
}

if ($CommitMessage -notmatch '^(feat|fix|docs|chore|ci|build|refactor|test|perf|revert)(\([^)]+\))?(!)?: .+') {
    throw "CommitMessage must follow Conventional Commits."
}

$currentBranch = (git branch --show-current).Trim()
if ($Bootstrap -and $currentBranch -ne "main") {
    throw "Bootstrap requires the local main branch."
}

$origin = Get-CommandText @("git", "remote", "get-url", "origin")
if (-not $origin) {
    if ($DryRun) {
        Write-Host "[remote] would add $CanonicalRemote"
    }
    else {
        Invoke-Checked @("git", "remote", "add", "origin", $CanonicalRemote) "configure origin" | Out-Null
        $origin = $CanonicalRemote
    }
}
elseif ((Normalize-Remote $origin) -ne (Normalize-Remote $CanonicalRemote)) {
    throw "origin is '$origin', expected '$CanonicalRemote'."
}

if ($Bootstrap -and -not $DryRun) {
    $remoteRefs = Get-CommandText @("git", "ls-remote", "--heads", "--tags", "origin")
    if ($remoteRefs) {
        throw "Bootstrap stopped: origin already contains refs; no overwrite was attempted."
    }
}

$candidatePaths = @(Get-CandidatePaths | Sort-Object -Unique)
$forbiddenPaths = @($candidatePaths | Where-Object { Test-ForbiddenPath $_ })
if ($forbiddenPaths.Count -gt 0) {
    throw "Potential secret or credential paths detected: $($forbiddenPaths -join ', ')"
}

$package = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$scriptNames = @($package.scripts.psobject.Properties.Name)
$missingScripts = @($RequiredChecks | Where-Object { $_ -notin $scriptNames })
if ($missingScripts.Count -gt 0) {
    throw "Configured validation scripts are missing: $($missingScripts -join ', ')"
}

if ($DryRun) {
    Write-Host "[dry-run] validation commands: npm ci, $($RequiredChecks -join ', ')"
}
else {
    Invoke-Checked @("npm", "ci") "install locked dependencies" | Out-Null
    foreach ($scriptName in $RequiredChecks) {
        Invoke-Checked @("npm", "run", $scriptName) "npm run $scriptName" | Out-Null
    }
}

$expectedBranch = "work/$WorkOrderId-$ShortSlug"
if (-not $Bootstrap) {
    if ($currentBranch -eq "main") {
        if ($DryRun) {
            Write-Host "[branch] would create and switch to $expectedBranch"
        }
        else {
            Invoke-Checked @("git", "switch", "-c", $expectedBranch) "create work branch" | Out-Null
            $currentBranch = $expectedBranch
        }
    }
    elseif ($currentBranch -ne $expectedBranch) {
        throw "Expected branch '$expectedBranch', found '$currentBranch'."
    }
}

$status = @(git status --porcelain)
if ($status.Count -eq 0) {
    throw "No working-tree changes are available to publish."
}

if ($DryRun) {
    Write-Host "[dry-run] would stage candidate files, commit, push, create a prerelease, and regenerate the local Review ZIP."
    Write-Output "DRY_RUN_OK"
    exit 0
}

$gitName = Get-CommandText @("git", "config", "user.name")
$gitEmail = Get-CommandText @("git", "config", "user.email")
if (-not $gitName -or -not $gitEmail) {
    $login = Get-CommandText @("gh", "api", "user", "--jq", ".login")
    if (-not $login) {
        $login = "KayzenRoot"
    }
    if (-not $gitName) {
        Invoke-Checked @("git", "config", "user.name", $login) "configure local Git user name" | Out-Null
    }
    if (-not $gitEmail) {
        Invoke-Checked @("git", "config", "user.email", "$login@users.noreply.github.com") "configure local Git user email" | Out-Null
    }
}

Invoke-Checked @("git", "add", "-A") "stage publication" | Out-Null
$stagedPaths = @(git diff --cached --name-only)
$stagedForbidden = @($stagedPaths | Where-Object { Test-ForbiddenPath $_ })
if ($stagedForbidden.Count -gt 0) {
    throw "Refusing to commit potential secret paths: $($stagedForbidden -join ', ')"
}
if ($stagedPaths.Count -eq 0) {
    throw "Nothing was staged for publication."
}

Invoke-Checked @("git", "commit", "-m", $CommitMessage) "create Conventional Commit" | Out-Null
$headSha = (git rev-parse HEAD).Trim()
Invoke-Checked @("git", "push", "--set-upstream", "origin", $currentBranch) "push $currentBranch" | Out-Null

$prUrl = ""
if (-not $Bootstrap) {
    $prUrl = Get-CommandText @("gh", "pr", "list", "--repo", $Repository, "--head", $currentBranch, "--base", "main", "--state", "open", "--json", "url", "--jq", ".[0].url")
    if (-not $prUrl) {
        $lineBreak = [Environment]::NewLine
        $prBody = "Work order: $WorkOrderId$lineBreak$lineBreak" + "Validation: npm test, npm run test:e2e, npm run lint, npm run typecheck, npm run build.$lineBreak$lineBreak" + "This pull request is not auto-merged."
        $prUrl = Invoke-Checked @("gh", "pr", "create", "--repo", $Repository, "--base", "main", "--head", $currentBranch, "--title", $CommitMessage, "--body", $prBody) "create pull request"
    }
    Write-Host "Pull request: $prUrl"
}

$localTags = Get-CommandText @("git", "tag", "--list", "v0.1.0-alpha.*")
$remoteTags = Get-CommandText @("git", "ls-remote", "--tags", "origin", "refs/tags/v0.1.0-alpha.*")
$tagOutput = ($localTags + [Environment]::NewLine + $remoteTags) -replace '^[0-9a-f]+\s+refs/tags/', '' -replace '\^?\{\}', ''
$nextAlpha = Get-NextAlphaNumber $tagOutput
$tag = "v0.1.0-alpha.$nextAlpha"

Invoke-Checked @("git", "tag", "-a", $tag, "-m", "release: $tag") "create annotated prerelease tag" | Out-Null
Invoke-Checked @("git", "push", "origin", $tag) "push $tag" | Out-Null

if (-not $ReleaseNotes) {
    $lineBreak = [Environment]::NewLine
    $ReleaseNotes = "HiveForge development prerelease $tag.$lineBreak$lineBreak" + "Commit: $headSha.$lineBreak$lineBreak" + "This is a V0.1 MVP development snapshot and is not production-ready."
}
Invoke-Checked @("gh", "release", "create", $tag, "--repo", $Repository, "--verify-tag", "--title", $tag, "--notes", $ReleaseNotes, "--prerelease") "publish GitHub prerelease" | Out-Null

$protectionStatus = Try-Protect-Main
$remoteBranch = Get-CommandText @("git", "ls-remote", "origin", "refs/heads/$currentBranch")
$remoteBranchSha = (($remoteBranch -split '\s+')[0]).Trim()
if ($remoteBranchSha -ne $headSha) {
    throw "Remote branch verification failed: expected $headSha, found $remoteBranchSha."
}
$remoteTag = Get-CommandText @("git", "ls-remote", "origin", "refs/tags/$tag^{}")
$remoteTagSha = (($remoteTag -split '\s+')[0]).Trim()
if ($remoteTagSha -ne $headSha) {
    throw "Remote tag verification failed: expected $headSha, found $remoteTagSha."
}
$releaseView = Get-CommandText @("gh", "release", "view", $tag, "--repo", $Repository, "--json", "tagName,url,isPrerelease,targetCommitish")
if (-not $releaseView) {
    throw "GitHub release verification failed for $tag."
}

$reviewScript = Join-Path $PSScriptRoot "create-review-zip.ps1"
$reviewOutput = & $reviewScript 2>&1 | Out-String
$reviewExit = $LASTEXITCODE
if ($reviewOutput.Trim()) {
    Write-Host $reviewOutput.TrimEnd()
}
if ($reviewExit -ne 0) {
    throw "Review ZIP generation failed after publication."
}

if (@(git ls-files "review/*").Count -gt 0) {
    throw "Review ZIP files must remain uncommitted."
}

Write-Host "Published head: $headSha"
Write-Host "Branch: $currentBranch"
Write-Host "Tag: $tag"
Write-Host "Protection: $protectionStatus"
if ($prUrl) {
    Write-Host "PR: $prUrl"
}
Write-Output "FINALIZE_OK"

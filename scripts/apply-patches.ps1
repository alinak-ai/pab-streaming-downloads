param(
    [Parameter(Mandatory = $true)]
    [string]$ChromiumSrc
)

$ErrorActionPreference = "Stop"
$baseCommit = "d2b48fd5f7813ed477a2d68fa232b8178fa4fb1e"
$sourcePath = (Resolve-Path -LiteralPath $ChromiumSrc).Path
$projectPath = Split-Path -Parent $PSScriptRoot
$patchPaths = @(
    (Join-Path $projectPath "patches\0001-Implement-streaming-downloads-extension-API.patch")
    (Join-Path $projectPath "patches\0002-Fix-unsafe-buffer-copy-in-streaming-downloads.patch")
)

foreach ($patchPath in $patchPaths) {
    if (-not (Test-Path -LiteralPath $patchPath)) {
        throw "Patch file not found: $patchPath"
    }
}

$currentCommit = git -C $sourcePath rev-parse HEAD
if ($LASTEXITCODE -ne 0) {
    throw "Cannot read the Chromium Git repository."
}

if ($currentCommit -ne $baseCommit) {
    throw "Expected Chromium base $baseCommit. No changes were applied."
}

$changes = git -C $sourcePath status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0) {
    throw "Cannot check repository status."
}

if ($changes) {
    throw "Save your tracked Chromium changes before applying the patch."
}

git -C $sourcePath am -- $patchPaths
if ($LASTEXITCODE -ne 0) {
    throw "Patch application failed. Inspect git status; use git am --abort to cancel the patch operation."
}

Write-Host "Streaming downloads implementation applied successfully."

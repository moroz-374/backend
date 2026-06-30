[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Version,

    [string]$OutputDirectory = 'artifacts'
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))

if (-not $outputRoot.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must stay inside the workspace: $outputRoot"
}

$buildxCandidates = @(
    (Get-Command docker-buildx -ErrorAction SilentlyContinue).Source,
    'D:\Programs\Docker\cli-plugins\docker-buildx.exe',
    'D:\Programs\Docker\resources\cli-plugins\docker-buildx.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$buildx = $buildxCandidates | Select-Object -First 1
if (-not $buildx) {
    throw 'Docker Buildx CLI plugin was not found.'
}

foreach ($repo in @('backend', 'frontend', 'node')) {
    $branch = git -C (Join-Path $root $repo) branch --show-current
    if ($branch -ne 'feature/traffic-audit') {
        throw "$repo must be on feature/traffic-audit, found: $branch"
    }
    git -C (Join-Path $root $repo) status --short --branch
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$backendArchive = Join-Path $outputRoot "remnawave-backend-$Version.oci.tar"
$nodeArchive = Join-Path $outputRoot "remnawave-node-$Version.oci.tar"
foreach ($archive in @($backendArchive, $nodeArchive)) {
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
}

$backendCommit = (git -C (Join-Path $root 'backend') rev-parse HEAD).Trim()
$frontendCommit = (git -C (Join-Path $root 'frontend') rev-parse HEAD).Trim()
$nodeCommit = (git -C (Join-Path $root 'node') rev-parse HEAD).Trim()
$buildTime = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')

$backendArgs = @(
    'build',
    '--builder', 'desktop-linux',
    '--platform', 'linux/amd64,linux/arm64',
    '--file', (Join-Path $root 'backend/Dockerfile.release'),
    '--build-context', "frontend-source=$(Join-Path $root 'frontend')",
    '--build-arg', 'BRANCH=feature/traffic-audit',
    '--build-arg', "__RW_METADATA_VERSION=$Version",
    '--build-arg', "__RW_METADATA_GIT_BACKEND_COMMIT=$backendCommit",
    '--build-arg', "__RW_METADATA_GIT_FRONTEND_COMMIT=$frontendCommit",
    '--build-arg', '__RW_METADATA_GIT_BRANCH=feature/traffic-audit',
    '--build-arg', "__RW_METADATA_BUILD_TIME=$buildTime",
    '--label', "org.opencontainers.image.created=$buildTime",
    '--tag', "local/remnawave-backend:$Version",
    '--provenance=mode=max',
    '--sbom=true',
    '--output', "type=oci,dest=$backendArchive",
    (Join-Path $root 'backend')
)
& $buildx @backendArgs
if ($LASTEXITCODE -ne 0) { throw 'Backend OCI build failed.' }

$nodeArgs = @(
    'build',
    '--builder', 'desktop-linux',
    '--platform', 'linux/amd64,linux/arm64',
    '--file', (Join-Path $root 'node/Dockerfile'),
    '--label', "org.opencontainers.image.created=$buildTime",
    '--label', "org.opencontainers.image.version=$Version",
    '--label', "org.opencontainers.image.revision=$nodeCommit",
    '--tag', "local/remnawave-node:$Version",
    '--provenance=mode=max',
    '--sbom=true',
    '--output', "type=oci,dest=$nodeArchive",
    (Join-Path $root 'node')
)
& $buildx @nodeArgs
if ($LASTEXITCODE -ne 0) { throw 'Node OCI build failed.' }

Get-Item -LiteralPath $backendArchive, $nodeArchive | Select-Object FullName, Length, LastWriteTimeUtc

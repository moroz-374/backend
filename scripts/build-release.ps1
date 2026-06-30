[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+-traffic-audit\.\d+$')]
    [string]$Version,

    [string]$OutputDirectory = 'artifacts'
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
$contractPath = Join-Path $root 'backend/release/release-contract.json'
$contract = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json

if (-not $Version) {
    $Version = $contract.version
}

if ($Version -ne $contract.version) {
    throw "Version '$Version' does not match the release contract version '$($contract.version)'."
}

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
    $repoPath = Join-Path $root $repo
    $branch = git -C $repoPath branch --show-current
    if ($branch -ne 'feature/traffic-audit') {
        throw "$repo must be on feature/traffic-audit, found: $branch"
    }
    $status = git -C $repoPath status --porcelain
    if ($status) {
        throw "$repo working tree must be clean before a release build.`n$status"
    }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$backendArchive = Join-Path $outputRoot "remnawave-backend-$Version.oci.tar"
$nodeArchive = Join-Path $outputRoot "remnawave-node-$Version.oci.tar"
$releaseManifest = Join-Path $outputRoot "release-manifest-$Version.json"
foreach ($archive in @($backendArchive, $nodeArchive, $releaseManifest)) {
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
}

$backendCommit = (git -C (Join-Path $root 'backend') rev-parse HEAD).Trim()
$frontendCommit = (git -C (Join-Path $root 'frontend') rev-parse HEAD).Trim()
$nodeCommit = (git -C (Join-Path $root 'node') rev-parse HEAD).Trim()
$buildTime = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$backendImage = $contract.images.backend
$nodeImage = $contract.images.node

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
    '--tag', "${backendImage}:$Version",
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
    '--tag', "${nodeImage}:$Version",
    '--provenance=mode=max',
    '--sbom=true',
    '--output', "type=oci,dest=$nodeArchive",
    (Join-Path $root 'node')
)
& $buildx @nodeArgs
if ($LASTEXITCODE -ne 0) { throw 'Node OCI build failed.' }

function Get-OciImageDigest {
    param([Parameter(Mandatory = $true)][string]$Archive)

    $index = (& tar -xOf $Archive index.json) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read OCI index from $Archive"
    }

    $descriptor = $index.manifests |
        Where-Object { $_.mediaType -eq 'application/vnd.oci.image.index.v1+json' } |
        Select-Object -First 1
    if (-not $descriptor.digest) {
        throw "OCI image index digest was not found in $Archive"
    }

    return $descriptor.digest
}

$manifest = [ordered]@{
    schemaVersion = 1
    version = $Version
    createdAt = $buildTime
    stableTag = $contract.channelTag
    stablePromoted = $false
    sources = [ordered]@{
        backend = [ordered]@{
            url = $contract.sources.backend.url
            upstreamVersion = $contract.sources.backend.upstreamVersion
            commit = $backendCommit
        }
        frontend = [ordered]@{
            url = $contract.sources.frontend.url
            upstreamVersion = $contract.sources.frontend.upstreamVersion
            commit = $frontendCommit
        }
        node = [ordered]@{
            url = $contract.sources.node.url
            upstreamVersion = $contract.sources.node.upstreamVersion
            commit = $nodeCommit
        }
    }
    images = [ordered]@{
        backend = [ordered]@{
            repository = $backendImage
            immutableTag = "${backendImage}:$Version"
            stableTag = "${backendImage}:$($contract.channelTag)"
            digest = Get-OciImageDigest -Archive $backendArchive
            platforms = @('linux/amd64', 'linux/arm64')
            archive = [System.IO.Path]::GetFileName($backendArchive)
            archiveSha256 = (Get-FileHash -LiteralPath $backendArchive -Algorithm SHA256).Hash.ToLowerInvariant()
            sbom = 'spdx'
            provenance = 'slsa-max'
        }
        node = [ordered]@{
            repository = $nodeImage
            immutableTag = "${nodeImage}:$Version"
            stableTag = "${nodeImage}:$($contract.channelTag)"
            digest = Get-OciImageDigest -Archive $nodeArchive
            platforms = @('linux/amd64', 'linux/arm64')
            archive = [System.IO.Path]::GetFileName($nodeArchive)
            archiveSha256 = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
            sbom = 'spdx'
            provenance = 'slsa-max'
        }
    }
}

$manifestJson = $manifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText(
    $releaseManifest,
    $manifestJson,
    [System.Text.UTF8Encoding]::new($false)
)

Get-Item -LiteralPath $backendArchive, $nodeArchive, $releaseManifest |
    Select-Object FullName, Length, LastWriteTimeUtc

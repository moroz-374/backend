#!/usr/bin/env bash
set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${CREATED_AT:?CREATED_AT is required}"
: "${BACKEND_SHA:?BACKEND_SHA is required}"
: "${FRONTEND_SHA:?FRONTEND_SHA is required}"
: "${NODE_SHA:?NODE_SHA is required}"
: "${XRAY_REPOSITORY:?XRAY_REPOSITORY is required}"
: "${XRAY_VERSION:?XRAY_VERSION is required}"
: "${XRAY_REVISION:?XRAY_REVISION is required}"
: "${XRAY_AMD64_SHA256:?XRAY_AMD64_SHA256 is required}"
: "${XRAY_ARM64_SHA256:?XRAY_ARM64_SHA256 is required}"
: "${BACKEND_DIGEST:?BACKEND_DIGEST is required}"
: "${NODE_DIGEST:?NODE_DIGEST is required}"

version_pattern='^[0-9]+\.[0-9]+\.[0-9]+-traffic-audit\.[0-9]+$'
digest_pattern='^sha256:[0-9a-f]{64}$'
[[ "$VERSION" =~ $version_pattern ]]
[[ "$BACKEND_DIGEST" =~ $digest_pattern ]]
[[ "$NODE_DIGEST" =~ $digest_pattern ]]

workspace="$(pwd)"
contract="$workspace/backend/release/release-contract.json"
artifacts="$workspace/artifacts"
bundle_root="$(mktemp -d)"
trap 'rm -rf "$bundle_root"' EXIT

test "$(jq -r '.version' "$contract")" = "$VERSION"
test "$(jq -r '.sources.xray.repository' "$contract")" = "$XRAY_REPOSITORY"
test "$(jq -r '.sources.xray.version' "$contract")" = "$XRAY_VERSION"
test "$(jq -r '.sources.xray.revision' "$contract")" = "$XRAY_REVISION"
test "$(jq -r '.sources.xray.assets.linuxAmd64.sha256' "$contract")" = "$XRAY_AMD64_SHA256"
test "$(jq -r '.sources.xray.assets.linuxArm64.sha256' "$contract")" = "$XRAY_ARM64_SHA256"
mkdir -p "$artifacts" "$bundle_root/remnawave-source-$VERSION"

for repository in backend frontend node; do
  expected_var="${repository^^}_SHA"
  expected_sha="${!expected_var}"
  actual_sha="$(git -C "$workspace/$repository" rev-parse HEAD)"
  test "$actual_sha" = "$expected_sha"
  git -C "$workspace/$repository" archive --format=tar HEAD \
    | tar -xf - -C "$bundle_root/remnawave-source-$VERSION" --transform "s,^,$repository/,"
done

jq -n \
  --arg version "$VERSION" \
  --arg createdAt "$CREATED_AT" \
  --arg backend "$BACKEND_SHA" \
  --arg frontend "$FRONTEND_SHA" \
  --arg node "$NODE_SHA" \
  --arg xrayRepository "$XRAY_REPOSITORY" \
  --arg xrayVersion "$XRAY_VERSION" \
  --arg xrayRevision "$XRAY_REVISION" \
  '{schemaVersion: 1, version: $version, createdAt: $createdAt,
    repositories: {
      backend: $backend,
      frontend: $frontend,
      node: $node,
      xray: {repository: $xrayRepository, version: $xrayVersion, revision: $xrayRevision}
    }}' \
  > "$bundle_root/remnawave-source-$VERSION/SOURCES.json"

cat > "$bundle_root/remnawave-source-$VERSION/THIRD-PARTY-NOTICES.txt" <<EOF
Remnawave Traffic Audit release $VERSION license notice

This source bundle contains the AGPL-3.0-only Remnawave sources for backend,
frontend and node. The released node image also bundles Xray-core as a separate
component under MPL-2.0.

Bundled Xray-core source:
- Repository: https://github.com/$XRAY_REPOSITORY
- Version: $XRAY_VERSION
- Revision: $XRAY_REVISION
- Upstream base: $(jq -r '.sources.xray.upstreamVersion' "$contract")

Bundled Xray-core release assets:
- $(jq -r '.sources.xray.assets.linuxAmd64.name' "$contract"): $XRAY_AMD64_SHA256
- $(jq -r '.sources.xray.assets.linuxArm64.name' "$contract"): $XRAY_ARM64_SHA256

The Xray-core source tag/revision contains the MPL-2.0 LICENSE, NOTICE and
PATCHES.md files for the fork-specific changes.
EOF

tar -czf "$artifacts/remnawave-source-$VERSION.tar.gz" \
  -C "$bundle_root" "remnawave-source-$VERSION"
source_sha256="$(sha256sum "$artifacts/remnawave-source-$VERSION.tar.gz" | cut -d ' ' -f 1)"

jq -n \
  --arg version "$VERSION" \
  --arg createdAt "$CREATED_AT" \
  --arg stableTag "$(jq -r '.channelTag' "$contract")" \
  --arg backendUrl "$(jq -r '.sources.backend.url' "$contract")" \
  --arg frontendUrl "$(jq -r '.sources.frontend.url' "$contract")" \
  --arg nodeUrl "$(jq -r '.sources.node.url' "$contract")" \
  --arg xrayUrl "$(jq -r '.sources.xray.url' "$contract")" \
  --arg backendUpstream "$(jq -r '.sources.backend.upstreamVersion' "$contract")" \
  --arg frontendUpstream "$(jq -r '.sources.frontend.upstreamVersion' "$contract")" \
  --arg nodeUpstream "$(jq -r '.sources.node.upstreamVersion' "$contract")" \
  --arg xrayUpstream "$(jq -r '.sources.xray.upstreamVersion' "$contract")" \
  --arg backendCommit "$BACKEND_SHA" \
  --arg frontendCommit "$FRONTEND_SHA" \
  --arg nodeCommit "$NODE_SHA" \
  --arg xrayRepository "$XRAY_REPOSITORY" \
  --arg xrayVersion "$XRAY_VERSION" \
  --arg xrayRevision "$XRAY_REVISION" \
  --arg xrayAmd64Asset "$(jq -r '.sources.xray.assets.linuxAmd64.name' "$contract")" \
  --arg xrayArm64Asset "$(jq -r '.sources.xray.assets.linuxArm64.name' "$contract")" \
  --arg xrayAmd64Sha256 "$XRAY_AMD64_SHA256" \
  --arg xrayArm64Sha256 "$XRAY_ARM64_SHA256" \
  --arg backendRepository "$(jq -r '.images.backend' "$contract")" \
  --arg nodeRepository "$(jq -r '.images.node' "$contract")" \
  --arg backendDigest "$BACKEND_DIGEST" \
  --arg nodeDigest "$NODE_DIGEST" \
  --arg sourceArchive "remnawave-source-$VERSION.tar.gz" \
  --arg sourceSha256 "$source_sha256" \
  '{schemaVersion: 1, version: $version, createdAt: $createdAt,
    stableTag: $stableTag, stablePromoted: false,
    sources: {
      backend: {url: $backendUrl, upstreamVersion: $backendUpstream, commit: $backendCommit},
      frontend: {url: $frontendUrl, upstreamVersion: $frontendUpstream, commit: $frontendCommit},
      node: {url: $nodeUrl, upstreamVersion: $nodeUpstream, commit: $nodeCommit},
      xray: {
        url: $xrayUrl,
        upstreamVersion: $xrayUpstream,
        repository: $xrayRepository,
        version: $xrayVersion,
        revision: $xrayRevision,
        assets: {
          linuxAmd64: {name: $xrayAmd64Asset, sha256: $xrayAmd64Sha256},
          linuxArm64: {name: $xrayArm64Asset, sha256: $xrayArm64Sha256}
        }
      }
    },
    images: {
      backend: {repository: $backendRepository, immutableTag: ($backendRepository + ":" + $version), digest: $backendDigest, platforms: ["linux/amd64", "linux/arm64"], sbom: "spdx", provenance: "slsa-max"},
      node: {
        repository: $nodeRepository,
        immutableTag: ($nodeRepository + ":" + $version),
        digest: $nodeDigest,
        platforms: ["linux/amd64", "linux/arm64"],
        sbom: "spdx",
        provenance: "slsa-max",
        xray: {
          repository: $xrayRepository,
          version: $xrayVersion,
          revision: $xrayRevision,
          linuxAmd64Sha256: $xrayAmd64Sha256,
          linuxArm64Sha256: $xrayArm64Sha256
        }
      }
    },
    sourceBundle: {archive: $sourceArchive, sha256: $sourceSha256},
    licenseNotice: {
      combinedImageLicenses: ["AGPL-3.0-only", "MPL-2.0"],
      remnawave: {
        license: "AGPL-3.0-only",
        appliesTo: ["backend image", "node application code", "frontend application code"]
      },
      xray: {
        license: "MPL-2.0",
        appliesTo: ["bundled Xray-core binary in node image", "Xray-core fork source modifications"],
        repository: $xrayRepository,
        version: $xrayVersion,
        revision: $xrayRevision,
        noticePathInNodeImage: "/usr/share/doc/remnawave-node/THIRD-PARTY-NOTICES.txt",
        licensePathInNodeImage: "/usr/share/licenses/xray-core/LICENSE"
      }
    }}' \
  > "$artifacts/release-manifest-$VERSION.json"

cat > "$artifacts/release-notes.md" <<EOF
Traffic-audit release \`$VERSION\`.

- Backend: \`$(jq -r '.images.backend' "$contract")@$BACKEND_DIGEST\`
- Node: \`$(jq -r '.images.node' "$contract")@$NODE_DIGEST\`
- Xray: \`$XRAY_REPOSITORY@$XRAY_REVISION\` (\`$XRAY_VERSION\`)
- Corresponding source: \`remnawave-source-$VERSION.tar.gz\`
- License notice: Remnawave sources are AGPL-3.0-only; bundled Xray-core in the node image is MPL-2.0 and is documented in \`THIRD-PARTY-NOTICES.txt\`.
- The mutable \`stable\` tag is not updated by this release workflow.
EOF

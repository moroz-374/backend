#!/usr/bin/env bash
set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${CREATED_AT:?CREATED_AT is required}"
: "${BACKEND_SHA:?BACKEND_SHA is required}"
: "${FRONTEND_SHA:?FRONTEND_SHA is required}"
: "${NODE_SHA:?NODE_SHA is required}"
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
  '{schemaVersion: 1, version: $version, createdAt: $createdAt,
    repositories: {backend: $backend, frontend: $frontend, node: $node}}' \
  > "$bundle_root/remnawave-source-$VERSION/SOURCES.json"

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
  --arg backendUpstream "$(jq -r '.sources.backend.upstreamVersion' "$contract")" \
  --arg frontendUpstream "$(jq -r '.sources.frontend.upstreamVersion' "$contract")" \
  --arg nodeUpstream "$(jq -r '.sources.node.upstreamVersion' "$contract")" \
  --arg backendCommit "$BACKEND_SHA" \
  --arg frontendCommit "$FRONTEND_SHA" \
  --arg nodeCommit "$NODE_SHA" \
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
      node: {url: $nodeUrl, upstreamVersion: $nodeUpstream, commit: $nodeCommit}
    },
    images: {
      backend: {repository: $backendRepository, immutableTag: ($backendRepository + ":" + $version), digest: $backendDigest, platforms: ["linux/amd64", "linux/arm64"], sbom: "spdx", provenance: "slsa-max"},
      node: {repository: $nodeRepository, immutableTag: ($nodeRepository + ":" + $version), digest: $nodeDigest, platforms: ["linux/amd64", "linux/arm64"], sbom: "spdx", provenance: "slsa-max"}
    },
    sourceBundle: {archive: $sourceArchive, sha256: $sourceSha256}}' \
  > "$artifacts/release-manifest-$VERSION.json"

cat > "$artifacts/release-notes.md" <<EOF
Traffic-audit release \`$VERSION\`.

- Backend: \`$(jq -r '.images.backend' "$contract")@$BACKEND_DIGEST\`
- Node: \`$(jq -r '.images.node' "$contract")@$NODE_DIGEST\`
- Corresponding source: \`remnawave-source-$VERSION.tar.gz\`
- The mutable \`stable\` tag is not updated by this release workflow.
EOF

#!/bin/bash
set -e

# === INPUT ARGS ===
REGISTRY="$1"
NAMESPACE="$2"
IMAGE_NAME="$3"
CONTEXT_DIR="${4:-.}"

if [[ -z "$REGISTRY" || -z "$NAMESPACE" || -z "$IMAGE_NAME" ]]; then
  echo "Usage: $0 <registry> <namespace> <image> [context]"
  exit 1
fi

# === VERSION ===
version=$(node -p "require('./package.json').version")

image="$REGISTRY/$NAMESPACE/$IMAGE_NAME"

echo "Building: $image:$version (context: $CONTEXT_DIR)"

# === BUILD ===
docker build --network=host -t "$image:$version" "$CONTEXT_DIR"

# === GHCR IS DEV ONLY ===
# Releases on GHCR (the version tag and :latest) come from GitHub Actions
# (publish-docker.yml). A local build there pushes :dev and nothing else, so
# it can never overwrite what release users pull.
if [[ "$REGISTRY" == "ghcr.io" ]]; then
  docker tag "$image:$version" "$image:dev"
  docker push "$image:dev"
  exit 0
fi

# === TAG LOGIC ===
if [[ "$version" == *dev* || "$version" == *alpha* || "$version" == *beta* || "$version" == *rc* ]]; then
  docker tag "$image:$version" "$image:dev"
  docker push "$image:dev"
else
  docker tag "$image:$version" "$image:latest"
  docker push "$image:latest"
fi

# === ALWAYS PUSH VERSION ===
docker push "$image:$version"

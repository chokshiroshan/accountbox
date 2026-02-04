#!/usr/bin/env bash
# Build Lambda function for release notifier

set -euo pipefail

LAMBDA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$LAMBDA_DIR/release-notifier.js"
OUTPUT="$LAMBDA_DIR/release-notifier.zip"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Building Lambda function...${NC}"

# Create temp directory for build
BUILD_DIR=$(mktemp -d)
trap "rm -rf $BUILD_DIR" EXIT

# Copy source to build directory
cp "$SOURCE" "$BUILD_DIR/index.js"

# Create zip file
cd "$BUILD_DIR"
zip -r "$OUTPUT" index.js

echo -e "${GREEN}✓ Lambda package created: $OUTPUT${NC}"

ls -lh "$OUTPUT"

#!/usr/bin/env bash
# Accountbox Deployment Script
# Handles deployment to different environments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ ${NC}$1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }

# Parse arguments
ENVIRONMENT="${1:-production}"
DRY_RUN="${2:-false}"

# Get version from package.json
VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version")

# Validate environment
validate_environment() {
    case "$ENVIRONMENT" in
        staging|production)
            log_info "Deploying to: $ENVIRONMENT"
            ;;
        *)
            log_error "Invalid environment: $ENVIRONMENT"
            log_info "Valid environments: staging, production"
            exit 1
            ;;
    esac
}

# Pre-flight checks
preflight_checks() {
    log_info "Running pre-flight checks..."

    # Check for uncommitted changes
    if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]]; then
        log_error "Uncommitted changes detected"
        log_info "Commit or stash changes before deploying"
        exit 1
    fi

    # Check if on main branch for production
    if [[ "$ENVIRONMENT" == "production" ]]; then
        local branch=$(git -C "$PROJECT_ROOT" branch --show-current)
        if [[ "$branch" != "main" ]]; then
            log_warn "Not on main branch (current: $branch)"
            read -p "Continue anyway? (y/N) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    fi

    log_success "Pre-flight checks passed"
}

# Run tests before deployment
run_tests() {
    log_info "Running tests..."

    cd "$PROJECT_ROOT"

    if [[ -f "package.json" ]] && grep -q '"test"' package.json; then
        if npm test; then
            log_success "Tests passed"
        else
            log_error "Tests failed"
            exit 1
        fi
    else
        log_warn "No test script configured, skipping"
    fi
}

# Build the package
build_package() {
    log_info "Building package..."

    cd "$PROJECT_ROOT"

    if [[ -f "package.json" ]] && grep -q '"build"' package.json; then
        if npm run build; then
            log_success "Build successful"
        else
            log_error "Build failed"
            exit 1
        fi
    else
        log_info "No build script configured"
    fi

    # Create npm package
    if npm pack; then
        log_success "Package created: accountbox-$VERSION.tgz"
    else
        log_error "Failed to create package"
        exit 1
    fi
}

# Deploy to npm
deploy_npm() {
    log_info "Deploying to npm..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log_warn "DRY RUN: Skipping npm publish"
        return
    fi

    local npm_tag=""
    if [[ "$ENVIRONMENT" == "staging" ]]; then
        npm_tag="--tag next"
    fi

    cd "$PROJECT_ROOT"

    if npm publish $npm_tag; then
        log_success "Published to npm as accountbox@$VERSION"
    else
        log_error "Failed to publish to npm"
        exit 1
    fi
}

# Create GitHub release
create_github_release() {
    log_info "Creating GitHub release..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log_warn "DRY RUN: Skipping GitHub release"
        return
    fi

    local tag="v$VERSION"

    # Check if tag exists
    if git rev-parse "$tag" >/dev/null 2>&1; then
        log_warn "Tag $tag already exists"
        return
    fi

    # Create and push tag
    if git tag -a "$tag" -m "Release $VERSION" && git push origin "$tag"; then
        log_success "Tag $tag created and pushed"
    else
        log_error "Failed to create tag"
        exit 1
    fi

    # GitHub Actions will handle the actual release
    log_info "GitHub Actions will create the release from tag $tag"
}

# Update Homebrew formula
update_homebrew() {
    log_info "Homebrew formula will be updated by GitHub Actions..."
    log_info "Formula: accountbox.rb"
}

# Rollback function
rollback() {
    log_error "Deployment failed, attempting rollback..."
    log_info "Manual rollback required"
    log_info "To rollback npm publish: npm deprecate accountbox@$VERSION 'Rolled back'"
}

# Post-deployment verification
verify_deployment() {
    log_info "Verifying deployment..."

    # Wait for npm to propagate
    sleep 10

    if npm view accountbox@"$VERSION" >/dev/null 2>&1; then
        log_success "Version $VERSION is available on npm"
    else
        log_warn "Version not immediately available on npm (may take a few minutes)"
    fi
}

# Send notification
send_notification() {
    log_info "Deployment notification..."
    log_success "Accountbox v$VERSION deployed to $ENVIRONMENT"
}

# Main deployment flow
main() {
    log_info "Accountbox Deployment: v$VERSION → $ENVIRONMENT"
    echo ""

    if [[ "$DRY_RUN" == "true" ]]; then
        log_warn "DRY RUN MODE - No changes will be made"
        echo ""
    fi

    validate_environment
    preflight_checks
    run_tests
    build_package
    deploy_npm
    create_github_release
    update_homebrew
    verify_deployment
    send_notification

    echo ""
    log_success "Deployment complete!"
}

# Error handling
trap rollback ERR

# Run main function
main "$@"

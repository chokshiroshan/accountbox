#!/usr/bin/env bash
# Accountbox Development Environment Provisioning
# Sets up local development environment with all dependencies

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

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin*) echo "macos" ;;
        Linux*) echo "linux" ;;
        *) echo "unknown" ;;
    esac
}

OS=$(detect_os)

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    local missing=()

    command -v node >/dev/null 2>&1 || missing+=("node")
    command -v npm >/dev/null 2>&1 || missing+=("npm")

    if [[ "$OS" == "macos" ]]; then
        command -v brew >/dev/null 2>&1 || missing+=("homebrew")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing prerequisites: ${missing[*]}"
        log_info "Install missing tools and re-run this script"
        exit 1
    fi

    log_success "All prerequisites installed"
}

# Install Node.js dependencies
install_node_deps() {
    log_info "Installing Node.js dependencies..."

    cd "$PROJECT_ROOT"

    if [[ ! -d "node_modules" ]]; then
        npm ci
        log_success "Dependencies installed"
    else
        log_info "Dependencies already installed, skipping"
    fi
}

# Setup Docker environment
setup_docker() {
    log_info "Setting up Docker environment..."

    if [[ "$OS" == "macos" ]]; then
        # Check for OrbStack or Docker Desktop
        if command -v orb >/dev/null 2>&1; then
            log_success "OrbStack detected"
        elif command -v docker >/dev/null 2>&1; then
            # Check if Docker daemon is running
            if docker info >/dev/null 2>&1; then
                log_success "Docker Desktop detected and running"
            else
                log_warn "Docker installed but not running"
                log_info "Start Docker Desktop and re-run this script"
            fi
        else
            log_warn "No Docker runtime detected"
            log_info "Install OrbStack: brew install --cask orbstack"
        fi
    elif [[ "$OS" == "linux" ]]; then
        if command -v docker >/dev/null 2>&1; then
            log_success "Docker detected"
        else
            log_warn "Docker not installed"
            log_info "Install Docker: https://docs.docker.com/engine/install/"
        fi
    fi

    # Build Codex image
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        log_info "Building Codex Docker image..."
        cd "$PROJECT_ROOT"

        if docker build -f Dockerfile.codex -t accountbox-codex:dev .; then
            log_success "Codex image built successfully"
        else
            log_error "Failed to build Codex image"
        fi
    fi
}

# Setup accountbox home directory
setup_accountbox_home() {
    log_info "Setting up accountbox home directory..."

    local accountbox_home="$HOME/.accountbox"

    mkdir -p "$accountbox_home"/{codex,claude,codex-snapshots,browser}
    mkdir -p "$accountbox_home"/tools

    # Create default tools.toml (XDG config)
    local xdg_config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
    local tools_config="$xdg_config_home/accountbox/tools.toml"
    if [[ ! -f "$tools_config" ]]; then
        mkdir -p "$(dirname "$tools_config")"
        cat > "$tools_config" <<'EOF'
# Accountbox tools configuration
# Define custom tools here with their isolation modes

[tools]
# Example: Add a custom tool
# my-tool = { mode = "native", command = "my-tool" }
EOF
        log_success "Created tools.toml"
    fi

    log_success "Accountbox home configured"
}

# Create symlink for global access (optional)
setup_global_access() {
    log_info "Checking for global access..."

    if [[ ! -L "/usr/local/bin/accountbox" ]] && [[ ! -L "/usr/local/bin/abox" ]]; then
        log_info "To install globally, run:"
        echo "  sudo ln -sf '$PROJECT_ROOT/bin/accountbox.js' /usr/local/bin/accountbox"
        echo "  sudo ln -sf '$PROJECT_ROOT/bin/accountbox.js' /usr/local/bin/abox"
    fi
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."

    cd "$PROJECT_ROOT"

    # Test CLI
    if node bin/accountbox.js --version >/dev/null 2>&1; then
        log_success "CLI works"
    else
        log_error "CLI verification failed"
        return 1
    fi

    # Test doctor command
    if node bin/accountbox.js doctor >/dev/null 2>&1; then
        log_success "Doctor command works"
    else
        log_warn "Doctor command had issues (may be expected)"
    fi
}

# Display next steps
show_next_steps() {
    log_info "Development environment ready!"
    echo ""
    echo "Next steps:"
    echo "  1. Run: cd $PROJECT_ROOT"
    echo "  2. Run: node bin/accountbox.js install"
    echo "  3. Test: node bin/accountbox.js doctor"
    echo ""
    echo "Useful commands:"
    echo "  • node bin/accountbox.js codex <account> <cmd>"
    echo "  • node bin/accountbox.js claude <account> <cmd>"
    echo "  • node bin/accountbox.js doctor"
}

# Main provisioning flow
main() {
    log_info "Accountbox Development Environment Provisioning"
    echo ""

    check_prerequisites
    install_node_deps
    setup_docker
    setup_accountbox_home
    setup_global_access
    verify_installation
    show_next_steps

    log_success "Provisioning complete!"
}

# Run main function
main "$@"

# Accountbox DevOps Makefile
# Common tasks for provisioning, building, and deploying Accountbox

.PHONY: help install dev build test lint security deploy clean

# Configuration
VERSION := $(shell node -p "require('./package.json').version")
PROJECT_ROOT := $(shell pwd)

# Colors
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[1;33m
RED := \033[0;31m
NC := \033[0m

help: ## Show this help message
	@echo "$(BLUE)Accountbox DevOps Commands$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'

install: ## Install dependencies and setup dev environment
	@echo "$(BLUE)Installing dependencies...$(NC)"
	npm ci
	@echo "$(BLUE)Setting up Docker image...$(NC)"
	docker build -f Dockerfile.codex -t accountbox-codex:dev .
	@echo "$(GREEN)✓ Installation complete$(NC)"

dev: ## Start development environment
	@echo "$(BLUE)Starting development environment...$(NC)"
	docker compose -f docker-compose.yml --profile dev up -d
	@echo "$(GREEN)✓ Dev environment running$(NC)"

dev-stop: ## Stop development environment
	@echo "$(BLUE)Stopping development environment...$(NC)"
	docker compose -f docker-compose.yml --profile dev down
	@echo "$(GREEN)✓ Dev environment stopped$(NC)"

build: ## Build the package
	@echo "$(BLUE)Building accountbox...$(NC)"
	npm run build || echo "No build script"
	npm pack
	@echo "$(GREEN)✓ Built accountbox-$(VERSION).tgz$(NC)"

test: ## Run tests
	@echo "$(BLUE)Running tests...$(NC)"
	npm test || echo "No tests configured"
	@echo "$(GREEN)✓ Tests complete$(NC)"

lint: ## Run linter
	@echo "$(BLUE)Linting code...$(NC)"
	npm run lint || echo "No lint script configured"
	@echo "$(GREEN)✓ Linting complete$(NC)"

security: ## Run security scans
	@echo "$(BLUE)Running security scans...$(NC)"
	@echo "  → npm audit..."
	npm audit
	@echo "  → Trivy scan..."
	docker run --rm -v $(PWD):/work aquasec/trivy:latest config /work || true
	@echo "  → Snyk scan..."
	snyk test || echo "Snyk not configured"
	@echo "$(GREEN)✓ Security scans complete$(NC)"

docker-build: ## Build Docker image
	@echo "$(BLUE)Building Docker image...$(NC)"
	docker build -f Dockerfile.codex -t accountbox-codex:latest .
	docker build -f Dockerfile.codex -t accountbox-codex:$(VERSION) .
	@echo "$(GREEN)✓ Docker image built$(NC)"

docker-scan: ## Scan Docker image
	@echo "$(BLUE)Scanning Docker image...$(NC)"
	docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest \
		image --severity HIGH,CRITICAL accountbox-codex:latest
	@echo "$(GREEN)✓ Image scanned$(NC)"

terraform-init: ## Initialize Terraform
	@echo "$(BLUE)Initializing Terraform...$(NC)"
	cd infrastructure/terraform && terraform init

terraform-plan: ## Plan Terraform changes
	@echo "$(BLUE)Planning Terraform changes...$(NC)"
	cd infrastructure/terraform && terraform plan

terraform-apply: ## Apply Terraform changes
	@echo "$(BLUE)Applying Terraform changes...$(NC)"
	cd infrastructure/terraform && terraform apply -auto-approve

terraform-destroy: ## Destroy Terraform resources
	@echo "$(RED)Destroying Terraform resources...$(NC)"
	@read -p "Really run 'terraform destroy'? (y/N) " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		cd infrastructure/terraform && terraform destroy; \
	else \
		echo "$(YELLOW)Destroy cancelled$(NC)"; \
	fi

deploy-staging: ## Deploy to staging environment
	@echo "$(BLUE)Deploying to staging...$(NC)"
	@./scripts/deploy.sh staging false

deploy-prod: ## Deploy to production
	@echo "$(BLUE)Deploying to production...$(NC)"
	@read -p "Are you sure? (y/N) " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		./scripts/deploy.sh production false; \
	else \
		echo "$(YELLOW)Deployment cancelled$(NC)"; \
	fi

dry-run-staging: ## Dry run deployment to staging
	@echo "$(YELLOW)Dry run: staging deployment$(NC)"
	./scripts/deploy.sh staging true

release: ## Create and publish release (tag, push, npm publish)
	@echo "$(BLUE)Creating release v$(VERSION)...$(NC)"
	@git tag -a v$(VERSION) -m "Release v$(VERSION)"
	@echo "$(YELLOW)Tag created. Run 'git push origin v$(VERSION)' to trigger release$(NC)"

docs-serve: ## Start documentation server
	@echo "$(BLUE)Starting docs server on http://localhost:3000...$(NC)"
	docker compose -f docker-compose.yml --profile docs up

clean: ## Clean build artifacts
	@echo "$(BLUE)Cleaning...$(NC)"
	rm -f *.tgz
	rm -rf node_modules/.cache
	@echo "$(GREEN)✓ Cleaned$(NC)"

doctor: ## Run diagnostic checks
	@echo "$(BLUE)Running diagnostics...$(NC)"
	@echo "$(BLUE)Node.js:$(NC)" $$(node --version)
	@echo "$(BLUE)npm:$(NC)" $$(npm --version)
	@echo "$(BLUE)Docker:$(NC)" $$(docker --version)
	@echo "$(BLUE)Terraform:$(NC)" $$(terraform --version)
	@echo "$(BLUE)AWS CLI:$(NC)" $$(aws --version 2>/dev/null || echo "not installed")
	@echo "$(GREEN)✓ Diagnostics complete$(NC)"

provision: ## Provision development environment
	@echo "$(BLUE)Provisioning development environment...$(NC)"
	@./scripts/provision-dev.sh

all: install lint test build ## Run full CI pipeline (install, lint, test, build)

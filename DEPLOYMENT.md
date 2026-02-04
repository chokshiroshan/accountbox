# Accountbox — Release & Infrastructure Notes

Accountbox is primarily a **local CLI**. Most users only need `README.md`.

This file is for maintainers: how to run the repo’s “CI-ish” checks locally, build the Codex image, and (optionally) manage the Terraform stack under `infrastructure/`.

## Local checks

```bash
npm ci
node bin/accountbox.js --help
node bin/accountbox.js doctor

# Validate Codex image
docker build -f Dockerfile.codex -t accountbox-codex:test .
docker run --rm accountbox-codex:test -V
```

## Release (npm + GitHub)

This repo ships via tags (`vX.Y.Z`) and GitHub Actions (`.github/workflows/release.yml`).

Suggested flow:
1. Update `CHANGELOG.md`
2. Bump `package.json` version
3. Create a tag and push it:
   ```bash
   git tag -a v0.1.1 -m "Release v0.1.1"
   git push origin v0.1.1
   ```

## GitHub Actions secrets

Required for releasing to npm:
- `NPM_TOKEN`

Used by infrastructure workflows (optional):
- `AWS_ROLE_ARN`

Optional security tooling:
- `SNYK_TOKEN` (only if you want Snyk in CI)

Optional infra notification Lambda:
- `SLACK_WEBHOOK_URL`

## Terraform (optional)

Terraform lives under `infrastructure/terraform/`. It is a template stack that provisions:
- an ECR repo (with scan-on-push + lifecycle policy)
- optional CloudWatch alarm + SNS topic
- optional release-notifier Lambda (Slack webhook)

State is configured to use S3 + DynamoDB locking. Bootstrap the state bucket/table once:

```bash
cd infrastructure/terraform/bootstrap
terraform init
terraform apply
```

Then manage the main stack:

```bash
make terraform-init
make terraform-plan
make terraform-apply
```

## Troubleshooting

- **Docker build fails**: rebuild the Codex image (`make docker-build`). If Codex can’t talk to `chatgpt.com` from the container, ensure `ca-certificates` are installed in the image (`Dockerfile.codex`).
- **Terraform state locked**: `terraform force-unlock <LOCK_ID>` (use with care).
- **npm publish fails**: `npm whoami` then `npm login`.

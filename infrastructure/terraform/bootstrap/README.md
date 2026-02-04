# Terraform bootstrap (remote state)

This folder provisions the **Terraform remote state** resources:
- S3 bucket: `accountbox-terraform-state`
- DynamoDB table: `accountbox-terraform-locks`

You run this **once per AWS account/region**.

## Usage

```bash
cd infrastructure/terraform/bootstrap
terraform init
terraform apply
```

After this succeeds, go back to the main stack:

```bash
cd ../
terraform init
terraform apply -var environment=staging
```

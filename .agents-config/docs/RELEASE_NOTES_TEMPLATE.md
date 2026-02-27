# {{VERSION}} Release Notes - {{RELEASE_DATE}}

## Release Summary
{{RELEASE_SUMMARY}}

## Fixed
{{FIXED_ITEMS}}

## Added
{{ADDED_ITEMS}}

## Changed
{{CHANGED_ITEMS}}

## Admin/Operations
{{ADMIN_ITEMS}}

## Deployment and Distribution
- Docker image: `ghcr.io/soundspan/soundspan:{{VERSION}}`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`
- Helm install/upgrade:

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version {{VERSION}}
```

## Breaking Changes
{{BREAKING_ITEMS}}

## Known Issues
{{KNOWN_ISSUES}}

## Compatibility and Migration
{{COMPATIBILITY_AND_MIGRATION}}

## Full Changelog
{{COMPARE_URL}}
{{FULL_CHANGELOG_URL}}

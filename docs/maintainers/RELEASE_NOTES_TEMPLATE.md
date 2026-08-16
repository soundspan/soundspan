# [{{VERSION}}] Release Notes - {{RELEASE_DATE}}

## Release Summary

{{RELEASE_SUMMARY}}

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to {{VERSION}}. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

{{UPGRADE_NOTES}}

## Fixed

{{FIXED_ITEMS}}

## Added

{{ADDED_ITEMS}}

## Changed

{{CHANGED_ITEMS}}

## Removed

{{REMOVED_ITEMS}}

## Accessibility

{{ACCESSIBILITY_ITEMS}}

## Admin/Operations

{{ADMIN_ITEMS}}

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

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

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install {{VERSION}}. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: {{COMPARE_URL}}
- Full changelog: {{FULL_CHANGELOG_URL}}

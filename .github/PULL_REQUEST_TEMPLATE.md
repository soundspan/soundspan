## Summary

<!-- Briefly describe what this PR changes and why. -->

## Template Impact

Template-Impact: yes|none
Template-Ref:
Template-Impact-Reason:

<!--
Rules:
- If this PR changes meaningful agent workflow paths, set `Template-Impact: yes`
  and provide a `Template-Ref` (template PR/commit/ref).
- If this PR does not need template updates, set `Template-Impact: none`
  and provide a concise `Template-Impact-Reason`.
-->

## Type of Change

-   [ ] Bug fix (non-breaking change that fixes an issue)
-   [ ] New feature (non-breaking change that adds functionality)
-   [ ] Enhancement (improvement to existing functionality)
-   [ ] Documentation update
-   [ ] Code cleanup / refactoring
-   [ ] Other (please describe):

## Related Issues

Fixes #

## Changes Made

-
-
-

## Verification

-   [ ] `node .agents-config/scripts/enforce-agent-policies.mjs`
-   [ ] `npm run agent:managed -- --mode check`
-   [ ] `npm run agent:preflight`
-   [ ] Additional targeted checks (list below)

## Additional Verification Details

-

## Screenshots (if applicable)

## Checklist

-   [ ] My code follows the project's code style
-   [ ] I have tested my changes locally
-   [ ] I have updated documentation if needed
-   [ ] My changes don't introduce new warnings
-   [ ] This PR targets the `main` branch

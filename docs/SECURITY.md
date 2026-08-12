# Security scanning policy

## Python dependency audit exceptions

The `pip-audit` CI job is blocking. Each hash-pinned runtime lock is audited
without dependency resolution, and unexpected advisory IDs fail the job. The
exact temporary exceptions live beside their matrix lanes in
[`security-scanning.yml`](../.github/workflows/security-scanning.yml).

Two legacy TensorFlow lanes have compatibility exceptions:

| Lock | Constrained packages | Removal condition |
| --- | --- | --- |
| `services/audio-analyzer/requirements.lock` | Keras 2.15 and protobuf 4.25 | Move the analyzer off TensorFlow 2.15, whose dependency constraints prevent the audited fixed major versions (shares the AIO lane's exceptions after the roadmap F51 Python 3.11 rebase). |
| `requirements-aio.lock` | Keras 2.15 and protobuf 4.25 | Move the AIO analyzer off TensorFlow 2.15, whose dependency constraints prevent the audited fixed major versions. |

These entries are compatibility risk acceptances, not declarations that the
affected releases are safe. Lock regeneration is performed with `uv pip
compile --upgrade-package`; if the resolver can select a compatible fixed
release, remove the corresponding advisory ID in the same change. New IDs are
never added automatically.

## npm dependency audit exception

The backend dependency graph currently resolves `uuid` 8.3.2 through Bull 4
and its Bull Board integration. This is an owned, temporary exception:

| Advisory | Reachability assessment | Removal condition |
| --- | --- | --- |
| [`GHSA-w5hq-g745-h8pq`](https://github.com/advisories/GHSA-w5hq-g745-h8pq) (`uuid <11.1.1`) | The affected UUID v3, v5, and v6-with-caller-buffer paths are not exercised; Bull uses UUID v4 without a caller-provided buffer. | Upgrade Bull and `@bull-board/*` when their dependency graph can resolve a fixed `uuid`, then remove the exception. |

`npm audit fix --force` is not an acceptable remediation: it proposes
downgrading Bull to 1.1.3, which is a breaking queue-runtime change. Revisit
this exception whenever Bull or Bull Board is upgraded, even if the transitive
`uuid` range does not change.

## Container-image scan stream

Trivy image SARIF currently reports approximately 95 OS and package CVEs in the
pinned analyzer and sidecar images, including findings in `keras`, `wandb`,
`pip`, and `cryptography`. Under the repository's pinned-analyzer-stack policy,
maintainers review these findings with a tested stack or base-image upgrade
rather than dismissing individual alerts ad hoc.

This stream is separate from dependency-lock auditing. The compatibility-owned
Python advisories and their removal conditions remain in the
[pip-audit exception table](#python-dependency-audit-exceptions) above.

## CodeQL alert dismissal record

All open CodeQL alerts were triaged before the 2.0.0 release: 33 were fixed in
code and 45 were dismissed with per-alert justifications recorded on each alert
in the GitHub code-scanning UI (2026-08-12). Dismissals fall into the classes
below; re-evaluate them whenever the cited guard modules change materially.

| Reason | Rule | Alerts | Class justification |
| --- | --- | --- | --- |
| false positive | `js/bad-tag-filter` | #1173 | Release-notes tag filter only classifies repository-owned changelog content during release staging; no untrusted HTML is processed. |
| false positive | `js/incomplete-multi-character-sanitization` | #1172 | Transformed description is rendered as a React text child (no dangerouslySetInnerHTML); React escaping applies. |
| false positive | `js/incomplete-url-substring-sanitization` | #138, #139, #145, #1170 | Substring check is a fail-closed exclusion or non-authorizing classification helper; accepted inputs are reduced to allowlisted IDs or validated URLs. |
| false positive | `js/insufficient-password-hash` | #213 | SHA-256 over high-entropy random API keys; a password KDF is unnecessary for non-memorable secrets. |
| false positive | `js/missing-token-validation` | #134 | Session cookies are HttpOnly and SameSite=Lax, and API-key/bearer authentication requires explicit headers; state-changing routes are not cookie-only reachable cross-site. |
| false positive | `js/request-forgery` | #190, #191, #196, #197, #204, #205, #206, #207, #208, #209, #210, #1156, #1158, #1159, #1163, #1230, #1243, #1244 | Outbound URL reaches a fixed-baseURL internal sidecar client or passes the outbound URL-safety guard before the request; destination host is not attacker-controllable. |
| false positive | `py/incomplete-url-substring-sanitization` | #109 | Fail-closed exclusion; accepted inputs reduced to allowlisted IDs and reconstructed onto literal youtube.com URLs. |
| false positive | `py/path-injection` | #116, #117, #118, #1154, #1155 | Paths are resolved and contained under the service storage root before filesystem access. |
| used in tests | `js/incomplete-url-substring-sanitization` | #140, #141, #142, #143, #144 | Pattern appears in test fixtures/mocks only; no attacker-controlled destination is requested. |
| used in tests | `js/shell-command-injection-from-environment` | #1237 | CI assertion intentionally executes a bounded startup script extracted from a rendered, repository-owned Helm manifest; no external input reaches the shell. |
| won't fix | `js/insufficient-password-hash` | #1171 | Subsonic protocol token derivation (dedicated password), or SHA-256 over high-entropy random API keys where a KDF is unnecessary. |
| won't fix | `js/sensitive-get-query` | #1168, #1169, #1238, #1239, #1240 | OpenSubsonic protocol mandates GET token authentication; mitigated by the documented dedicated-password posture. |
| won't fix | `js/weak-cryptographic-algorithm` | #1167 | OpenSubsonic mandates MD5(password+salt) token auth; dedicated password documented. |

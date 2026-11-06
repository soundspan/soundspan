# Security scanning policy

## Python dependency audit exceptions

The `pip-audit` CI job is blocking. Each hash-pinned runtime lock is audited
without dependency resolution, and unexpected advisory IDs fail the job. Any
temporary exception lives beside its matrix lane in
[`security-scanning.yml`](../.github/workflows/security-scanning.yml).

No lane carries an exception. The analyzer and AIO images must not install the
Python `tensorflow` package: Essentia runs MusiCNN through its own bundled
TensorFlow C runtime, and the Python package pins Keras and protobuf releases
whose advisories cannot be fixed inside its version constraints.

An exception is a compatibility risk acceptance, not a declaration that the
affected release is safe. Add one only with a reachability assessment and a
removal condition recorded here. Lock regeneration is performed with `uv pip
compile --upgrade-package`; if the resolver can select a compatible fixed
release, remove the corresponding advisory ID in the same change. New IDs are
never added automatically.

## npm dependency overrides

The backend dependency graph receives the `uuid` `^8.3.2` range through Bull 4
and resolves it to `11.1.1` through a temporary override. The complete active
register and removal policy live in
[`DEPENDENCY_OVERRIDES.md`](DEPENDENCY_OVERRIDES.md).

| Advisory | Reachability assessment | Removal condition |
| --- | --- | --- |
| [`GHSA-w5hq-g745-h8pq`](https://github.com/advisories/GHSA-w5hq-g745-h8pq) (`uuid <11.1.1`) | The affected UUID v3, v5, and v6-with-caller-buffer paths are not exercised; Bull uses UUID v4 without a caller-provided buffer. | Upgrade Bull when its dependency graph can resolve a fixed `uuid`, then remove the override. |
| [`GHSA-3g3m-2fjr-6pw4`](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) (`glob <14.0.2`) | The AbortSignal bypass needs a caller that cancels a glob walk; `swagger-jsdoc` runs `glob.sync` over fixed route patterns at startup and passes no signal. The override still moves every copy to a fixed release. | Upgrade `swagger-jsdoc` and Jest when their ranges resolve a fixed `glob`, then remove the override. |
| [`GHSA-g3hv-75wg-m249`](https://github.com/advisories/GHSA-g3hv-75wg-m249) (`minimatch <11.0.1`) | The DoS needs an attacker-controlled pattern; archiver's `readdir-glob` only runs for `glob()`/`directory()`, and soundspan only calls `append()`. The override still moves every copy to a fixed release. | Upgrade `archiver`/`readdir-glob`, Jest, and ESLint when their ranges resolve a fixed `minimatch`, then remove the override. |

`npm audit fix --force` is not an acceptable remediation when it proposes a
breaking direct-dependency change. Revisit the override whenever Bull or Bull
Board is upgraded, even if the transitive `uuid` range does not change.

## Container-image scan stream

Trivy image SARIF reports OS and package CVEs in the published images. Under
the repository's pinned-analyzer-stack policy, maintainers review these findings
with a tested stack or base-image upgrade rather than dismissing individual
alerts ad hoc. Accepted image findings are listed with their rationale in
[`.trivyignore`](../.trivyignore).

This stream is separate from dependency-lock auditing, which follows the
[pip-audit policy](#python-dependency-audit-exceptions) above.

## CodeQL alert dismissal record

Every CodeQL alert is triaged: fixed in code, or dismissed with a per-alert
justification recorded on the alert in the GitHub code-scanning UI. Open alerts
are a merge gate, not a backlog. Dismissals fall into the classes
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

# Upgrading soundspan

Operator-facing notes for upgrades that need action. Newest first. If a release
isn't listed here, the upgrade is drop-in.

---

## Helm: chart-managed secrets are now stable across upgrades (F22)

**Who this affects:** Helm installs that let the chart auto-generate secrets —
i.e. you did **not** set `secrets.existingSecret` and did **not** pin every
`secrets.*` value in your values.

**What changed.** The chart previously re-rolled `SESSION_SECRET`,
`SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, and `POSTGRES_PASSWORD` on
**every** `helm upgrade` (a bare `default (randAlphaNum …)` re-renders each
time). A routine upgrade therefore:

- invalidated every session/JWT (users logged out),
- made all AES-encrypted settings (Lidarr, OAuth, Subsonic, 2FA secrets)
  **undecryptable**, and
- desynced `POSTGRES_PASSWORD` from the already-initialized Postgres data dir.

The chart now looks up the **existing** in-cluster Secret and reuses its values,
generating only on first install. Per key the precedence is: explicit
`values.secrets.*` → value already in the live Secret → freshly generated.

**Action required: none for the upgrade itself** — your live secret values are
now frozen at their current values. This upgrade *stops* the rotation; it does
not change any value.

**If a prior upgrade already rotated your keys** (symptoms: everyone logged out
after an upgrade, or integrations/2FA suddenly blank or throwing decrypt
errors), the data encrypted under the lost `SETTINGS_ENCRYPTION_KEY` is **not
recoverable**. Remediation:

1. Re-enter your Lidarr / OAuth / Subsonic credentials in Settings.
2. Re-enroll 2FA for any affected account.
3. If Postgres won't start after a password rotation, set
   `secrets.postgresPassword` to the password baked into your existing PGDATA
   (or reset it inside the database) so the value matches the initialized data
   dir.

**Strongly recommended going forward:** manage secrets yourself and pin
`secrets.existingSecret` to a Secret you control. That removes the chart from
secret generation entirely and is the most robust setup for upgrades, restores,
and multi-environment installs.

**GitOps / client-side rendering caveat.** The reuse path relies on Helm's
`lookup` function, which only executes against a live cluster during a real
`helm install`/`helm upgrade` (or a `--dry-run=server` render). Tooling that
renders client-side — `helm template | kubectl apply`, Flux's
`helm template` mode, ArgoCD's default Helm rendering — gets `lookup → nil`
and **still regenerates all four secrets on every sync**. If you deploy that
way, you must set `secrets.existingSecret` (or pin every `secrets.*` value);
the chart cannot stabilize generated secrets for you.

> **Verifying the fix on a cluster** (optional, for operators). Server-side
> `lookup` only runs against a live cluster, so `helm template` alone can't
> exercise the reuse path — you need `--dry-run=server` (Helm ≥ 3.13). The
> chart looks up the Secret named `<release>-soundspan` (the chart fullname),
> so for a release named `ss` seed `ss-soundspan`. To confirm in an
> **isolated** namespace:
>
> ```sh
> kubectl create namespace ss-upgrade-check
> kubectl -n ss-upgrade-check create secret generic ss-soundspan \
>   --from-literal=SESSION_SECRET=stable-test-value
> # Server-side dry-run executes lookup against the cluster;
> # SESSION_SECRET must come back as the stored value:
> helm upgrade --install ss charts/soundspan --namespace ss-upgrade-check \
>   --dry-run=server | grep 'SESSION_SECRET:'
> kubectl delete namespace ss-upgrade-check
> ```
>
> A reused `stable-test-value` (rather than a fresh random string) proves the
> upgrade will preserve secrets. Never run this against your production
> namespace — it would print the real secret values.

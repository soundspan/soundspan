{{/*
Expand the name of the chart.
*/}}
{{- define "soundspan.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "soundspan.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "soundspan.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "soundspan.labels" -}}
{{- $standardLabels := dict
  "helm.sh/chart" (include "soundspan.chart" .)
  "app.kubernetes.io/managed-by" .Release.Service
-}}
{{- if .Chart.AppVersion }}
{{- $_ := set $standardLabels "app.kubernetes.io/version" .Chart.AppVersion -}}
{{- end }}
{{- $globalLabels := deepCopy (.Values.global.labels | default dict) -}}
{{- $selectorLabels := include "soundspan.selectorLabels" . | fromYaml -}}
{{- mustMergeOverwrite $standardLabels $globalLabels $selectorLabels | toYaml }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "soundspan.selectorLabels" -}}
app.kubernetes.io/name: {{ include "soundspan.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "soundspan.serviceAccountName" -}}
{{- if .Values.global.serviceAccount.create }}
{{- default (include "soundspan.fullname" .) .Values.global.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.global.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name
*/}}
{{- define "soundspan.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "soundspan.fullname" . }}
{{- end }}
{{- end }}

{{/*
Application image reference. A digest takes precedence over the mutable tag.
Usage: include "soundspan.image" .Values.backend.image
*/}}
{{- define "soundspan.image" -}}
{{- $digest := .digest | default "" -}}
{{- if $digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail (printf "image.digest must use sha256:<64 lowercase hexadecimal characters>; got %q" $digest) -}}
{{- end -}}
{{- printf "%s@%s" .repository $digest -}}
{{- else -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}
{{- end }}

{{/*
Complete external PostgreSQL connection URL
*/}}
{{- define "soundspan.databaseUrl" -}}
{{- if .Values.postgresql.external.url -}}
{{- printf "%s" .Values.postgresql.external.url }}
{{- else }}
{{- fail "soundspan.databaseUrl requires a complete postgresql.external.url" }}
{{- end }}
{{- end }}

{{/*
PostgreSQL component host and port used by startup-time DATABASE_URL builders.
*/}}
{{- define "soundspan.databaseHost" -}}
{{- if .Values.postgresql.enabled -}}
{{- printf "%s-postgresql" (include "soundspan.fullname" .) }}
{{- else -}}
{{- printf "%s" .Values.postgresql.external.host }}
{{- end -}}
{{- end }}

{{- define "soundspan.databasePort" -}}
{{- if .Values.postgresql.enabled -}}
{{- .Values.postgresql.port | int }}
{{- else -}}
{{- .Values.postgresql.external.port | int }}
{{- end -}}
{{- end }}

{{/*
Build DATABASE_URL after Kubernetes has populated Secret-backed component env.
The final command is supplied as positional parameters and replaces the shell.
*/}}
{{- define "soundspan.nodeDatabaseUrlStartup" -}}
# soundspan-database-url-start
export DATABASE_URL="$(node -e 'const env = process.env; process.stdout.write("postgresql://" + encodeURIComponent(env.POSTGRES_USER) + ":" + encodeURIComponent(env.POSTGRES_PASSWORD) + "@" + env.SOUNDSPAN_DATABASE_HOST + ":" + env.SOUNDSPAN_DATABASE_PORT + "/" + env.POSTGRES_DB)')"
# soundspan-database-url-end
exec "$@"
{{- end }}

{{- define "soundspan.pythonDatabaseUrlStartup" -}}
# soundspan-database-url-start
export DATABASE_URL="$(python3 -c 'import os; from urllib.parse import quote; env = os.environ; print("postgresql://{}:{}@{}:{}/{}".format(quote(env["POSTGRES_USER"], safe=""), quote(env["POSTGRES_PASSWORD"], safe=""), env["SOUNDSPAN_DATABASE_HOST"], env["SOUNDSPAN_DATABASE_PORT"], env["POSTGRES_DB"]), end="")')"
# soundspan-database-url-end
exec "$@"
{{- end }}

{{/*
Redis connection URL
*/}}
{{- define "soundspan.redisUrl" -}}
{{- if eq .Values.deploymentMode "aio" }}
{{- printf "redis://localhost:6379" }}
{{- else if .Values.redis.external.url }}
{{- printf "%s" .Values.redis.external.url }}
{{- else if .Values.redis.enabled }}
{{- printf "redis://%s-redis:%d" (include "soundspan.fullname" .) (.Values.redis.port | int) }}
{{- else }}
{{- printf "redis://%s:%d" .Values.redis.external.host (.Values.redis.external.port | int) }}
{{- end }}
{{- end }}

{{/*
TIDAL sidecar URL
*/}}
{{- define "soundspan.tidalSidecarUrl" -}}
{{- if .Values.tidalSidecar.enabled }}
{{- printf "http://%s-tidal:%d" (include "soundspan.fullname" .) (.Values.tidalSidecar.port | int) }}
{{- else }}
{{- printf "http://127.0.0.1:8585" }}
{{- end }}
{{- end }}

{{/*
YouTube Music streamer URL
*/}}
{{- define "soundspan.ytmusicStreamerUrl" -}}
{{- if .Values.ytmusicStreamer.enabled }}
{{- printf "http://%s-ytmusic:%d" (include "soundspan.fullname" .) (.Values.ytmusicStreamer.port | int) }}
{{- else }}
{{- printf "http://127.0.0.1:8586" }}
{{- end }}
{{- end }}

{{/*
Component labels helper — adds a component label to the standard set
Usage: include "soundspan.componentLabels" (dict "context" . "component" "backend")
*/}}
{{- define "soundspan.componentLabels" -}}
{{- $labels := include "soundspan.labels" .context | fromYaml -}}
{{- $selectorLabels := include "soundspan.componentSelectorLabels" . | fromYaml -}}
{{- mustMergeOverwrite $labels $selectorLabels | toYaml }}
{{- end }}

{{/*
Component selector labels helper
Usage: include "soundspan.componentSelectorLabels" (dict "context" . "component" "backend")
*/}}
{{- define "soundspan.componentSelectorLabels" -}}
{{ include "soundspan.selectorLabels" .context }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Pod labels helper — user labels are merged before immutable selector labels
Usage: include "soundspan.componentPodLabels" (dict "context" . "component" "backend")
*/}}
{{- define "soundspan.componentPodLabels" -}}
{{- $globalLabels := deepCopy (.context.Values.global.labels | default dict) -}}
{{- $selectorLabels := include "soundspan.componentSelectorLabels" . | fromYaml -}}
{{- mustMergeOverwrite $globalLabels $selectorLabels | toYaml }}
{{- end }}

{{/*
Entry-point service name — the service that ingress/gateway should route to.
In AIO mode this is the single service; in individual mode it's the frontend.
*/}}
{{- define "soundspan.entrypointServiceName" -}}
{{- if eq .Values.deploymentMode "individual" }}
{{- printf "%s-frontend" (include "soundspan.fullname" .) }}
{{- else }}
{{- include "soundspan.fullname" . }}
{{- end }}
{{- end }}

{{/*
HA mode helpers (individual mode only)
*/}}
{{- define "soundspan.haEnabled" -}}
{{- if and (eq .Values.deploymentMode "individual") .Values.haMode.enabled -}}true{{- else -}}false{{- end -}}
{{- end }}

{{- define "soundspan.backendWorkerEnabled" -}}
{{- if eq (include "soundspan.haEnabled" .) "true" -}}
{{- ternary "true" "false" .Values.haMode.backendWorker.enabled -}}
{{- else -}}
{{- ternary "true" "false" .Values.backendWorker.enabled -}}
{{- end -}}
{{- end }}

{{- define "soundspan.backendReplicas" -}}
{{- if eq (include "soundspan.haEnabled" .) "true" -}}
{{- .Values.haMode.backendReplicas | int -}}
{{- else -}}
{{- .Values.backend.replicas | int -}}
{{- end -}}
{{- end }}

{{- define "soundspan.frontendReplicas" -}}
{{- if eq (include "soundspan.haEnabled" .) "true" -}}
{{- .Values.haMode.frontendReplicas | int -}}
{{- else -}}
{{- .Values.frontend.replicas | int -}}
{{- end -}}
{{- end }}

{{- define "soundspan.backendWorkerReplicas" -}}
{{- if eq (include "soundspan.haEnabled" .) "true" -}}
{{- .Values.haMode.backendWorker.replicas | int -}}
{{- else -}}
{{- .Values.backendWorker.replicas | int -}}
{{- end -}}
{{- end }}

{{/*
Render one env entry for an optional third-party API key/token, preferring a
Secret reference over a plaintext value in the pod spec.
Precedence:
  1. explicit per-workload env override (envMap has the var) -> plaintext value
  2. enabled + chart-managed Secret (no existingSecret)      -> secretKeyRef (chart Secret)
  3. enabled + existingSecret + apiKeysInExistingSecret=true  -> secretKeyRef (existing Secret, optional)
  4. enabled + existingSecret (legacy default)               -> plaintext value (back-compat)
  5. not enabled                                             -> nothing
Usage:
  {{ include "soundspan.optionalSecretEnv" (dict "ctx" $ "name" "LIDARR_API_KEY" "secretKey" "LIDARR_API_KEY" "value" $.Values.config.lidarrApiKey "enabled" $.Values.config.lidarrEnabled "envMap" $backendEnv) | nindent 12 }}
*/}}
{{- define "soundspan.optionalSecretEnv" -}}
{{- $ctx := .ctx -}}
{{- $envMap := .envMap | default dict -}}
{{- if hasKey $envMap .name -}}
- name: {{ .name }}
  value: {{ index $envMap .name | quote }}
{{- else if .enabled -}}
{{- if or (not $ctx.Values.secrets.existingSecret) $ctx.Values.secrets.apiKeysInExistingSecret -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "soundspan.secretName" $ctx }}
      key: {{ .secretKey }}
      optional: true
{{- else -}}
- name: {{ .name }}
  value: {{ .value | quote }}
{{- end -}}
{{- end -}}
{{- end }}

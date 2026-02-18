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
helm.sh/chart: {{ include "soundspan.chart" . }}
{{ include "soundspan.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.global.labels }}
{{ toYaml . }}
{{- end }}
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
PostgreSQL connection URL
*/}}
{{- define "soundspan.databaseUrl" -}}
{{- if eq .Values.deploymentMode "aio" }}
{{- printf "postgresql://soundspan:soundspan@localhost:5432/soundspan" }}
{{- else if .Values.postgresql.external.url }}
{{- printf "%s" .Values.postgresql.external.url }}
{{- else if .Values.postgresql.enabled }}
{{- printf "postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@%s-postgresql:%d/$(POSTGRES_DB)" (include "soundspan.fullname" .) (.Values.postgresql.port | int) }}
{{- else }}
{{- printf "postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@%s:%d/$(POSTGRES_DB)" .Values.postgresql.external.host (.Values.postgresql.external.port | int) }}
{{- end }}
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
{{ include "soundspan.labels" .context }}
app.kubernetes.io/component: {{ .component }}
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

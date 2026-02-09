{{/*
Expand the name of the chart.
*/}}
{{- define "gwa.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a sanitized name from repo owner and name.
Converts to lowercase, replaces / and _ with -, truncates to 44 chars.
(44 = 63 - 4 "gwa-" prefix - 15 longest suffix "-actions-runner")
*/}}
{{- define "gwa.sanitizedName" -}}
{{- printf "%s-%s" .Values.repo.owner .Values.repo.name | lower | replace "/" "-" | replace "_" "-" | trunc 44 | trimSuffix "-" }}
{{- end }}

{{/*
Create the full repo identifier (owner/name).
*/}}
{{- define "gwa.fullRepo" -}}
{{- printf "%s/%s" .Values.repo.owner .Values.repo.name }}
{{- end }}

{{/*
Create the full name with gwa prefix.
Truncated to 48 chars to leave room for suffixes like -actions-runner (15 chars).
*/}}
{{- define "gwa.fullname" -}}
{{- printf "gwa-%s" (include "gwa.sanitizedName" .) | trunc 48 | trimSuffix "-" }}
{{- end }}

{{/*
Create the pod name (statefulset pod-0).
*/}}
{{- define "gwa.podName" -}}
{{- printf "%s-0" (include "gwa.fullname" .) }}
{{- end }}

{{/*
Create the namespace name.
*/}}
{{- define "gwa.namespace" -}}
{{- printf "gwa-%s" (include "gwa.sanitizedName" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "gwa.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "gwa.labels" -}}
helm.sh/chart: {{ include "gwa.chart" . }}
{{ include "gwa.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: github-workflow-agents
gwa.io/repo-owner: {{ .Values.repo.owner | quote }}
gwa.io/repo-name: {{ .Values.repo.name | quote }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "gwa.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gwa.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Runner component labels
*/}}
{{- define "gwa.runnerLabels" -}}
{{ include "gwa.labels" . }}
app.kubernetes.io/component: runner
{{- end }}

{{/*
Runner selector labels
*/}}
{{- define "gwa.runnerSelectorLabels" -}}
{{ include "gwa.selectorLabels" . }}
app.kubernetes.io/component: runner
{{- end }}

{{/*
Actions runner component labels
*/}}
{{- define "gwa.actionsRunnerLabels" -}}
{{ include "gwa.labels" . }}
app.kubernetes.io/component: actions-runner
{{- end }}

{{/*
Actions runner selector labels
*/}}
{{- define "gwa.actionsRunnerSelectorLabels" -}}
{{ include "gwa.selectorLabels" . }}
app.kubernetes.io/component: actions-runner
{{- end }}

{{/*
Cleanup component labels
*/}}
{{- define "gwa.cleanupLabels" -}}
{{ include "gwa.labels" . }}
app.kubernetes.io/component: cleanup
{{- end }}

{{/*
Create the image reference.
*/}}
{{- define "gwa.image" -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository .Values.image.tag }}
{{- end }}

{{/*
Create the GitHub repo URL.
*/}}
{{- define "gwa.repoUrl" -}}
{{- printf "https://github.com/%s" (include "gwa.fullRepo" .) }}
{{- end }}

{{/*
Create the OTEL service name based on repo.
*/}}
{{- define "gwa.otelServiceName" -}}
{{- if .Values.otel.serviceName }}
{{- .Values.otel.serviceName }}
{{- else }}
{{- printf "gwa-%s" (include "gwa.sanitizedName" .) }}
{{- end }}
{{- end }}

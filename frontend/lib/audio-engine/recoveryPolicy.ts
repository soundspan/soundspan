export interface LocalRecoverySnapshot {
  positionSec: number;
  shouldPlay: boolean;
}

export interface ServerRecoverySnapshot {
  resumeAtSec?: number;
  shouldPlay?: boolean;
}

export interface LocalAuthoritativeRecoveryDecision {
  resumeAtSec: number;
  shouldPlay: boolean;
  authority: "local";
}

/**
 * Disruption recovery is local-player authoritative by policy.
 * Server hints are accepted for observability but do not override local intent.
 */
export const resolveLocalAuthoritativeRecovery = (
  local: LocalRecoverySnapshot,
  _server?: ServerRecoverySnapshot,
): LocalAuthoritativeRecoveryDecision => ({
  resumeAtSec: Math.max(0, local.positionSec),
  shouldPlay: local.shouldPlay,
  authority: "local",
});

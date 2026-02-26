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
  authority: "local" | "server";
}

/**
 * Disruption recovery is local-player authoritative by policy.
 * If local position is effectively unknown (0s) while server reports a valid
 * resume point, prefer server resume to avoid restart-at-zero regressions.
 */
export const resolveLocalAuthoritativeRecovery = (
  local: LocalRecoverySnapshot,
  server?: ServerRecoverySnapshot,
): LocalAuthoritativeRecoveryDecision => {
  const localResumeAtSec = Math.max(0, local.positionSec);
  const serverResumeAtSec = Number.isFinite(server?.resumeAtSec)
    ? Math.max(0, server?.resumeAtSec ?? 0)
    : null;

  if (localResumeAtSec <= 0 && serverResumeAtSec !== null && serverResumeAtSec > 0) {
    return {
      resumeAtSec: serverResumeAtSec,
      shouldPlay: local.shouldPlay,
      authority: "server",
    };
  }

  return {
    resumeAtSec: localResumeAtSec,
    shouldPlay: local.shouldPlay,
    authority: "local",
  };
};

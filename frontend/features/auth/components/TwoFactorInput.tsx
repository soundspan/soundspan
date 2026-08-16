"use client";

/** Props for the shared local-authentication second-factor control. */
export interface TwoFactorInputProps {
    id: string;
    value: string;
    useRecoveryCode: boolean;
    onValueChange: (value: string) => void;
    onRecoveryCodeChange: (useRecoveryCode: boolean) => void;
}

function normalizeSecondFactor(value: string, recoveryCode: boolean): string {
    return recoveryCode
        ? value
              .replace(/[^A-Fa-f0-9]/g, "")
              .slice(0, 8)
              .toUpperCase()
        : value.replace(/\D/g, "").slice(0, 6);
}

type SecondFactorFieldProps = Omit<TwoFactorInputProps, "onRecoveryCodeChange">;

function SecondFactorField({
    id,
    value,
    useRecoveryCode,
    onValueChange,
}: SecondFactorFieldProps) {
    const label = useRecoveryCode ? "Recovery Code" : "Authentication Code";
    return (
        <div>
            <label
                htmlFor={id}
                className="block text-sm font-medium text-white/90 mb-1.5"
            >
                {label}
            </label>
            <input
                id={id}
                type="text"
                value={value}
                onChange={(event) =>
                    onValueChange(
                        normalizeSecondFactor(
                            event.target.value,
                            useRecoveryCode,
                        ),
                    )
                }
                placeholder={useRecoveryCode ? "ABCD1234" : "000000"}
                maxLength={useRecoveryCode ? 8 : 6}
                required
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                inputMode={useRecoveryCode ? "text" : "numeric"}
                className="w-full px-4 py-2.5 bg-white/5 border border-brand/30 rounded-lg text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-transparent transition-all duration-200 text-center text-2xl tracking-widest"
            />
            <p className="text-xs text-white/50 mt-2">
                {useRecoveryCode
                    ? "Enter your 8-character recovery code"
                    : "Enter the 6-digit code from your authenticator app"}
            </p>
        </div>
    );
}

/** Renders a TOTP input with the existing recovery-code alternative. */
export function TwoFactorInput({
    id,
    value,
    useRecoveryCode,
    onValueChange,
    onRecoveryCodeChange,
}: TwoFactorInputProps) {
    return (
        <div className="space-y-4">
            <SecondFactorField
                id={id}
                value={value}
                useRecoveryCode={useRecoveryCode}
                onValueChange={onValueChange}
            />
            <div className="flex items-center justify-center">
                <button
                    type="button"
                    onClick={() => {
                        onValueChange("");
                        onRecoveryCodeChange(!useRecoveryCode);
                    }}
                    className="text-xs text-brand hover:text-brand-light transition-colors underline"
                >
                    {useRecoveryCode
                        ? "Use authenticator app instead"
                        : "Use recovery code instead"}
                </button>
            </div>
        </div>
    );
}

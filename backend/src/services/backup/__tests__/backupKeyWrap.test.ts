import {
    BackupPassphraseError,
    unwrapEncryptionKey,
    wrapEncryptionKey,
} from "../backupKeyWrap";

describe("backup key wrapping", () => {
    const passphrase = "correct horse battery staple";

    it("round-trips a deployment key", async () => {
        const wrapped = await wrapEncryptionKey("deployment-key", passphrase);
        await expect(unwrapEncryptionKey(wrapped, passphrase)).resolves.toBe(
            "deployment-key",
        );
    });

    it("rejects a wrong passphrase without leaking it", async () => {
        const wrapped = await wrapEncryptionKey("deployment-key", passphrase);
        const wrong = "this passphrase must stay private";
        await expect(
            unwrapEncryptionKey(wrapped, wrong),
        ).rejects.toBeInstanceOf(BackupPassphraseError);
        await unwrapEncryptionKey(wrapped, wrong).catch((error: Error) => {
            expect(error.message).not.toContain(wrong);
        });
    });

    it.each(["too-short", "x".repeat(1025)])(
        "rejects an out-of-range passphrase without leaking it",
        async (invalid) => {
            await expect(
                wrapEncryptionKey("deployment-key", invalid),
            ).rejects.toBeInstanceOf(BackupPassphraseError);
            await wrapEncryptionKey("deployment-key", invalid).catch(
                (error: Error) => expect(error.message).not.toContain(invalid),
            );
        },
    );

    it.each(["salt", "iv", "tag", "ciphertext"] as const)(
        "rejects tampered %s",
        async (field) => {
            const wrapped = await wrapEncryptionKey(
                "deployment-key",
                passphrase,
            );
            const tampered = { ...wrapped, [field]: `${wrapped[field]}A` };
            await expect(
                unwrapEncryptionKey(tampered, passphrase),
            ).rejects.toBeInstanceOf(BackupPassphraseError);
        },
    );
});

import { encryptWithKey } from "../../../utils/encryption";
import { planCredentialReencryption } from "../restoreReencrypt";

const backupKey = "a".repeat(40);
const currentKey = "b".repeat(40);

describe("credential re-encryption planning", () => {
    it("re-encrypts a backup-key value", () => {
        expect(
            planCredentialReencryption(
                encryptWithKey("secret", backupKey),
                backupKey,
                currentKey,
            ).action,
        ).toBe("reencrypt");
    });

    it("skips a value already encrypted by the current key", () => {
        expect(
            planCredentialReencryption(
                encryptWithKey("secret", currentKey),
                backupKey,
                currentKey,
            ),
        ).toEqual({ action: "skip-current" });
    });

    it("counts a value decryptable by neither key", () => {
        expect(
            planCredentialReencryption(
                "v2:broken:value",
                backupKey,
                currentKey,
            ),
        ).toEqual({ action: "undecryptable" });
    });

    it("short-circuits when keys match", () => {
        expect(
            planCredentialReencryption("anything", backupKey, backupKey),
        ).toEqual({ action: "skip-current" });
    });
});

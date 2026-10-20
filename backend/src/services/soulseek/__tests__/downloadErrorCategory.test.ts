import { categorizeDownloadError } from "../downloadErrorCategory";

describe("Soulseek download error categories", () => {
    it.each([
        ["User not exist", "user_offline", true],
        ["Cannot connect to timeout", "user_offline", true],
        ["No address to reach peer", "user_offline", true],
        ["No connection to peer", "user_offline", true],
        ["timeout is not connected", "user_offline", true],
        ["GetPeerAddress timed out for peer", "timeout", true],
        ["ConnectToPeer timed out for peer", "timeout", true],
        ["Download timed out", "timeout", true],
        ["Connection refused by peer", "connection", true],
        ["Transfer interrupted at 1024", "connection", true],
        ["No such file", "file_not_found", true],
        ["File not shared.", "file_not_found", true],
        ["Transfer refused", "refused", true],
        ["Upload denied", "refused", true],
        ["Too many files", "refused", true],
        ["Banned", "refused", true],
        ["Unexpected failure", "unknown", false],
    ])("categorizes '%s' errors", (message, expectedType, expectedSkipUser) => {
        expect(categorizeDownloadError(new Error(message))).toEqual({
            type: expectedType,
            skipUser: expectedSkipUser,
        });
    });
});

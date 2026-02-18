import {
  AppError,
  ErrorCategory,
  ErrorCode,
  isRecoverable,
  isTransient,
  wrapNodeError,
} from "../errors";

describe("AppError", () => {
  it("serializes all expected fields in toJSON", () => {
    const error = new AppError(
      ErrorCode.FILE_NOT_FOUND,
      ErrorCategory.RECOVERABLE,
      "missing track",
      { path: "/music/track.mp3" }
    );

    expect(error.toJSON()).toEqual({
      name: "AppError",
      code: ErrorCode.FILE_NOT_FOUND,
      category: ErrorCategory.RECOVERABLE,
      message: "missing track",
      details: { path: "/music/track.mp3" },
    });
  });
});

describe("isRecoverable", () => {
  it("returns true for recoverable AppError", () => {
    const error = new AppError(
      ErrorCode.FILE_NOT_FOUND,
      ErrorCategory.RECOVERABLE,
      "missing file"
    );

    expect(isRecoverable(error)).toBe(true);
  });

  it("returns false for non-recoverable AppError", () => {
    const error = new AppError(
      ErrorCode.PERMISSION_DENIED,
      ErrorCategory.FATAL,
      "permission denied"
    );

    expect(isRecoverable(error)).toBe(false);
  });
});

describe("isTransient", () => {
  it("returns true for transient AppError", () => {
    const error = new AppError(
      ErrorCode.DISK_FULL,
      ErrorCategory.TRANSIENT,
      "disk is full"
    );

    expect(isTransient(error)).toBe(true);
  });

  it("returns false for non-transient AppError", () => {
    const error = new AppError(
      ErrorCode.FILE_NOT_FOUND,
      ErrorCategory.RECOVERABLE,
      "missing file"
    );

    expect(isTransient(error)).toBe(false);
  });
});

describe("wrapNodeError", () => {
  const buildNodeError = (code: string, message = "node error") => ({ code, message });

  it("wraps ENOENT as recoverable FILE_NOT_FOUND", () => {
    const wrapped = wrapNodeError(buildNodeError("ENOENT", "no such file"), "readSong()");

    expect(wrapped).toEqual(
      new AppError(
        ErrorCode.FILE_NOT_FOUND,
        ErrorCategory.RECOVERABLE,
        "File not found: readSong()",
        { originalError: "no such file" }
      )
    );
  });

  it("wraps EACCES as fatal PERMISSION_DENIED", () => {
    const wrapped = wrapNodeError(buildNodeError("EACCES", "permission denied"), "openTrack()");

    expect(wrapped).toEqual(
      new AppError(
        ErrorCode.PERMISSION_DENIED,
        ErrorCategory.FATAL,
        "Permission denied: openTrack()",
        { originalError: "permission denied" }
      )
    );
  });

  it("wraps EPERM as fatal PERMISSION_DENIED", () => {
    const wrapped = wrapNodeError(buildNodeError("EPERM", "operation not permitted"), "writeCache()");

    expect(wrapped).toEqual(
      new AppError(
        ErrorCode.PERMISSION_DENIED,
        ErrorCategory.FATAL,
        "Permission denied: writeCache()",
        { originalError: "operation not permitted" }
      )
    );
  });

  it("wraps ENOSPC as transient DISK_FULL", () => {
    const wrapped = wrapNodeError(buildNodeError("ENOSPC", "no space"), "flushBuffer()");

    expect(wrapped).toEqual(
      new AppError(
        ErrorCode.DISK_FULL,
        ErrorCategory.TRANSIENT,
        "Disk full: flushBuffer()",
        { originalError: "no space" }
      )
    );
  });

  it("wraps unknown codes as recoverable FILE_READ_ERROR", () => {
    const wrapped = wrapNodeError(buildNodeError("EIO", "input/output error"), "scanFiles()");

    expect(wrapped).toEqual(
      new AppError(
        ErrorCode.FILE_READ_ERROR,
        ErrorCategory.RECOVERABLE,
        "Failed to read file: scanFiles()",
        { originalError: "input/output error" }
      )
    );
  });
});

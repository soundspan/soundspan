/** Safe, typed backup/restore failure suitable for HTTP and job status mapping. */
export class BackupError extends Error {
    constructor(
        public readonly code: string,
        public readonly clientMessage: string,
        options?: ErrorOptions,
    ) {
        super(clientMessage, options);
        this.name = new.target.name;
    }
}

export class BackupFormatError extends BackupError {
    constructor(message = "Backup format is invalid", options?: ErrorOptions) {
        super("BACKUP_FORMAT_INVALID", message, options);
    }
}

export class BackupPassphraseError extends BackupError {
    constructor(options?: ErrorOptions) {
        super(
            "BACKUP_PASSPHRASE_INVALID",
            "The backup passphrase is invalid",
            options,
        );
    }
}

export class BackupBusyError extends BackupError {
    constructor() {
        super("BACKUP_IN_PROGRESS", "A backup is already in progress");
    }
}

export class RestoreError extends BackupError {}

export class RestoreMigrationError extends RestoreError {
    constructor(
        public readonly outputTail: string,
        options?: ErrorOptions,
    ) {
        super(
            "RESTORE_MIGRATION_FAILED",
            "Database migration failed during restore",
            options,
        );
    }
}

BEGIN;

-- Pairing now uses administrator-issued host credentials exclusively.
-- Existing FederationPeer rows are unaffected by removing unredeemed codes.
DROP TABLE "FederationPairingCode";

COMMIT;

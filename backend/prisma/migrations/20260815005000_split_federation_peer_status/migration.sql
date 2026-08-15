-- F12 splits independently controlled inbound authentication state from
-- outbound sync/health state. Federation is unreleased, so the ambiguous
-- status column is removed after preserving every existing row's meaning.
ALTER TABLE "FederationPeer"
ADD COLUMN "inboundStatus" "PeerStatus",
ADD COLUMN "outboundStatus" "PeerStatus";

UPDATE "FederationPeer"
SET
    "inboundStatus" = CASE
        WHEN "direction" IN ('HOST', 'BOTH') THEN "status"
        ELSE NULL
    END,
    "outboundStatus" = CASE
        WHEN "direction" IN ('CONSUMER', 'BOTH') THEN "status"
        ELSE NULL
    END;

ALTER TABLE "FederationPeer" DROP COLUMN "status";

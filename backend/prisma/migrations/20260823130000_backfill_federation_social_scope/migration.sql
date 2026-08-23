UPDATE "FederationPeer"
SET "scopes" = array_append("scopes", 'social:read')
WHERE "scopes" @> ARRAY['library:read']::TEXT[]
  AND NOT ("scopes" @> ARRAY['social:read']::TEXT[]);

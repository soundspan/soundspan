/** Atomically acquire one group lease before allocating its fencing token. */
export const LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT = `
-- listen-together:acquire-lease-and-fence
local acquired = redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if not acquired then
  return {0, 0}
end
local fencingToken = redis.call('incr', KEYS[2])
return {1, fencingToken}
`;

/** Renew a lease only while its owner token still matches. */
export const LISTEN_TOGETHER_RENEW_LEASE_SCRIPT = `
-- listen-together:renew-owned-lease
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

/** Release a lease only while its owner token still matches. */
export const LISTEN_TOGETHER_RELEASE_LEASE_SCRIPT = `
-- listen-together:release-owned-lease
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/** Verify lease ownership and the currently allocated fencing token. */
export const LISTEN_TOGETHER_VALIDATE_LEASE_SCRIPT = `
-- listen-together:validate-owned-lease
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
if tonumber(redis.call('get', KEYS[2])) ~= tonumber(ARGV[2]) then
  return 0
end
return 1
`;

/** Store a snapshot only for the allocated token and monotonic ordering. */
export const LISTEN_TOGETHER_SET_SNAPSHOT_SCRIPT = `
-- listen-together:set-snapshot-if-current
local key = KEYS[1]
local fenceKey = KEYS[2]
local counterKey = KEYS[3]
local incomingRaw = ARGV[1]
local ttlSeconds = tonumber(ARGV[2])
local incomingStateVersion = tonumber(ARGV[3]) or 0
local incomingServerTime = tonumber(ARGV[4]) or 0
local incomingFence = tonumber(ARGV[5]) or 0

local allocatedRaw = redis.call('get', counterKey)
local allocatedFence = tonumber(allocatedRaw) or 0
if (not allocatedRaw and incomingFence ~= 0) or
   (allocatedRaw and incomingFence ~= allocatedFence) then
  return 0
end
local existingFence = tonumber(redis.call('get', fenceKey)) or 0
if incomingFence < existingFence then
  return 0
end

local existingRaw = redis.call('get', key)
if existingRaw then
  local ok, existing = pcall(cjson.decode, existingRaw)
  if ok and existing and existing.playback then
    local existingStateVersion = tonumber(existing.playback.stateVersion) or 0
    local existingServerTime = tonumber(existing.playback.serverTime) or 0
    if incomingStateVersion < existingStateVersion then
      return 0
    end
    if incomingStateVersion == existingStateVersion and incomingServerTime < existingServerTime then
      return 0
    end
  end
end

redis.call('set', key, incomingRaw, 'EX', ttlSeconds)
redis.call('set', fenceKey, incomingFence, 'EX', ttlSeconds)
return 1
`;

/** Delete a snapshot only for the currently allocated token. */
export const LISTEN_TOGETHER_DELETE_SNAPSHOT_SCRIPT = `
-- listen-together:delete-snapshot-if-current
local key = KEYS[1]
local fenceKey = KEYS[2]
local counterKey = KEYS[3]
local ttlSeconds = tonumber(ARGV[1])
local incomingFence = tonumber(ARGV[2]) or 0
local allocatedRaw = redis.call('get', counterKey)
local allocatedFence = tonumber(allocatedRaw) or 0
local existingFence = tonumber(redis.call('get', fenceKey)) or 0

if (not allocatedRaw and incomingFence ~= 0) or
   (allocatedRaw and incomingFence ~= allocatedFence) or
   incomingFence < existingFence then
  return 0
end

redis.call('del', key)
redis.call('set', fenceKey, incomingFence, 'EX', ttlSeconds)
return 1
`;

/** Claim publication authority only for the currently allocated token. */
export const LISTEN_TOGETHER_CLAIM_FENCE_SCRIPT = `
-- listen-together:claim-publication-fence
local fenceKey = KEYS[1]
local counterKey = KEYS[2]
local ttlSeconds = tonumber(ARGV[1])
local incomingFence = tonumber(ARGV[2]) or 0
local allocatedRaw = redis.call('get', counterKey)
local allocatedFence = tonumber(allocatedRaw) or 0
local existingFence = tonumber(redis.call('get', fenceKey)) or 0

if (not allocatedRaw and incomingFence ~= 0) or
   (allocatedRaw and incomingFence ~= allocatedFence) or
   incomingFence < existingFence then
  return 0
end

redis.call('set', fenceKey, incomingFence, 'EX', ttlSeconds)
return 1
`;

/** Validate a received cluster event against durable state-store authority. */
export const LISTEN_TOGETHER_VALIDATE_PUBLICATION_SCRIPT = `
-- listen-together:validate-cluster-publication
local key = KEYS[1]
local fenceKey = KEYS[2]
local counterKey = KEYS[3]
local incomingFence = tonumber(ARGV[1]) or 0
local eventType = ARGV[2]
local incomingStateVersion = tonumber(ARGV[3]) or 0
local incomingServerTime = tonumber(ARGV[4]) or 0

local allocatedRaw = redis.call('get', counterKey)
local allocatedFence = tonumber(allocatedRaw) or 0
if (not allocatedRaw and incomingFence ~= 0) or
   (allocatedRaw and incomingFence ~= allocatedFence) or
   tonumber(redis.call('get', fenceKey)) ~= incomingFence then
  return 0
end
local existingRaw = redis.call('get', key)
if eventType == 'group-ended' then
  return existingRaw and 0 or 1
end
if eventType ~= 'group-snapshot' then
  return 1
end
if not existingRaw then
  return 0
end
local ok, existing = pcall(cjson.decode, existingRaw)
if not ok or not existing or not existing.playback then
  return 0
end
local existingStateVersion = tonumber(existing.playback.stateVersion) or 0
local existingServerTime = tonumber(existing.playback.serverTime) or 0
if existingStateVersion ~= incomingStateVersion or existingServerTime ~= incomingServerTime then
  return 0
end
return 1
`;

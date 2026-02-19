import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import type { DiscoverPlaylist, DiscoverConfig } from "../types";

interface BatchStatus {
  active: boolean;
  status: "downloading" | "scanning" | "generating" | null;
  batchId?: string;
  progress?: number;
  completed?: number;
  failed?: number;
  total?: number;
}

interface LoadDataOptions {
  preservePlaylistOnError?: boolean;
}

export function useDiscoverData() {
  const [playlist, setPlaylist] = useState<DiscoverPlaylist | null>(null);
  const [config, setConfig] = useState<DiscoverConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [pendingGeneration, setPendingGeneration] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const wasActiveRef = useRef(false);
  const pendingRef = useRef(false); // Track pending state for polling callback

  // Keep pendingRef in sync with pendingGeneration
  useEffect(() => {
    pendingRef.current = pendingGeneration;
  }, [pendingGeneration]);

  const loadData = useCallback(async (options: LoadDataOptions = {}) => {
    try {
      const [playlistData, configData] = await Promise.all([
        api.getCurrentDiscoverWeekly().catch(() => null),
        api.getDiscoverConfig().catch(() => null),
      ]);

      setPlaylist((prev) => {
        if (playlistData === null && options.preservePlaylistOnError) {
          return prev;
        }
        return playlistData;
      });

      if (configData !== null) {
        setConfig(configData);
      }
    } catch (error) {
      console.error('Failed to load discover data:', error);
    }
  }, []);

  const checkBatchStatus = useCallback(async () => {
    try {
      const status = await api.getDiscoverBatchStatus();
      setBatchStatus(status);

      // Clear pending state once batch is confirmed active
      if (status.active) {
        setPendingGeneration(false);
      }

      // If batch was active and now isn't, reload data
      if (wasActiveRef.current && !status.active) {
        wasActiveRef.current = false;
        setPendingGeneration(false);
        await loadData({ preservePlaylistOnError: true });
      }
      
      // Track if batch is currently active
      if (status.active) {
        wasActiveRef.current = true;
      }

      return status;
    } catch (error) {
      console.error('Failed to check batch status:', error);
      setPendingGeneration(false);
      return null;
    }
  }, [loadData]);

  // Start polling for batch status
  const startPolling = useCallback(() => {
    if (pollingRef.current) return; // Already polling

    let errorCount = 0;
    pollingRef.current = setInterval(async () => {
      const status = await checkBatchStatus();

      // Stop polling on repeated API failures
      if (!status) {
        errorCount++;
        if (errorCount >= 5) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
        }
        return;
      }
      errorCount = 0;

      // Stop polling when batch is not active and we're not waiting for generation
      if (!status.active && !pendingRef.current) {
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    }, 3000); // Poll every 3 seconds
  }, [checkBatchStatus]);

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Initial load
  useEffect(() => {
    let isCancelled = false;

    const init = async () => {
      setLoading(true);

      // Kick off status check immediately but don't block initial page render on it.
      const statusPromise = checkBatchStatus();

      // Load playlist/config data first so the page can render sooner.
      await loadData();

      if (!isCancelled) {
        setLoading(false);
      }

      // Polling is secondary; attach when status resolves.
      const status = await statusPromise;
      if (!isCancelled && status?.active) {
        startPolling();
      }
    };

    void init();

    return () => {
      isCancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: initial data load and polling setup should not re-trigger on callback identity changes
  }, []);

  // Start polling when batch becomes active OR when generation is pending
  // This ensures we catch the batch as soon as it's created
  useEffect(() => {
    if ((batchStatus?.active || pendingGeneration) && !pollingRef.current) {
      startPolling();
    }
  }, [batchStatus?.active, pendingGeneration, startPolling]);

  return {
    playlist,
    config,
    setConfig,
    loading,
    reloadData: loadData,
    batchStatus,
    refreshBatchStatus: checkBatchStatus,
    setPendingGeneration,
    isGenerating: pendingGeneration || batchStatus?.active || false,
  };
}

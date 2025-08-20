import React, { useState, useEffect } from 'react';
import socket from './socket';

type Props = {
  isConnected: boolean;
  createSession: () => void;
  joinSession: (id: string) => void;
  leaveSession: () => void;
  servicesManager: any;
  sessionId: string;
  username: string;
};

// Define interfaces for segmentation data
interface SegmentData {
  segmentIndex: number;
  label?: string;
  locked?: boolean;
  active?: boolean;
  color?: [number, number, number, number];
  visibility?: boolean;
}

interface SegmentationEvent {
  segmentationId: string;
  label?: string;
  segments?: Record<string, SegmentData>;
  data?: any; // Labelmap data, type depends on segmentationService
}

export default function SessionControls({
  isConnected,
  createSession,
  joinSession,
  leaveSession,
  servicesManager,
  sessionId,
  username,
}: Props) {
  const [joinId, setJoinId] = useState('');
  const [pendingSegmentationRequests, setPendingSegmentationRequests] = useState(new Set<string>());

  // Helpers
  const getActiveViewportId = () => {
    const vps = servicesManager?.services?.viewportGridService;
    const state = vps?.getState?.();
    const id = state?.activeViewportId ?? 'default';
    console.log('[Viewport] Active viewport ID:', id, ' | state:', state);
    return id;
  };

  const getVolumeIdForDisplaySet = (displaySet: any) => {
    if (!displaySet) return null;
    if (displaySet.volumeId) return displaySet.volumeId;
    if (displaySet.derivedDisplaySet && displaySet.derivedDisplaySet.volumeId) {
      return displaySet.derivedDisplaySet.volumeId;
    }
    return `volume-${displaySet.displaySetInstanceUID}`;
  };

  // Ensure viewport is ready before applying segmentation
  const ensureViewportReady = async (
    callback: () => Promise<void>,
    maxRetries = 5,
    retryCount = 0
  ): Promise<void> => {
    const viewportId = getActiveViewportId();
    const vps = servicesManager?.services?.viewportGridService;
    const vpState = vps?.getState?.();

    // Check if viewportId exists in the viewports Map and has valid data
    const viewportData =
      vpState?.viewports instanceof Map ? vpState.viewports.get(viewportId) : null;
    const isViewportReady =
      viewportData &&
      (viewportData.displaySetInstanceUIDs?.length > 0 || viewportData.displaySetInstanceUID);

    if (!vpState || !viewportData || !isViewportReady) {
      if (retryCount >= maxRetries) {
        console.error('[Joiner] Max retries reached, viewport not ready:', {
          viewportId,
          vpState,
          viewportData,
        });
        return;
      }
      console.warn('[Joiner] Viewport not ready, retrying...', {
        viewportId,
        retryCount,
        viewportData,
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      return ensureViewportReady(callback, maxRetries, retryCount + 1);
    }

    try {
      await callback();
    } catch (err) {
      console.error('[Joiner] Error in callback execution:', err);
    }
  };

  // Ensure volume is loaded before applying segmentation
  const ensureVolumeLoaded = async (
    dsUID: string,
    maxRetries = 5,
    retryCount = 0
  ): Promise<any> => {
    const ds = dsUID
      ? servicesManager?.services?.displaySetService?.getDisplaySetByUID?.(dsUID)
      : null;
    if (!ds) {
      console.error('[Joiner] No display set found:', dsUID);
      return null;
    }
    const volumeId = getVolumeIdForDisplaySet(ds);
    const volume = servicesManager?.services?.volumeService?.getVolume?.(volumeId);
    if (!volume) {
      if (retryCount >= maxRetries) {
        console.error('[Joiner] Max retries reached, volume not loaded:', { dsUID, volumeId });
        return null;
      }
      console.warn('[Joiner] Volume not loaded, retrying...', { dsUID, volumeId, retryCount });
      await new Promise(resolve => setTimeout(resolve, 500));
      return ensureVolumeLoaded(dsUID, maxRetries, retryCount + 1);
    }
    console.log('[Joiner] Volume loaded:', { dsUID, volumeId });
    return ds;
  };

  /** -------------------------
   *  Host: Forward segmentation events (metadata-level)
   *  ------------------------- */
  useEffect(() => {
    if (!servicesManager) return;
    const { segmentationService } = servicesManager.services || {};
    if (!segmentationService) return;

    console.log('[Segmentation] Subscribing to host segmentation events');

    const normalizeSegmentation = (seg: any): SegmentationEvent => {
      const segments = Object.fromEntries(
        Object.entries(seg?.segments || {}).map(([i, s]: [string, any]) => [
          i,
          {
            segmentIndex: s.segmentIndex,
            label: s.label || `Segment ${s.segmentIndex}`,
            locked: !!s.locked,
            active: !!s.active,
            color: Array.isArray(s.color) && s.color.length === 4 ? s.color : [255, 0, 0, 255],
            visibility: s.visibility !== false,
          },
        ])
      );
      console.log('[Host] Normalized segmentation:', {
        segmentationId: seg?.segmentationId,
        segments,
      });
      return {
        segmentationId: seg?.segmentationId,
        label: seg?.label || 'Segmentation',
        segments,
      };
    };

    const forward = (eventName: string) => (evt: any) => {
      let payload: SegmentationEvent = evt;
      if (eventName === segmentationService.EVENTS.SEGMENTATION_ADDED && evt?.segmentation) {
        payload = normalizeSegmentation(evt.segmentation);
      } else if (evt?.segmentationId) {
        const seg = segmentationService.getSegmentation?.(evt.segmentationId);
        if (seg) {
          payload = { ...normalizeSegmentation(seg), segmentationId: seg.segmentationId };
          if (eventName === segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED) {
            try {
              const labelmapData = segmentationService.getLabelmapData?.(evt.segmentationId);
              if (labelmapData) {
                payload.data = labelmapData;
                console.log('[Host] Included labelmap data:', labelmapData);
              } else {
                console.warn('[Host] No labelmap data available for:', evt.segmentationId);
              }
            } catch (e) {
              console.warn('[Host] Could not get labelmap data:', e);
            }
          }
        }
      }
      console.log(`📤 [Host] Forwarding ${eventName}`, payload);
      socket.emit('segmentationEvent', { eventName, evt: payload });
    };

    const handleSegmentationDataRequest = async (
      { segmentationId }: { segmentationId: string },
      maxRetries = 5,
      retryCount = 0
    ) => {
      console.log(`📤 [Host] Sending segmentation data for: ${segmentationId}`);
      try {
        const segmentation = segmentationService.getSegmentation(segmentationId);
        if (!segmentation) {
          console.error('[Host] Segmentation not found:', segmentationId);
          return;
        }
        let labelmapData = null;
        try {
          labelmapData = segmentationService.getLabelmapData?.(segmentationId);
          if (!labelmapData && retryCount < maxRetries) {
            console.warn('[Host] Labelmap data not ready, retrying...', {
              segmentationId,
              retryCount,
            });
            await new Promise(resolve => setTimeout(resolve, 500));
            return handleSegmentationDataRequest({ segmentationId }, maxRetries, retryCount + 1);
          }
          console.log('[Host] Labelmap data:', labelmapData ? 'FOUND' : 'NOT FOUND');
        } catch (e) {
          console.warn('[Host] Could not get labelmap data:', e);
        }
        const payload: SegmentationEvent = {
          segmentationId,
          data: labelmapData,
          metadata: normalizeSegmentation(segmentation),
        };
        console.log('[Host] Sending segmentation data:', payload);
        socket.emit('segmentationData', payload);
      } catch (err) {
        console.error('[Host] Error getting segmentation data:', err);
      }
    };

    const subs = [
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_ADDED,
        forward(segmentationService.EVENTS.SEGMENTATION_ADDED)
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        forward(segmentationService.EVENTS.SEGMENTATION_MODIFIED)
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
        forward(segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED)
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_REMOVED,
        forward(segmentationService.EVENTS.SEGMENTATION_REMOVED)
      ),
    ];

    socket.on('requestSegmentationData', handleSegmentationDataRequest);

    return () => {
      console.log('[Segmentation] Unsubscribing host listeners');
      subs.forEach(u => u && u());
      socket.off('requestSegmentationData', handleSegmentationDataRequest);
    };
  }, [servicesManager]);

  /** -------------------------
   *  Joiner: Apply host segmentation events
   *  ------------------------- */
  useEffect(() => {
    if (!servicesManager) return;
    const { segmentationService, viewportGridService, volumeService } =
      servicesManager.services || {};

    // Debounce rapid segmentation_modified events
    let lastSegmentationEvent = 0;
    const DEBOUNCE_MS = 500;

    const onSegmentationEvent = async ({
      eventName,
      evt,
    }: {
      eventName: string;
      evt: SegmentationEvent;
    }) => {
      const now = Date.now();
      if (
        eventName.includes('segmentation_modified') &&
        now - lastSegmentationEvent < DEBOUNCE_MS
      ) {
        console.log('[Joiner] Debouncing segmentation_modified event:', evt.segmentationId);
        return;
      }
      lastSegmentationEvent = now;

      console.log('📥 [Joiner] segmentationEvent:', eventName, evt);
      const actualEventName = eventName.replace('event::', '');
      console.log('📥 [Joiner] Processing event:', actualEventName);

      await ensureViewportReady(async () => {
        try {
          switch (actualEventName) {
            case 'segmentation_added': {
              const viewportId = getActiveViewportId();
              const vpState = viewportGridService?.getState?.();
              const viewportData = vpState?.viewports?.get(viewportId);
              const dsUID =
                viewportData?.displaySetInstanceUIDs?.[0] || viewportData?.displaySetInstanceUID;
              const ds = await ensureVolumeLoaded(dsUID);
              if (!ds) {
                console.warn('[Joiner] No display set or volume for active viewport:', dsUID);
                return;
              }
              const volumeId = getVolumeIdForDisplaySet(ds);
              console.log('[Joiner] Creating labelmap for:', {
                dsUID,
                segId: evt.segmentationId,
                volumeId,
              });
              try {
                const segmentationId = await segmentationService.createLabelmapForDisplaySet(ds, {
                  segmentationId: evt.segmentationId,
                  label: evt.label || 'Segmentation',
                });
                segmentationService.setActiveSegmentation(viewportId, segmentationId);
                for (const [idxStr, segData] of Object.entries(evt.segments || {})) {
                  const idx = parseInt(idxStr, 10);
                  console.log('[Joiner] Adding segment:', { idx, segData });
                  segmentationService.addSegment(segmentationId, {
                    segmentIndex: idx,
                    label: segData.label || `Segment ${idx}`,
                    color:
                      Array.isArray(segData.color) && segData.color.length === 4
                        ? segData.color
                        : [255, 0, 0, 255],
                    visibility: segData.visibility !== false,
                    isLocked: !!segData.locked,
                    active: !!segData.active,
                  });
                }
                if (!pendingSegmentationRequests.has(evt.segmentationId)) {
                  console.log('[Joiner] Requesting full segmentation data');
                  setPendingSegmentationRequests(prev => new Set(prev).add(evt.segmentationId));
                  socket.emit('requestSegmentationData', { segmentationId: evt.segmentationId });
                }
                viewportGridService?.refreshViewport?.(viewportId);
              } catch (createError) {
                console.error('[Joiner] Error creating segmentation:', createError);
              }
              break;
            }
            case 'segmentation_modified': {
              const viewportId = getActiveViewportId();
              const segmentation = segmentationService.getSegmentation(evt.segmentationId);
              if (!segmentation) {
                console.warn('[Joiner] Segmentation not found:', evt.segmentationId);
                if (!pendingSegmentationRequests.has(evt.segmentationId)) {
                  setPendingSegmentationRequests(prev => new Set(prev).add(evt.segmentationId));
                  socket.emit('requestSegmentationData', { segmentationId: evt.segmentationId });
                }
                return;
              }
              for (const [idxStr, segData] of Object.entries(evt.segments || {})) {
                const idx = parseInt(idxStr, 10);
                const segmentExists = segmentation.segments?.[idx];
                if (!segmentExists) {
                  console.warn('[Joiner] Segment index does not exist:', {
                    segmentationId: evt.segmentationId,
                    idx,
                  });
                  continue;
                }
                if (
                  Array.isArray(segData.color) &&
                  segData.color.length === 4 &&
                  segmentationService.setSegmentColor
                ) {
                  console.log('[Joiner] setSegmentColor:', {
                    viewportId,
                    segmentationId: evt.segmentationId,
                    idx,
                    color: segData.color,
                  });
                  try {
                    segmentationService.setSegmentColor(
                      viewportId,
                      evt.segmentationId,
                      idx,
                      segData.color
                    );
                  } catch (colorError) {
                    console.error('[Joiner] Error setting segment color:', {
                      segmentationId: evt.segmentationId,
                      idx,
                      error: colorError,
                    });
                  }
                }
                if (
                  typeof segData.visibility === 'boolean' &&
                  segmentationService.setSegmentVisibility
                ) {
                  console.log('[Joiner] setSegmentVisibility:', {
                    viewportId,
                    segmentationId: evt.segmentationId,
                    idx,
                    visibility: segData.visibility,
                  });
                  try {
                    segmentationService.setSegmentVisibility(
                      viewportId,
                      evt.segmentationId,
                      idx,
                      segData.visibility
                    );
                  } catch (visibilityError) {
                    console.error('[Joiner] Error setting segment visibility:', {
                      segmentationId: evt.segmentationId,
                      idx,
                      error: visibilityError,
                    });
                  }
                }
                if (typeof segData.locked === 'boolean' && segmentationService.setSegmentLocked) {
                  console.log('[Joiner] setSegmentLocked:', {
                    viewportId,
                    segmentationId: evt.segmentationId,
                    idx,
                    locked: segData.locked,
                  });
                  try {
                    segmentationService.setSegmentLocked(
                      viewportId,
                      evt.segmentationId,
                      idx,
                      segData.locked
                    );
                  } catch (lockError) {
                    console.error('[Joiner] Error setting segment lock:', {
                      segmentationId: evt.segmentationId,
                      idx,
                      error: lockError,
                    });
                  }
                }
              }
              viewportGridService?.refreshViewport?.(viewportId);
              break;
            }
            case 'segmentation_data_modified': {
              console.log('[Joiner] Segmentation data modified, requesting update');
              if (!pendingSegmentationRequests.has(evt.segmentationId)) {
                setPendingSegmentationRequests(prev => new Set(prev).add(evt.segmentationId));
                socket.emit('requestSegmentationData', { segmentationId: evt.segmentationId });
              }
              break;
            }
            case 'segmentation_removed': {
              console.log('[Joiner] Removing segmentation:', evt.segmentationId);
              segmentationService.remove?.(evt.segmentationId);
              setPendingSegmentationRequests(prev => {
                const newSet = new Set(prev);
                newSet.delete(evt.segmentationId);
                return newSet;
              });
              viewportGridService?.refreshViewport?.(getActiveViewportId());
              break;
            }
            default:
              console.warn('[Joiner] Unhandled segmentation event:', actualEventName);
          }
        } catch (err) {
          console.error('[Joiner] Error applying segmentation event:', err);
        }
      });
    };

    const onSegmentationData = async ({
      segmentationId,
      data,
      metadata,
    }: SegmentationEvent & { metadata: SegmentationEvent }) => {
      console.log(`📥 [Joiner] Received segmentation data for: ${segmentationId}`, {
        data: data ? 'PRESENT' : 'NULL',
        metadata,
      });
      setPendingSegmentationRequests(prev => {
        const newSet = new Set(prev);
        newSet.delete(segmentationId);
        return newSet;
      });

      await ensureViewportReady(async () => {
        try {
          const viewportId = getActiveViewportId();
          const vpState = viewportGridService?.getState?.();
          const viewportData = vpState?.viewports?.get(viewportId);
          const dsUID =
            viewportData?.displaySetInstanceUIDs?.[0] || viewportData?.displaySetInstanceUID;
          const ds = await ensureVolumeLoaded(dsUID);

          if (!ds) {
            console.error('[Joiner] No display set or volume for segmentation:', { dsUID });
            return;
          }
          const volumeId = getVolumeIdForDisplaySet(ds);
          console.log('[Joiner] Display set:', { dsUID, volumeId });

          if (segmentationService.getSegmentation(segmentationId)) {
            segmentationService.remove(segmentationId);
            console.log('[Joiner] Removed existing segmentation:', segmentationId);
          }

          let segId = segmentationId;
          if (data) {
            try {
              segId = await segmentationService.importSegmentation(ds, {
                segmentationId,
                label: metadata.label || 'Segmentation',
                data,
                segments: metadata.segments,
              });
              console.log(`✅ [Joiner] Imported segmentation ${segId} with data`);
            } catch (importError) {
              console.warn('[Joiner] Import failed:', importError);
              segId = await segmentationService.createLabelmapForDisplaySet(ds, {
                segmentationId,
                label: metadata.label || 'Segmentation',
              });
              console.log('[Joiner] Created empty labelmap as fallback:', segId);
              if (!pendingSegmentationRequests.has(segmentationId)) {
                setPendingSegmentationRequests(prev => new Set(prev).add(segmentationId));
                socket.emit('requestSegmentationData', { segmentationId });
              }
            }
          } else {
            console.warn('[Joiner] No labelmap data, creating empty segmentation');
            segId = await segmentationService.createLabelmapForDisplaySet(ds, {
              segmentationId,
              label: metadata.label || 'Segmentation',
            });
            if (!pendingSegmentationRequests.has(segmentationId)) {
              setPendingSegmentationRequests(prev => new Set(prev).add(segmentationId));
              socket.emit('requestSegmentationData', { segmentationId });
            }
          }

          for (const [idxStr, segData] of Object.entries(metadata.segments || {})) {
            const idx = parseInt(idxStr, 10);
            console.log('[Joiner] Adding segment:', { idx, segData });
            segmentationService.addSegment(segId, {
              segmentIndex: idx,
              label: segData.label || `Segment ${idx}`,
              color:
                Array.isArray(segData.color) && segData.color.length === 4
                  ? segData.color
                  : [255, 0, 0, 255],
              visibility: segData.visibility !== false,
              isLocked: !!segData.locked,
              active: !!segData.active,
            });
          }

          segmentationService.setActiveSegmentation(viewportId, segId);
          viewportGridService?.refreshViewport?.(viewportId);
          console.log(`✅ [Joiner] Segmentation ${segId} applied successfully`);
        } catch (err) {
          console.error('[Joiner] Error applying segmentation data:', err);
        }
      });
    };

    socket.on('segmentationEvent', onSegmentationEvent);
    socket.on('segmentationData', onSegmentationData);

    return () => {
      socket.off('segmentationEvent', onSegmentationEvent);
      socket.off('segmentationData', onSegmentationData);
    };
  }, [servicesManager]);

  /** -------------------------
   *  UI
   *  ------------------------- */
  return (
    <div
      style={{
        padding: 12,
        backgroundColor: '#111',
        color: '#fff',
        borderRadius: 6,
        border: '1px solid #333',
      }}
    >
      {!isConnected ? (
        <>
          <button
            onClick={() => {
              console.log('[UI] Create Session clicked');
              createSession();
            }}
            style={{
              background: '#4caf50',
              padding: 8,
              width: '100%',
              borderRadius: 4,
              fontWeight: 'bold',
            }}
          >
            Create Session
          </button>
          <div style={{ marginTop: 8 }}>
            <label
              htmlFor="session-id-input"
              style={{ display: 'block', marginBottom: 4, color: '#bbb' }}
            >
              Enter Session ID
            </label>
            <input
              id="session-id-input"
              value={joinId}
              onChange={e => setJoinId(e.target.value)}
              placeholder="Paste session ID"
              style={{
                width: '100%',
                padding: 8,
                borderRadius: 4,
                border: '1px solid #555',
                background: '#222',
                color: '#fff',
              }}
            />
            <button
              disabled={!joinId.trim()}
              onClick={() => {
                console.log('[UI] Join Session clicked:', joinId);
                joinSession(joinId);
              }}
              style={{
                background: '#2196f3',
                marginTop: 8,
                padding: 8,
                width: '100%',
                borderRadius: 4,
                fontWeight: 'bold',
                cursor: joinId.trim() ? 'pointer' : 'not-allowed',
                opacity: joinId.trim() ? 1 : 0.6,
              }}
            >
              Join Session
            </button>
          </div>
        </>
      ) : (
        <button
          onClick={() => {
            console.log('[UI] Leave Session clicked');
            leaveSession();
          }}
          style={{
            background: '#f44336',
            padding: 8,
            width: '100%',
            borderRadius: 4,
            fontWeight: 'bold',
          }}
        >
          Leave Session
        </button>
      )}
    </div>
  );
}

import React, { useState, useEffect, useRef } from 'react';
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
  type: string;
  targetViewportId?: string;
  sourceSocketId?: string;
  displaySetInstanceUID?: string;
  fromHost?: boolean;
  toolData?: any; // For brush tool synchronization
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
  const [servicesReady, setServicesReady] = useState(false);
  const appliedSegmentations = useRef<Set<string>>(new Set());
  const socketId = useRef<string | null>(null);
  const isHost = useRef(false);
  const eventOriginCache = useRef<Map<string, string>>(new Map());
  const viewportMap = useRef<Map<string, string>>(new Map()); // Map<hostViewportId, joinerViewportId>

  // Get services from servicesManager
  const getServices = () => {
    if (!servicesManager) return null;

    try {
      const displaySetService = servicesManager.services.displaySetService;
      const segmentationService = servicesManager.services.segmentationService;
      const viewportGridService = servicesManager.services.viewportGridService;
      const commandsManager = servicesManager.services.commandsManager;
      const toolGroupService = servicesManager.services.toolGroupService;

      return {
        displaySetService,
        segmentationService,
        viewportGridService,
        commandsManager,
        toolGroupService,
      };
    } catch (error) {
      console.error('Error accessing services:', error);
      return null;
    }
  };

  // Get our socket ID when connected
  useEffect(() => {
    const handleConnect = () => {
      socketId.current = socket.id;
      console.log('Our socket ID:', socketId.current);
    };

    socket.on('connect', handleConnect);

    if (socket.connected) {
      socketId.current = socket.id;
      console.log('Already connected, socket ID:', socketId.current);
    }

    return () => {
      socket.off('connect', handleConnect);
    };
  }, []);

  // Check if services are available
  useEffect(() => {
    if (servicesManager) {
      const checkServices = () => {
        const services = getServices();
        if (
          services &&
          services.displaySetService &&
          services.segmentationService &&
          services.viewportGridService
        ) {
          setServicesReady(true);
          console.log('✅ All services are ready');
          return true;
        }
        return false;
      };

      if (checkServices()) {
        return;
      }

      const interval = setInterval(() => {
        if (checkServices()) {
          clearInterval(interval);
        }
      }, 500);

      return () => clearInterval(interval);
    }
  }, [servicesManager]);

  // Track if we're the host
  useEffect(() => {
    if (isConnected && sessionId) {
      isHost.current = true;
      console.log('🏠 I am the host');
    } else {
      isHost.current = false;
      console.log('👤 I am a joiner');
    }
  }, [isConnected, sessionId]);

  // Get the actual viewport ID from viewport grid service
  const getActiveViewportId = () => {
    const services = getServices();
    if (!services?.viewportGridService) return null;

    try {
      const activeViewportId = services.viewportGridService.getActiveViewportId();
      return activeViewportId;
    } catch (error) {
      console.error('Error getting active viewport ID:', error);
      return null;
    }
  };

  // Get all viewport IDs from the grid
  const getAllViewportIds = () => {
    const services = getServices();
    if (!services?.viewportGridService) return [];

    try {
      const gridState = services.viewportGridService.getState();
      if (gridState?.viewports instanceof Map) {
        return Array.from(gridState.viewports.keys());
      }
      return [];
    } catch (error) {
      console.error('Error getting viewport IDs:', error);
      return [];
    }
  };

  const getViewportDisplaySet = (viewportId: string) => {
    const services = getServices();

    if (!services?.viewportGridService || !services?.displaySetService) {
      console.warn('Viewport grid or display set service not available');
      return null;
    }

    try {
      const gridState = services.viewportGridService.getState();
      const viewportData = gridState.viewports.get(viewportId);

      if (!viewportData) {
        console.warn('No viewport data found for viewport:', viewportId);
        return null;
      }

      const dsUID = viewportData.displaySetInstanceUIDs?.[0] || viewportData.displaySetInstanceUID;

      if (!dsUID) {
        console.warn('No display set in viewport:', viewportId);
        return null;
      }

      const ds = services.displaySetService.getDisplaySetByUID(dsUID);
      if (!ds) {
        console.warn('Display set not found:', dsUID);
        return null;
      }

      return { viewportId, ds };
    } catch (error) {
      console.error('Error getting viewport display set:', error);
      return null;
    }
  };

  // Map viewports between host and joiner
  const mapViewports = (hostViewportId: string): string => {
    if (isHost.current) return hostViewportId;

    // If we already have a mapping, return it
    for (const [hostId, joinerId] of viewportMap.current.entries()) {
      if (hostId === hostViewportId) {
        return joinerId;
      }
    }

    // Find a matching viewport on joiner side based on position or display set
    const joinerViewports = getAllViewportIds();
    if (joinerViewports.length > 0) {
      // Use the first available viewport or try to find a matching one
      const targetViewportId = joinerViewports[0];
      viewportMap.current.set(hostViewportId, targetViewportId);
      return targetViewportId;
    }

    console.warn('No viewports available for mapping, using fallback');
    return hostViewportId; // Fallback
  };

  // ------------------ Host: Forward Segmentation Events ------------------
  useEffect(() => {
    if (!servicesManager || !servicesReady) return;

    const services = getServices();
    if (
      !services?.segmentationService ||
      !services?.viewportGridService ||
      !services?.displaySetService
    )
      return;

    // Get segmentation data for transmission
    const getSegmentationPayload = (segmentationId: string): SegmentationEvent | null => {
      try {
        const seg = services.segmentationService.getSegmentation(segmentationId);
        if (!seg) return null;

        const segments = Object.fromEntries(
          Object.entries(seg.segments || {}).map(([i, s]: [string, any]) => [
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

        // Get the current display set for the active viewport
        const activeViewportId = getActiveViewportId();
        const viewportInfo = activeViewportId ? getViewportDisplaySet(activeViewportId) : null;
        const displaySetInstanceUID = viewportInfo?.ds?.displaySetInstanceUID;

        return {
          segmentationId: seg.segmentationId,
          label: seg.label || 'Segmentation',
          segments,
          type: 'segmentation_data',
          targetViewportId: activeViewportId,
          sourceSocketId: socketId.current,
          displaySetInstanceUID,
        };
      } catch (error) {
        console.error('Error getting segmentation payload:', error);
        return null;
      }
    };

    // Forward segmentation events to joiners
    const forwardSegmentationEvent = (eventName: string) => (evt: any) => {
      try {
        let segmentationId: string | null = null;

        if (evt.segmentation) {
          segmentationId = evt.segmentation.segmentationId;
        } else if (evt.segmentationId) {
          segmentationId = evt.segmentationId;
        }

        if (!segmentationId) return;

        const payload = getSegmentationPayload(segmentationId);
        if (!payload) return;

        console.log(`📤 [Host] Forwarding ${eventName} to joiners`, payload);

        // Cache that we're the origin of this event
        eventOriginCache.current.set(segmentationId, socketId.current!);

        socket.emit('segmentationEvent', {
          eventName,
          evt: {
            ...payload,
            fromHost: true,
          },
        });
      } catch (error) {
        console.error('Error forwarding segmentation event:', error);
      }
    };

    // Subscribe to segmentation events
    const subs = [
      services.segmentationService.subscribe(
        services.segmentationService.EVENTS.SEGMENTATION_ADDED,
        forwardSegmentationEvent('segmentation_added')
      ),
      services.segmentationService.subscribe(
        services.segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        forwardSegmentationEvent('segmentation_modified')
      ),
      services.segmentationService.subscribe(
        services.segmentationService.EVENTS.SEGMENTATION_REMOVED,
        (evt: any) => {
          const segmentationId = evt.segmentation?.segmentationId || evt.segmentationId;
          if (segmentationId) {
            eventOriginCache.current.set(segmentationId, socketId.current!);

            socket.emit('segmentationEvent', {
              eventName: 'segmentation_removed',
              evt: {
                type: 'segmentation_removed',
                segmentationId,
                targetViewportId: getActiveViewportId(),
                sourceSocketId: socketId.current,
                fromHost: true,
              },
            });
          }
        }
      ),
    ];

    // Handle request for all segmentations from joiners
    const handleRequestAllSegmentations = () => {
      try {
        const segmentationIds = services.segmentationService.getSegmentationIds?.() || [];
        const allSegmentations = segmentationIds
          .map(id => getSegmentationPayload(id))
          .filter(Boolean) as SegmentationEvent[];

        console.log(`📤 [Host] Sending ${allSegmentations.length} segmentations to joiner`);

        const segmentationsWithHostFlag = allSegmentations.map(seg => ({
          ...seg,
          fromHost: true,
        }));

        socket.emit('allSegmentations', segmentationsWithHostFlag);
      } catch (error) {
        console.error('Error sending all segmentations:', error);
      }
    };

    socket.on('requestAllSegmentations', handleRequestAllSegmentations);

    return () => {
      subs.forEach(unsubscribe => unsubscribe && unsubscribe());
      socket.off('requestAllSegmentations', handleRequestAllSegmentations);
    };
  }, [servicesManager, servicesReady]);

  // ------------------ Joiner: Handle Segmentation Events ------------------
  useEffect(() => {
    if (!servicesManager || !servicesReady) return;

    const services = getServices();
    if (
      !services?.segmentationService ||
      !services?.viewportGridService ||
      !services?.displaySetService
    )
      return;

    const applySegmentation = async (evt: SegmentationEvent & { fromHost?: boolean }) => {
      try {
        console.log('🖌️ [Joiner] Attempting to apply segmentation:', evt.segmentationId);

        // Check if we originated this event to prevent feedback loops
        const eventOrigin = eventOriginCache.current.get(evt.segmentationId);
        if (eventOrigin === socketId.current) {
          console.log('🛑 [Joiner] Skipping event that originated from us');
          eventOriginCache.current.delete(evt.segmentationId);
          return;
        }

        // Skip if this event came from ourselves
        if (evt.sourceSocketId === socketId.current) {
          console.log('🛑 [Joiner] Skipping own event');
          return;
        }

        if (appliedSegmentations.current.has(evt.segmentationId)) {
          console.log('📝 [Joiner] Segmentation already applied:', evt.segmentationId);
          return;
        }

        // Map the host viewport to joiner viewport
        const targetViewportId = evt.targetViewportId
          ? mapViewports(evt.targetViewportId)
          : getActiveViewportId();
        if (!targetViewportId) {
          console.warn('⚠️ [Joiner] No target viewport available');
          return;
        }

        // Get or set the display set for this viewport
        let displaySet = null;

        if (evt.displaySetInstanceUID) {
          displaySet = services.displaySetService.getDisplaySetByUID(evt.displaySetInstanceUID);
        }

        if (!displaySet) {
          // Get display set from the target viewport
          const viewportInfo = getViewportDisplaySet(targetViewportId);
          if (viewportInfo) {
            displaySet = viewportInfo.ds;
          } else {
            // Fallback: get the first available display set
            const activeDisplaySets = services.displaySetService.getActiveDisplaySets();
            if (activeDisplaySets.length > 0) {
              displaySet = activeDisplaySets[0];
              // Set this display set to the target viewport
              services.viewportGridService.setDisplaySetsForViewport({
                viewportId: targetViewportId,
                displaySetInstanceUIDs: [displaySet.displaySetInstanceUID],
              });
            } else {
              console.warn('⚠️ [Joiner] No display sets available');
              return;
            }
          }
        }

        console.log('🎯 [Joiner] Applying segmentation to viewport:', targetViewportId);

        // Check if segmentation already exists
        let existingSeg = services.segmentationService.getSegmentation(evt.segmentationId);

        if (!existingSeg) {
          // Create new segmentation using the display set - OHIF 3.9 API
          console.log('🆕 [Joiner] Creating new segmentation:', evt.segmentationId);
          try {
            // Use the new OHIF 3.9 API
            await services.segmentationService.createLabelmapForDisplaySet(displaySet, {
              segmentationId: evt.segmentationId,
              label: evt.label || 'Remote Segmentation',
            });
            existingSeg = services.segmentationService.getSegmentation(evt.segmentationId);
            console.log('✅ [Joiner] Segmentation created successfully');
          } catch (error) {
            console.error('❌ [Joiner] Error creating segmentation:', error);
            return;
          }
        }

        // Apply segments configuration
        if (evt.segments) {
          console.log('🎨 [Joiner] Applying segments configuration');
          for (const segment of Object.values(evt.segments)) {
            try {
              services.segmentationService.addSegment(evt.segmentationId, {
                segmentIndex: segment.segmentIndex,
                label: segment.label || `Segment ${segment.segmentIndex}`,
                isLocked: segment.locked || false,
                active: segment.active || false,
                color: segment.color || [255, 0, 0, 255],
                visibility: segment.visibility !== false,
              });
            } catch (error) {
              console.log('ℹ️ [Joiner] Segment might already exist:', segment.segmentIndex);
            }
          }
        }

        // Add segmentation representation to viewport using OHIF 3.9 API
        try {
          console.log('➕ [Joiner] Adding segmentation representation to viewport');

          // Use the new OHIF 3.9 API
          await services.segmentationService.addSegmentationRepresentation(targetViewportId, {
            segmentationId: evt.segmentationId,
            type: 'Labelmap',
          });

          // Set active segmentation if any segment is active
          if (evt.segments && Object.values(evt.segments).some(seg => seg.active)) {
            services.segmentationService.setActiveSegmentation(
              targetViewportId,
              evt.segmentationId
            );
          }

          // Set segment colors if specified
          if (evt.segments) {
            for (const [segmentIndexStr, segmentData] of Object.entries(evt.segments)) {
              const segmentIndex = parseInt(segmentIndexStr, 10);
              if (segmentData.color) {
                services.segmentationService.setSegmentColor(
                  targetViewportId,
                  evt.segmentationId,
                  segmentIndex,
                  segmentData.color
                );
              }
              if (typeof segmentData.visibility === 'boolean') {
                services.segmentationService.setSegmentVisibility(
                  targetViewportId,
                  evt.segmentationId,
                  segmentIndex,
                  segmentData.visibility
                );
              }
            }
          }
        } catch (error) {
          console.warn('⚠️ [Joiner] Could not add segmentation representation to viewport:', error);
        }

        appliedSegmentations.current.add(evt.segmentationId);
        console.log('🎉 [Joiner] Segmentation applied successfully:', evt.segmentationId);
      } catch (error) {
        console.error('❌ [Joiner] Error applying segmentation:', error);
      }
    };

    const removeSegmentation = (evt: SegmentationEvent & { fromHost?: boolean }) => {
      try {
        // Check if we originated this event to prevent feedback loops
        const eventOrigin = eventOriginCache.current.get(evt.segmentationId);
        if (eventOrigin === socketId.current) {
          console.log('🛑 [Joiner] Skipping removal event that originated from us');
          eventOriginCache.current.delete(evt.segmentationId);
          return;
        }

        // Skip if this event came from ourselves
        if (evt.sourceSocketId === socketId.current) {
          console.log('🛑 [Joiner] Skipping own removal event');
          return;
        }

        // Use OHIF 3.9 API to remove segmentation
        services.segmentationService.removeSegmentation(evt.segmentationId);
        appliedSegmentations.current.delete(evt.segmentationId);
        console.log('🗑️ [Joiner] Segmentation removed:', evt.segmentationId);
      } catch (error) {
        console.error('❌ [Joiner] Error removing segmentation:', error);
      }
    };

    const handleSegmentationEvent = (data: {
      eventName: string;
      evt: SegmentationEvent & { fromHost?: boolean };
    }) => {
      console.log('📥 [Joiner] Received segmentation event:', data.eventName, data.evt);

      const evt = data.evt;

      switch (data.eventName) {
        case 'segmentation_added':
        case 'segmentation_modified':
        case 'segmentation_data_modified':
          applySegmentation(evt);
          break;
        case 'segmentation_removed':
          removeSegmentation(evt);
          break;
        default:
          console.log('❓ [Joiner] Unknown event type:', data.eventName);
      }
    };

    const handleAllSegmentations = (
      segmentations: (SegmentationEvent & { fromHost?: boolean })[]
    ) => {
      console.log('📦 [Joiner] Received all segmentations:', segmentations.length);
      segmentations.forEach(applySegmentation);
    };

    // Request all segmentations when joining
    if (isConnected && !isHost.current) {
      const hasSegmentations = services.segmentationService.getSegmentationIds?.()?.length > 0;
      if (!hasSegmentations) {
        console.log('📞 [Joiner] Requesting all segmentations from host');
        socket.emit('requestAllSegmentations');
      }
    }

    socket.on('segmentationEvent', handleSegmentationEvent);
    socket.on('allSegmentations', handleAllSegmentations);

    return () => {
      socket.off('segmentationEvent', handleSegmentationEvent);
      socket.off('allSegmentations', handleAllSegmentations);
    };
  }, [servicesManager, servicesReady, isConnected]);

  // ------------------ UI ------------------
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
            onClick={createSession}
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
                border: '1px , #555',
                background: '#222',
                color: '#fff',
              }}
            />
            <button
              disabled={!joinId.trim()}
              onClick={() => joinSession(joinId)}
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
          onClick={leaveSession}
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

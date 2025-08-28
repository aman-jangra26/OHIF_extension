import React, { useState, useEffect, useRef } from 'react';
import socket from './socket';
import { string } from 'prop-types';

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
}

interface BrushEventData {
  segmentationId: string;
  operation: 'draw' | 'erase';
  points: number[][];
  toolName: string;
  segmentIndex: number;
  brushSize: number;
  viewportId: string;
  displaySetInstanceUID: string;
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
  const viewportId = string;
  const isHost = useRef(false);
  const eventOriginCache = useRef<Map<string, string>>(new Map());
  const labelmapBufferCache = useRef<Map<string, ArrayBuffer>>(new Map());

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
      console.log('Our socket ID:', socketId.current, 'Viewport ID:');
    };

    socket.on('connect', handleConnect);

    if (socket.connected) {
      socketId.current = socket.id;
      console.log('Already connected, socket ID:', socketId.current, 'Viewport ID:', viewportId);
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

  const getActiveViewportId = () => {
    const services = getServices();
    if (!services?.viewportGridService) return viewportId;

    const activeViewportId = services.viewportGridService.getActiveViewportId();
    console.log(activeViewportId);
    return activeViewportId || viewportId;
  };

  const getViewportDisplaySet = () => {
    const currentViewportId = getActiveViewportId();
    const services = getServices();

    if (!services?.viewportGridService || !services?.displaySetService) {
      console.warn('Viewport grid or display set service not available');
      return null;
    }

    const gridState = services.viewportGridService.getState();
    const viewportData = gridState.viewports.get(currentViewportId);

    if (!viewportData) {
      console.warn('No viewport data found for viewport:', currentViewportId);
      return null;
    }

    const dsUID = viewportData.displaySetInstanceUIDs?.[0] || viewportData.displaySetInstanceUID;

    if (!dsUID) {
      console.warn('No display set in active viewport:', currentViewportId);
      return null;
    }

    const ds = services.displaySetService.getDisplaySetByUID(dsUID);
    if (!ds) {
      console.warn('Display set not found:', dsUID);
      return null;
    }

    return { viewportId: currentViewportId, ds };
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
        const viewportInfo = getViewportDisplaySet();
        const displaySetInstanceUID = viewportInfo?.ds?.displaySetInstanceUID;

        return {
          segmentationId: seg.segmentationId,
          label: seg.label || 'Segmentation',
          segments,
          type: 'segmentation_data',
          targetViewportId: viewportId,
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

    // Handle brush events from the tool
    const handleBrushEvent = (evt: any) => {
      try {
        if (!isHost.current) return;

        const { operation, points, toolName, segmentIndex, brushSize } = evt.detail || {};
        const currentViewportId = getActiveViewportId();
        const viewportInfo = getViewportDisplaySet();

        if (!operation || !points || !segmentIndex || !viewportInfo) return;

        // Get active segmentation
        const activeSegmentation =
          services.segmentationService.getActiveSegmentation(currentViewportId);

        if (!activeSegmentation) return;

        const brushEventData: BrushEventData = {
          segmentationId: activeSegmentation.segmentationId,
          operation,
          points,
          toolName,
          segmentIndex,
          brushSize,
          viewportId: currentViewportId,
          displaySetInstanceUID: viewportInfo.ds.displaySetInstanceUID,
        };

        console.log('📤 [Host] Forwarding brush event:', brushEventData);

        // Send brush event to joiners
        socket.emit('brushEvent', {
          ...brushEventData,
          sourceSocketId: socketId.current,
          fromHost: true,
        });

        // Also send updated labelmap data after brush operation
        setTimeout(() => {
          sendLabelmapData(activeSegmentation.segmentationId);
        }, 100);
      } catch (error) {
        console.error('Error handling brush event:', error);
      }
    };

    // Send labelmap data for a segmentation
    const sendLabelmapData = async (segmentationId: string) => {
      try {
        const seg = services.segmentationService.getSegmentation(segmentationId);
        if (!seg) return;

        // Get labelmap data using OHIF 3.9 API
        const labelmapData = await services.segmentationService.getLabelmapData(segmentationId);
        if (!labelmapData) return;

        // Convert to ArrayBuffer for efficient transmission
        const buffer = labelmapData.buffer;

        console.log(`📤 [Host] Sending labelmap data for ${segmentationId}`, buffer.byteLength);

        socket.emit('labelmapData', {
          segmentationId,
          buffer,
          sourceSocketId: socketId.current,
          fromHost: true,
        });
      } catch (error) {
        console.error('Error sending labelmap data:', error);
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
                targetViewportId: viewportId.current,
                sourceSocketId: socketId.current,
                fromHost: true,
              },
            });
          }
        }
      ),
    ];

    // Listen for brush events from the tool
    document.addEventListener('cornerstoneimageloaded', handleBrushEvent);
    document.addEventListener('cornerstonetoolsmodeentered', handleBrushEvent);

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

        // Also send labelmap data for each segmentation
        segmentationIds.forEach(id => {
          setTimeout(() => sendLabelmapData(id), 200);
        });
      } catch (error) {
        console.error('Error sending all segmentations:', error);
      }
    };

    socket.on('requestAllSegmentations', handleRequestAllSegmentations);

    return () => {
      subs.forEach(unsubscribe => unsubscribe && unsubscribe());
      document.removeEventListener('cornerstoneimageloaded', handleBrushEvent);
      document.removeEventListener('cornerstonetoolsmodeentered', handleBrushEvent);
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

        // Get the active viewport ID
        const currentViewportId =
          services.viewportGridService.getActiveViewportId() || viewportId.current;

        // Get or set the display set for this viewport
        let displaySet = null;

        if (evt.displaySetInstanceUID) {
          displaySet = services.displaySetService.getDisplaySetByUID(evt.displaySetInstanceUID);
        }

        if (!displaySet) {
          // Fallback: get the first available display set
          const activeDisplaySets = services.displaySetService.getActiveDisplaySets();
          if (activeDisplaySets.length > 0) {
            displaySet = activeDisplaySets[0];
            // Set this display set to the active viewport using the proper API
            services.viewportGridService.setDisplaySetsForViewport({
              viewportId: currentViewportId,
              displaySetInstanceUIDs: [displaySet.displaySetInstanceUID],
            });
          } else {
            console.warn('⚠️ [Joiner] No display sets available');
            return;
          }
        }

        console.log('🎯 [Joiner] Applying segmentation to viewport:', currentViewportId);

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
            // Fallback: try using commands manager
            try {
              if (services.commandsManager) {
                await services.commandsManager.runCommand('createLabelmapForViewport', {
                  viewportId: currentViewportId,
                  options: {
                    segmentationId: evt.segmentationId,
                    label: evt.label || 'Remote Segmentation',
                  },
                });
                existingSeg = services.segmentationService.getSegmentation(evt.segmentationId);
                console.log('✅ [Joiner] Segmentation created via commands manager');
              }
            } catch (fallbackError) {
              console.error('❌ [Joiner] Fallback also failed:', fallbackError);
              return;
            }
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
          await services.segmentationService.addSegmentationRepresentation(currentViewportId, {
            segmentationId: evt.segmentationId,
            type: 'Labelmap',
          });

          // Set active segmentation if any segment is active
          if (evt.segments && Object.values(evt.segments).some(seg => seg.active)) {
            services.segmentationService.setActiveSegmentation(
              currentViewportId,
              evt.segmentationId
            );
          }

          // Set segment colors if specified
          if (evt.segments) {
            for (const [segmentIndexStr, segmentData] of Object.entries(evt.segments)) {
              const segmentIndex = parseInt(segmentIndexStr, 10);
              if (segmentData.color) {
                services.segmentationService.setSegmentColor(
                  currentViewportId,
                  evt.segmentationId,
                  segmentIndex,
                  segmentData.color
                );
              }
              if (typeof segmentData.visibility === 'boolean') {
                services.segmentationService.setSegmentVisibility(
                  currentViewportId,
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
        labelmapBufferCache.current.delete(evt.segmentationId);
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

    // Handle brush events from host
    const handleBrushEvent = async (
      data: BrushEventData & { sourceSocketId?: string; fromHost?: boolean }
    ) => {
      try {
        // Skip if this event came from ourselves
        if (data.sourceSocketId === socketId.current) {
          console.log('🛑 [Joiner] Skipping own brush event');
          return;
        }

        console.log('🖌️ [Joiner] Received brush event:', data);

        // Get or create the segmentation
        let segmentation = services.segmentationService.getSegmentation(data.segmentationId);
        if (!segmentation) {
          console.log('🆕 [Joiner] Creating segmentation from brush event:', data.segmentationId);

          // Get display set
          const displaySet = services.displaySetService.getDisplaySetByUID(
            data.displaySetInstanceUID
          );
          if (!displaySet) {
            console.warn('⚠️ [Joiner] Display set not found for brush event');
            return;
          }

          // Create segmentation
          await services.segmentationService.createLabelmapForDisplaySet(displaySet, {
            segmentationId: data.segmentationId,
            label: 'Remote Segmentation',
          });

          segmentation = services.segmentationService.getSegmentation(data.segmentationId);
        }

        // Add segmentation representation if needed
        const representations = services.segmentationService.getSegmentationRepresentations(
          data.viewportId
        );

        const hasRepresentation = representations.some(
          (rep: any) => rep.segmentationId === data.segmentationId
        );

        if (!hasRepresentation) {
          await services.segmentationService.addSegmentationRepresentation(data.viewportId, {
            segmentationId: data.segmentationId,
            type: 'Labelmap',
          });
        }

        // Apply brush operation using OHIF 3.9 API
        try {
          await services.segmentationService.applyBrushOperation({
            segmentationId: data.segmentationId,
            operation: data.operation,
            points: data.points,
            segmentIndex: data.segmentIndex,
            brushSize: data.brushSize,
            toolName: data.toolName,
          });

          console.log('✅ [Joiner] Brush operation applied successfully');
        } catch (error) {
          console.error('❌ [Joiner] Error applying brush operation:', error);
        }
      } catch (error) {
        console.error('❌ [Joiner] Error handling brush event:', error);
      }
    };

    // Handle labelmap data updates from host
    const handleLabelmapData = async (data: {
      segmentationId: string;
      buffer: ArrayBuffer;
      sourceSocketId?: string;
      fromHost?: boolean;
    }) => {
      try {
        // Skip if this event came from ourselves
        if (data.sourceSocketId === socketId.current) {
          console.log('🛑 [Joiner] Skipping own labelmap data');
          return;
        }

        console.log(
          '📊 [Joiner] Received labelmap data:',
          data.segmentationId,
          data.buffer.byteLength
        );

        // Cache the buffer for later use
        labelmapBufferCache.current.set(data.segmentationId, data.buffer);

        // Check if we have the segmentation
        const segmentation = services.segmentationService.getSegmentation(data.segmentationId);
        if (!segmentation) {
          console.log('⏳ [Joiner] Segmentation not yet available, caching labelmap data');
          return;
        }

        // Apply the labelmap data using OHIF 3.9 API
        try {
          await services.segmentationService.setLabelmapData(data.segmentationId, data.buffer);

          console.log('✅ [Joiner] Labelmap data applied successfully');
        } catch (error) {
          console.error('❌ [Joiner] Error applying labelmap data:', error);
        }
      } catch (error) {
        console.error('❌ [Joiner] Error handling labelmap data:', error);
      }
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
    socket.on('brushEvent', handleBrushEvent);
    socket.on('labelmapData', handleLabelmapData);

    return () => {
      socket.off('segmentationEvent', handleSegmentationEvent);
      socket.off('allSegmentations', handleAllSegmentations);
      socket.off('brushEvent', handleBrushEvent);
      socket.off('labelmapData', handleLabelmapData);
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
                border: '1px solid #555',
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

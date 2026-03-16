'use client';

import { useState, useRef, useEffect, useCallback, memo } from "react";
import {
  Tldraw,
  useEditor,
  createShapeId,
  AssetRecordType,
} from "tldraw";
import "tldraw/tldraw.css";
import mermaid from 'mermaid';
import { GeminiLiveAPI } from "@/lib/live-api";
import { customShapeUtils } from "@/lib/shape-utils";
import { createToolHandler, LearningTopic } from "@/lib/tool-handlers";
import { AgentOrb, AgentStatusType } from "@/components/AgentOrb";
import { WakeUpAnimation } from "@/components/WakeUpAnimation";
import { getUserId } from "@/lib/user";

// Initialize Mermaid once at module level
mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });

// ─────────────────────────────────────────────────────────────────────────────
// TldrawInner — Mounts inside Tldraw context. Memoized to avoid re-renders.
// ─────────────────────────────────────────────────────────────────────────────
const TldrawInner = memo(function TldrawInner({
  isConnected,
  liveApiRef,
  onEquationRef,
  onDiagramRef,
  onChartRef,
  onResetPrinthead,
}: {
  isConnected: boolean;
  liveApiRef: React.MutableRefObject<GeminiLiveAPI | null>;
  onEquationRef: React.MutableRefObject<((latex: string, label?: string, id?: string) => Promise<void>) | null>;
  onDiagramRef: React.MutableRefObject<((code: string, id?: string) => Promise<void>) | null>;
  onChartRef: React.MutableRefObject<((config: any, id?: string) => Promise<void>) | null>;
  onResetPrinthead: React.MutableRefObject<(() => void) | null>;
}) {
  const editor = useEditor();

  // Track mount/unmount for debugging re-render loops
  useEffect(() => {
    console.log('[Vision] TldrawInner mounted');
    return () => console.log('[Vision] TldrawInner unmounted (cleanup running)');
  }, []);
  const lastAiShapeIdRef = useRef<any>(null);
  const lastSpawnYRef = useRef<number | null>(null);
  const processedCallsRef = useRef<Set<string>>(new Set());

  // Calculate where to place the next AI-spawned shape (vertical stack, no overlap)
  const getSpawnPosition = useCallback((w: number, h: number) => {
    if (lastSpawnYRef.current !== null) {
      return {
        x: editor.getViewportPageBounds().midX - w / 2,
        y: lastSpawnYRef.current + 200,
      };
    }
    const allShapeIds = Array.from(editor.getCurrentPageShapeIds());
    if (allShapeIds.length > 0) {
      const bounds = editor.getShapesPageBounds(allShapeIds);
      if (bounds) return { x: bounds.minX, y: bounds.maxY + 200 };
    }
    const vp = editor.getViewportPageBounds();
    return { x: vp.midX - w / 2, y: vp.midY - h / 2 };
  }, [editor]);

  // After placing a shape, track its bottom edge and pan the viewport to show it
  const finalizeSpawn = useCallback((id: any, h: number) => {
    lastAiShapeIdRef.current = id;
    const bounds = editor.getShapePageBounds(id);
    if (bounds) {
      lastSpawnYRef.current = bounds.maxY;
    } else if (lastSpawnYRef.current !== null) {
      lastSpawnYRef.current += h;
    }
    editor.centerOnPoint(
      { x: editor.getViewportPageBounds().midX, y: (lastSpawnYRef.current ?? 0) - 150 },
      { animation: { duration: 800 } }
    );
  }, [editor]);

  // Expose printhead reset to parent via ref
  useEffect(() => {
    onResetPrinthead.current = () => {
      lastAiShapeIdRef.current = null;
      lastSpawnYRef.current = null;
      processedCallsRef.current.clear();
    };
  }, [onResetPrinthead]);

  // Expose shape placement functions to the tool handler
  useEffect(() => {
    onEquationRef.current = async (latex, label, id) => {
      if (id && processedCallsRef.current.has(id)) return;
      if (id) processedCallsRef.current.add(id);
      const { x, y } = getSpawnPosition(300, 120);
      const shapeId = createShapeId();
      editor.createShape({ id: shapeId, type: 'latex', x, y, props: { latex, label: label ?? '', w: 300, h: 120 } });
      finalizeSpawn(shapeId, 120);
    };

    onDiagramRef.current = async (code, id) => {
      if (id && processedCallsRef.current.has(id)) return;
      if (id) processedCallsRef.current.add(id);
      const { x, y } = getSpawnPosition(400, 300);
      const shapeId = createShapeId();
      editor.createShape({ id: shapeId, type: 'mermaid', x, y, props: { code, w: 400, h: 300 } });
      finalizeSpawn(shapeId, 300);
    };

    onChartRef.current = async (config, id) => {
      if (id && processedCallsRef.current.has(id)) return;
      if (id) processedCallsRef.current.add(id);
      const { x, y } = getSpawnPosition(400, 300);
      const shapeId = createShapeId();
      editor.createShape({ id: shapeId, type: 'chart', x, y, props: { config, w: 400, h: 300 } });
      finalizeSpawn(shapeId, 300);
    };
  }, [editor, onEquationRef, onDiagramRef, onChartRef, getSpawnPosition, finalizeSpawn]);

  // ── Change-driven, idle-time screenshot capture ──────────────────────────
  //
  // Problem with fixed-interval toImage(): it runs every N seconds regardless
  // of what the browser is doing, blocking the main thread mid-frame → freeze.
  //
  // Solution:
  //   1. editor.store.listen() → set isDirtyRef on any shape change
  //   2. 2s debounce → only capture after drawing settles
  //   3. requestIdleCallback → run toImage() only when browser is idle
  //      (between frames, no active rendering) → zero frame drops
  //
  // Net result: captures happen only when the board actually changed AND the
  // browser has free time. Static board = no work at all.
  const isDirtyRef = useRef(false);
  const isCapturingRef = useRef(false);
  const lastCaptureTimeRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCallbackRef = useRef<number | null>(null);

  const doCapture = useCallback(async (isInitial = false) => {
    if (!liveApiRef.current) return false;

    if (isCapturingRef.current) {
      console.log(`[Vision] [${performance.now().toFixed(0)}ms] Skip: Capture already in progress`);
      return false;
    }

    const shapeIds = Array.from(editor.getCurrentPageShapeIds());
    if (shapeIds.length === 0) {
      console.log(`[Vision] [${performance.now().toFixed(0)}ms] Skip: Board is empty`);
      return false;
    }

    const tid = isInitial ? 'Initial' : 'Incremental';
    console.log(`[Vision] [${performance.now().toFixed(0)}ms] Starting ${tid} capture of ${shapeIds.length} shapes...`);
    isCapturingRef.current = true;

    try {
      const { blob } = await editor.toImage(shapeIds, {
        format: 'jpeg',
        quality: 0.8,
        background: true,
      });

      if (blob && liveApiRef.current) {
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const CHUNK = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
        }
        const b64 = btoa(binary);
        console.log(`[Vision] [${performance.now().toFixed(0)}ms] Sending frame (${Math.round(b64.length / 1024)} KB)`);
        liveApiRef.current.sendVideoFrame(b64, 'image/jpeg');
        lastCaptureTimeRef.current = Date.now();
        return true;
      }
    } catch (err) {
      console.error('[Vision] Capture error:', err);
    } finally {
      isCapturingRef.current = false;
    }
    return false;
  }, [editor, liveApiRef]);

  const startIdleCapture = useCallback(() => {
    if (!isDirtyRef.current) return;

    // If we're already capturing, don't clear timers! We want them to fire again 
    // to catch the change we just skipped.
    if (isCapturingRef.current) {
      console.log(`[Vision] [${performance.now().toFixed(0)}ms] Deferring: Capture in progress`);
      return;
    }

    console.log(`[Vision] [${performance.now().toFixed(0)}ms] Requesting idle callback...`);
    if (idleCallbackRef.current) cancelIdleCallback(idleCallbackRef.current);

    idleCallbackRef.current = requestIdleCallback(
      async (deadline) => {
        if (!isDirtyRef.current) return;

        const remaining = deadline.timeRemaining();
        if (remaining < 5 && !deadline.didTimeout) {
          console.log(`[Vision] [${performance.now().toFixed(0)}ms] Low idle time (${remaining.toFixed(1)}ms), but proceeding anyway to avoid starvation.`);
        }

        const success = await doCapture();
        if (success) {
          console.log(`[Vision] [${performance.now().toFixed(0)}ms] Capture SUCCESS — clearing dirty flag`);
          isDirtyRef.current = false;
          // Only clear timers after a CONFIRMED successful send
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
          debounceTimerRef.current = null;
          throttleTimerRef.current = null;
        }
      },
      { timeout: 2000 }
    );
  }, [doCapture]);

  const scheduleCapture = useCallback(() => {
    isDirtyRef.current = true;
    console.log(`[Vision] [${performance.now().toFixed(0)}ms] store change handled (dirty=true)`);

    // 1. Debounce (800ms)
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      console.log(`[Vision] [${performance.now().toFixed(0)}ms] Debounce triggered`);
      startIdleCapture();
    }, 800);

    // 2. Throttle (4s)
    if (!throttleTimerRef.current) {
      throttleTimerRef.current = setTimeout(() => {
        console.log(`[Vision] [${performance.now().toFixed(0)}ms] Throttle triggered`);
        startIdleCapture();
      }, 4000);
    }
  }, [startIdleCapture]);

  useEffect(() => {
    if (!isConnected) return;

    // Listen for any store change (shape added/moved/deleted)
    const unsubscribe = editor.store.listen(
      () => {
        console.log('[Vision] Change detected (store.listen)');
        scheduleCapture();
      },
      { scope: 'document' } // More permissive: react to all document changes
    );

    // Initial sync on connect
    console.log('[Vision] Performing initial sync on connect...');
    isDirtyRef.current = true;
    doCapture(true);

    // Periodically re-sync even if listener skips
    const heartbeatInterval = setInterval(() => {
      if (!isDirtyRef.current) {
        console.log(`[Vision] [${performance.now().toFixed(0)}ms] 10s Heartbeat: checking board...`);
        isDirtyRef.current = true;
        scheduleCapture();
      }
    }, 10000);

    return () => {
      unsubscribe();
      clearInterval(heartbeatInterval);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
      if (idleCallbackRef.current) cancelIdleCallback(idleCallbackRef.current);
    };
  }, [isConnected, editor, scheduleCapture, doCapture]);

  return null;
});

// ─────────────────────────────────────────────────────────────────────────────
// App root component
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [agentStatus, setAgentStatus] = useState<AgentStatusType>('disconnected');
  const [errorMsg, setErrorMsg] = useState('');
  const liveApiRef = useRef<GeminiLiveAPI | null>(null);

  const [showWakeUp, setShowWakeUp] = useState(false);
  const [isSpawning, setIsSpawning] = useState(false);
  const spawnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Audio controls
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState('');
  const [isMuted, setIsMuted] = useState(false);

  // Volume ring — updated imperatively to avoid 8 React re-renders/second
  const volumeRingRef = useRef<HTMLDivElement | null>(null);
  const gateIndicatorRef = useRef<HTMLDivElement | null>(null);

  // Notifications
  const [notifications, setNotifications] = useState<{ id: number; message: string; type: 'info' | 'error' | 'success' }[]>([]);
  const nextNotifId = useRef(0);

  const addNotification = useCallback((message: string, type: 'info' | 'error' | 'success' = 'info') => {
    setNotifications(prev => {
      if (prev.some(n => n.message === message)) return prev; // deduplicate
      const id = nextNotifId.current++;
      setTimeout(() => setNotifications(curr => curr.filter(n => n.id !== id)), 5000);
      return [...prev, { id, message, type }];
    });
  }, []);

  // Whiteboard tool refs (written by TldrawInner, read by tool handler)
  const onEquationRef = useRef<((latex: string, label?: string, id?: string) => Promise<void>) | null>(null);
  const onDiagramRef = useRef<((code: string, id?: string) => Promise<void>) | null>(null);
  const onChartRef = useRef<((config: any, id?: string) => Promise<void>) | null>(null);
  const onResetPrintheadRef = useRef<(() => void) | null>(null);

  // Learning Plan state
  const [plan, setPlan] = useState<LearningTopic[]>([]);
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [sidebarTopic, setSidebarTopic] = useState('');

  // Session History
  const [pastSessions, setPastSessions] = useState<any[]>([]);
  const [isFetchingSessions, setIsFetchingSessions] = useState(false);

  const fetchSessions = useCallback(async () => {
    setIsFetchingSessions(true);
    try {
      const res = await fetch('/api/sessions/list', {
        headers: { 'x-user-id': getUserId() }
      });
      const data = await res.json();
      if (data.sessions) setPastSessions(data.sessions);
    } catch (err) {
      console.error('[Sessions] Failed to fetch:', err);
    } finally {
      setIsFetchingSessions(false);
    }
  }, []);

  const handleDeleteSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation(); // prevent resuming when clicking delete
    if (!confirm('Are you sure you want to delete this session?')) return;

    try {
      const res = await fetch(`/api/sessions/delete?id=${sessionId}`, {
        method: 'DELETE',
        headers: { 'x-user-id': getUserId() }
      });
      if (!res.ok) throw new Error('Failed to delete');

      setPastSessions(prev => prev.filter(s => s.id !== sessionId));
      addNotification('Session deleted', 'success');
    } catch (err) {
      console.error('[Sessions] Delete error:', err);
      addNotification('Failed to delete session', 'error');
    }
  }, [addNotification]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Refs for tool handlers to avoid stale closures
  const planRef = useRef(plan);
  const sidebarTopicRef = useRef(sidebarTopic);

  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  useEffect(() => {
    sidebarTopicRef.current = sidebarTopic;
  }, [sidebarTopic]);

  const [sidebarTab, setSidebarTab] = useState<'plan' | 'history'>('plan');

  const handleClearPlan = useCallback(() => {
    if (plan.length === 0) return;
    if (confirm('Are you sure you want to clear the current learning plan?')) {
      setPlan([]);
      setSidebarTopic('');
      addNotification('Current plan cleared', 'info');

      if (liveApiRef.current && connectionState === 'connected') {
        liveApiRef.current.sendClientContent(
          `SYSTEM: The user has cleared the current learning plan. They want to start fresh or change topics. 
          Please acknowledge the reset and ask what they would like to focus on now.`
        );
      }
    }
  }, [plan, addNotification, connectionState]);

  const handleResumeSession = useCallback(async (session: any) => {
    setSidebarTopic(session.topic);
    setPlan(session.plan);
    setSidebarTab('plan');
    addNotification(`Resumed session: ${session.topic}`, 'success');

    if (liveApiRef.current && connectionState === 'connected') {
      liveApiRef.current.sendClientContent(
        `SYSTEM: The user has resumed a previous learning session about "${session.topic}". 
        The plan and progress have been restored in the sidebar. 
        Current plan state: ${JSON.stringify(session.plan)}.
        Please acknowledge this and continue the lesson from where you left off.`
      );
    }
  }, [addNotification, connectionState]);

  // Enumerate audio input devices on mount
  useEffect(() => {
    async function getDevices() {
      try {
        await navigator.mediaDevices?.getUserMedia({ audio: true });
        const all = await navigator.mediaDevices.enumerateDevices();
        const inputs = all.filter(d => d.kind === 'audioinput');
        setDevices(inputs);
        if (inputs.length > 0) setSelectedAudioId(inputs[0].deviceId);
      } catch (err) {
        console.error('[Devices] Failed to enumerate audio inputs:', err);
      }
    }
    getDevices();
  }, []);

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    setSelectedAudioId(newId);
    liveApiRef.current?.setAudioDevice(newId);
  };

  const handleMuteToggle = () => {
    const next = !isMuted;
    setIsMuted(next);
    liveApiRef.current?.setMuted(next);
  };

  const toggleConnection = async () => {
    if (connectionState === 'connected' || connectionState === 'connecting') {
      liveApiRef.current?.disconnect();
      return;
    }

    if (!liveApiRef.current) liveApiRef.current = new GeminiLiveAPI();
    const api = liveApiRef.current;

    api.onAgentStatusChange = (status) => {
      setAgentStatus(status);
      // Reset the virtual printhead when the AI finishes a turn
      if (status === 'connected') onResetPrintheadRef.current?.();
    };

    api.onStateChange = (state, err) => {
      setConnectionState(state);
      if (err) {
        setErrorMsg(err);
        if (err.includes('Attempting to reconnect')) addNotification(err, 'info');
        else if (err.includes('1008')) addNotification('Connection policy violation. Retrying...', 'error');
        else addNotification(`Connection Error: ${err}`, 'error');
      }
      if (state === 'connected') {
        addNotification('AI Tutor connected!', 'success');
        setShowWakeUp(true);
      }
      if (state === 'disconnected') addNotification('AI Tutor disconnected.', 'info');
    };

    // Bypass React state entirely for volume — write directly to DOM.
    // onVolumeChange fires ~8x/sec; setState here would cause 8 re-renders/sec.
    api.onVolumeChange = (rms) => {
      const normalized = Math.min(100, (rms / 0.1) * 100);
      const size = 24 + normalized * 0.32;
      if (volumeRingRef.current) {
        volumeRingRef.current.style.width = `${size}px`;
        volumeRingRef.current.style.height = `${size}px`;
      }
      if (gateIndicatorRef.current) {
        const clear = normalized > 10;
        gateIndicatorRef.current.style.backgroundColor = clear ? '#22c55e' : '#ef4444';
        gateIndicatorRef.current.title = clear ? 'Mic signal clear' : 'Signal too low (Noise Gate active)';
      }
    };

    api.onToolCall = createToolHandler({
      liveApi: api,
      planRef,
      setPlan,
      setIsGeneratingPlan,
      setSidebarTopic,
      sidebarTopicRef,
      setIsSpawning,
      spawnTimerRef,
      addNotification,
      onEquationRef,
      onDiagramRef,
      onChartRef,
    });

    setErrorMsg('');
    api.setAudioDevice(selectedAudioId);
    api.setMuted(isMuted);
    await api.connect();
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-white">
      {showWakeUp && <WakeUpAnimation onComplete={() => setShowWakeUp(false)} />}

      {/* Notifications */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {notifications.map(n => (
          <div
            key={n.id}
            className={`px-4 py-3 rounded-lg shadow-2xl text-sm font-medium border animate-in slide-in-from-right fade-in pointer-events-auto flex items-center gap-3 min-w-[300px] ${n.type === 'error' ? 'bg-red-50 border-red-200 text-red-700' :
              n.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                'bg-blue-50 border-blue-200 text-blue-700'
              }`}
          >
            <div className={`w-2 h-2 rounded-full shrink-0 ${n.type === 'error' ? 'bg-red-500' : n.type === 'success' ? 'bg-emerald-500' : 'bg-blue-500'
              }`} />
            {n.message}
          </div>
        ))}
      </div>

      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-zinc-50 border-b border-zinc-200">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-extralight tracking-[0.3em] font-sans text-zinc-900 uppercase select-none">senti</h1>
        </div>

        {/* Connection Controls */}
        <div className="flex items-center gap-4">
          {connectionState === 'error' && (
            <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 bg-red-50 border border-red-100 rounded-full">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-semibold text-red-600 truncate max-w-[150px]" title={errorMsg}>
                {errorMsg}
              </span>
            </div>
          )}

          <div className="flex items-center bg-white border border-zinc-200 rounded-full p-1 shadow-sm">
            <div className="flex items-center gap-1.5 px-3 py-1 border-r border-zinc-100">
              <div className={`w-2 h-2 rounded-full ${connectionState === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' :
                connectionState === 'connecting' ? 'bg-amber-500 animate-pulse' :
                  connectionState === 'error' ? 'bg-rose-500' : 'bg-zinc-300'
                }`} />
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">{connectionState}</span>
            </div>

            <div className="flex items-center gap-1 px-2">
              <button
                onClick={handleMuteToggle}
                className={`relative w-8 h-8 rounded-full transition-all flex items-center justify-center ${isMuted ? 'bg-rose-50 text-rose-500' : 'bg-transparent text-zinc-400 hover:text-zinc-600'
                  }`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {!isMuted && (
                  <div
                    ref={volumeRingRef}
                    className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/10 transition-all duration-75 pointer-events-none"
                    style={{ width: '20px', height: '20px' }}
                  />
                )}
                {isMuted ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                    <div
                      ref={gateIndicatorRef}
                      className="absolute bottom-1.5 right-1.5 w-1.5 h-1.5 rounded-full border border-white bg-rose-500 shadow-sm"
                    />
                  </>
                )}
              </button>

              <div className="relative">
                <select
                  className="text-[11px] font-bold text-zinc-600 bg-transparent border-none focus:ring-0 cursor-pointer max-w-[120px] pr-5 truncate appearance-none hover:text-zinc-900 transition-colors"
                  value={selectedAudioId}
                  onChange={handleDeviceChange}
                >
                  {devices.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Mic ${d.deviceId.slice(0, 5)}`}
                    </option>
                  ))}
                </select>
                <div className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none">
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400"><path d="m6 9 6 6 6-6"></path></svg>
                </div>
              </div>
            </div>
          </div>

          <button
            id="connect-button"
            onClick={toggleConnection}
            disabled={connectionState === 'connecting'}
            className={`h-9 px-6 rounded-full text-xs font-bold tracking-tight transition-all duration-300 relative ${connectionState === 'connected'
              ? 'bg-zinc-900 text-white hover:bg-zinc-800'
              : `bg-linear-to-r from-blue-600 via-indigo-600 to-blue-600 text-white hover:shadow-[0_0_20px_rgba(37,99,235,0.4)] disabled:opacity-50 animate-gradient ${connectionState === 'disconnected' ? 'animate-glow-blue' : ''}`
              }`}
          >
            {connectionState === 'connected' ? 'Disconnect' : 'Awaken Senti'}
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Whiteboard */}
        <main className="flex-1 relative">
          <div className="absolute inset-0">
            <Tldraw 
              {...(process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY ? { licenseKey: process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY } : {})}
              shapeUtils={customShapeUtils}
            >
              <TldrawInner
                isConnected={connectionState === 'connected'}
                liveApiRef={liveApiRef}
                onEquationRef={onEquationRef}
                onDiagramRef={onDiagramRef}
                onChartRef={onChartRef}
                onResetPrinthead={onResetPrintheadRef}
              />
            </Tldraw>
          </div>

          {/* Agent Orb */}
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center pointer-events-none">
            {isSpawning && (
              <div className="bg-blue-600 text-white px-5 py-2 rounded-full text-xs font-bold shadow-lg animate-bounce flex items-center gap-2 border-2 border-white mb-4">
                <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                Thinking...
              </div>
            )}
            <AgentOrb status={agentStatus} />
          </div>
        </main>

        {/* Learning Plan Sidebar */}
        <aside className="w-80 bg-zinc-50 border-l border-zinc-200 flex flex-col shadow-xl overflow-hidden">
          <div className="p-4 border-b border-zinc-200 bg-white">
            <div className="flex p-1 bg-zinc-100 rounded-lg mb-4">
              <button
                onClick={() => setSidebarTab('plan')}
                className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${sidebarTab === 'plan' ? 'bg-white text-blue-600 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
              >
                Current Plan
              </button>
              <button
                onClick={() => {
                  setSidebarTab('history');
                  fetchSessions();
                }}
                className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${sidebarTab === 'history' ? 'bg-white text-blue-600 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
              >
                History
              </button>
            </div>

            {sidebarTab === 'plan' ? (
              <>
                <div className="flex items-center justify-between group">
                  <h2 className="text-lg font-bold text-zinc-900 tracking-tight flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                    Learning Plan
                  </h2>
                  {plan.length > 0 && (
                    <button
                      onClick={handleClearPlan}
                      className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-rose-500 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {sidebarTopic && (
                  <p className="mt-1 text-sm text-zinc-500 font-medium">
                    Topic: <span className="text-blue-600">{sidebarTopic}</span>
                  </p>
                )}
              </>
            ) : (
              <h2 className="text-lg font-bold text-zinc-900 tracking-tight flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>
                Past Sessions
              </h2>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {sidebarTab === 'plan' ? (
              isGeneratingPlan ? (
                <div className="flex flex-col items-center justify-center h-40 space-y-3">
                  <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm font-medium text-zinc-500 italic">Designing your curriculum...</p>
                </div>
              ) : plan.length > 0 ? (
                plan.map((topic, index) => (
                  <div
                    key={topic.id}
                    className={`p-4 rounded-xl border transition-all duration-300 ${topic.status === 'in_progress' ? 'bg-blue-50 border-blue-200 shadow-sm ring-1 ring-blue-100' :
                      topic.status === 'completed' ? 'bg-green-50 border-green-200 opacity-80' :
                        'bg-white border-zinc-200 hover:border-zinc-300'
                      }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${topic.status === 'in_progress' ? 'bg-blue-600 text-white' :
                            topic.status === 'completed' ? 'bg-green-600 text-white' :
                              'bg-zinc-200 text-zinc-500'
                            }`}>
                            {topic.status.replace('_', ' ')}
                          </span>
                          <span className="text-xs font-mono text-zinc-400">Step {index + 1}</span>
                        </div>
                        <h3 className={`font-bold text-sm ${topic.status === 'completed' ? 'text-zinc-500 line-through' : 'text-zinc-900'}`}>
                          {topic.title}
                        </h3>
                        <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{topic.description}</p>
                        {topic.learning_outcome && (
                          <div className="mt-2 text-[11px] text-blue-700 bg-blue-100/50 px-2 py-1 rounded border border-blue-100">
                            <span className="font-bold uppercase text-[9px]">Outcome:</span> {topic.learning_outcome}
                          </div>
                        )}
                        {topic.exercises && topic.exercises.length > 0 && (
                          <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 px-2 py-1 rounded border border-amber-100">
                            <span className="font-bold uppercase text-[9px]">Practice:</span>
                            <ul className="list-disc ml-3 mt-1 space-y-0.5">
                              {topic.exercises.map((ex, i) => <li key={i}>{ex}</li>)}
                            </ul>
                          </div>
                        )}
                        {topic.examples && topic.examples.length > 0 && (
                          <div className="mt-2 text-[11px] text-zinc-700 bg-zinc-100 px-2 py-1 rounded border border-zinc-200">
                            <span className="font-bold uppercase text-[9px]">Examples:</span>
                            <ul className="list-disc ml-3 mt-1 space-y-0.5">
                              {topic.examples.map((ex, i) => <li key={i}>{ex}</li>)}
                            </ul>
                          </div>
                        )}
                        {topic.flow && (
                          <div className="mt-2 text-[10px] text-zinc-400 italic">Next: {topic.flow}</div>
                        )}
                        {topic.notes && (
                          <div className="mt-3 p-2 bg-black/5 rounded text-[11px] text-zinc-600 italic border-l-2 border-zinc-300">
                            <strong>Note:</strong> {topic.notes}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center p-4">
                  <div className="w-12 h-12 bg-zinc-100 rounded-full flex items-center justify-center mb-4">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>
                  </div>
                  <p className="text-sm font-medium text-zinc-500 italic">No plan active</p>
                  <p className="text-xs text-zinc-400 mt-2 max-w-[200px]">
                    Connect and tell the AI what you want to learn about to generate a structured curriculum.
                  </p>
                </div>
              )
            ) : (
              <div className="space-y-3">
                {isFetchingSessions ? (
                  <div className="flex flex-col items-center justify-center h-40 space-y-3">
                    <div className="w-6 h-6 border-3 border-zinc-300 border-t-blue-600 rounded-full animate-spin" />
                    <p className="text-xs text-zinc-400">Loading history...</p>
                  </div>
                ) : pastSessions.length > 0 ? (
                  pastSessions.map((session) => (
                    <div
                      key={session.id}
                      role="button"
                      onClick={() => handleResumeSession(session)}
                      className="w-full text-left p-4 rounded-xl border border-zinc-200 bg-white hover:border-blue-300 hover:shadow-md transition-all group relative cursor-pointer"
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest group-hover:text-blue-500 transition-colors">
                          {new Date(session.updatedAt).toLocaleDateString()}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => handleDeleteSession(e, session.id)}
                            className="p-1.5 rounded-md text-zinc-300 hover:text-rose-500 hover:bg-rose-50 transition-all opacity-0 group-hover:opacity-100"
                            title="Delete session"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
                          </button>
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-300 group-hover:text-blue-500 transition-colors"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
                        </div>
                      </div>
                      <h4 className="text-sm font-bold text-zinc-900 group-hover:text-blue-600 transition-colors">{session.topic}</h4>
                      <div className="flex items-center gap-2 mt-2">
                        <div className="flex -space-x-1">
                          {session.plan.slice(0, 3).map((t: any, i: number) => (
                            <div key={i} className={`w-2 h-2 rounded-full border border-white ${t.status === 'completed' ? 'bg-green-500' : 'bg-zinc-300'}`} />
                          ))}
                        </div>
                        <span className="text-[10px] text-zinc-500 font-medium">
                          {session.plan.filter((t: any) => t.status === 'completed').length}/{session.plan.length} topics done
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-12 px-4">
                    <div className="w-12 h-12 bg-zinc-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-300"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>
                    </div>
                    <p className="text-sm text-zinc-400 italic">No saved sessions yet.</p>
                    <p className="text-xs text-zinc-400 mt-3 leading-relaxed">
                      You can tell the agent to <span className="text-blue-500 font-bold">"save our session"</span> to keep your progress synchronized here.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

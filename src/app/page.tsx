'use client';

import { useState, useRef, useEffect, useCallback } from "react";
import { Tldraw, useEditor, createShapeId } from "tldraw";
import "tldraw/tldraw.css";
import katex from "katex";
import "katex/dist/katex.min.css";
import { GeminiLiveAPI } from "@/lib/live-api";
import { 
  Geometry2d, 
  HTMLContainer, 
  RecordProps, 
  Rectangle2d, 
  ShapeUtil, 
  T, 
  TLShape, 
  resizeBox, 
  TLResizeInfo 
} from 'tldraw'

const MY_LATEX_SHAPE_TYPE = 'latex'

// [1] Define the shape props
declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[MY_LATEX_SHAPE_TYPE]: { w: number; h: number; latex: string; label: string }
	}
}

type ILatexShape = TLShape<typeof MY_LATEX_SHAPE_TYPE>

// [2] Define the Shape Util
export class LatexShapeUtil extends ShapeUtil<ILatexShape> {
	static override type = MY_LATEX_SHAPE_TYPE
	static override props: RecordProps<ILatexShape> = {
		w: T.number,
		h: T.number,
		latex: T.string,
		label: T.string,
	}

	override getDefaultProps(): ILatexShape['props'] {
		return {
			w: 300,
			h: 120,
			latex: '',
			label: '',
		}
	}

	override canEdit() { return false }
	override canResize() { return true }
	override isAspectRatioLocked() { return false }

	override getGeometry(shape: ILatexShape): Geometry2d {
		return new Rectangle2d({
			width: shape.props.w,
			height: shape.props.h,
			isFilled: true,
		})
	}

	override onResize(shape: any, info: TLResizeInfo<any>) {
		return resizeBox(shape, info)
	}

	override component(shape: ILatexShape) {
		const katexHtml = katex.renderToString(shape.props.latex, {
			throwOnError: false, 
			displayMode: true, 
		});

		return (
			<HTMLContainer style={{ 
        backgroundColor: 'white', 
        padding: '16px 24px', 
        borderRadius: '12px', 
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        border: '1px solid #eee'
      }}>
        {shape.props.label && (
          <div style={{ 
            fontFamily: 'sans-serif', 
            fontSize: '12px', 
            color: '#666', 
            marginBottom: '8px', 
            fontWeight: 600,
            textAlign: 'center'
          }}>
            {shape.props.label}
          </div>
        )}
				<div dangerouslySetInnerHTML={{ __html: katexHtml }} />
			</HTMLContainer>
		);
	}

	override indicator(shape: ILatexShape) {
		return <rect width={shape.props.w} height={shape.props.h} rx="12" ry="12" />
	}
}

const customShapeUtils = [LatexShapeUtil]


// Internal component — has access to the `useEditor` hook inside <Tldraw> context.
function TldrawInner({ 
  isConnected, 
  liveApiRef,
  onEquationRef 
}: { 
  isConnected: boolean; 
  liveApiRef: React.MutableRefObject<GeminiLiveAPI | null>;
  onEquationRef: React.MutableRefObject<((latex: string, label?: string) => Promise<void>) | null>;
}) {
  const editor = useEditor();

  // Expose equation placement function via ref so parent can call it
  useEffect(() => {
    onEquationRef.current = async (latex: string, label?: string) => {
      console.log(`[Equation] Creating LaTeX Shape: ${latex}`);
      try {
        // Place near center of current viewport
        const vp = editor.getViewportPageBounds();
        const x = vp.midX - 150;
        const y = vp.midY - 60 + (Math.random() - 0.5) * 80;

        const shapeId = createShapeId();
        editor.createShape({
          id: shapeId,
          type: 'latex',
          x,
          y,
          props: { 
            latex, 
            label: label ?? '',
            w: 300,
            h: 120
          },
        });

        console.log(`[Equation] Placed shape ${shapeId} at (${Math.round(x)}, ${Math.round(y)})`);
      } catch (err) {
        console.error('[Equation] Failed to create equation shape:', err);
      }
    };
  }, [editor, onEquationRef]);

  // Screenshot → send to Gemini every 3s when connected
  const sendScreenshot = useCallback(async () => {
    if (!isConnected || !liveApiRef.current) return;
    
    try {
      const shapeIds = editor.getCurrentPageShapeIds();
      if (shapeIds.size === 0) return;

      // Use Tldraw's native optimized export (v4.4.0 uses toImage)
      const { blob } = await editor.toImage(Array.from(shapeIds), {
        format: 'jpeg',
        quality: 0.8,
        background: true,
      });

      if (blob) {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Jpeg = (reader.result as string).split(',')[1];
          if (base64Jpeg) {
            liveApiRef.current?.sendVideoFrame(base64Jpeg, 'image/jpeg');
          }
        };
        reader.readAsDataURL(blob);
      }
    } catch (err) {
      console.error('Failed to capture screenshot:', err);
    }
  }, [editor, isConnected, liveApiRef]);

  useEffect(() => {
    if (!isConnected) return;
    sendScreenshot();
    const interval = setInterval(sendScreenshot, 3000); // 3s for better performance
    return () => clearInterval(interval);
  }, [isConnected, sendScreenshot]);

  return null;
}

export default function App() {
  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const liveApiRef = useRef<GeminiLiveAPI | null>(null);

  // Audio controls
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string>('');
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState<number>(0);

  // Equation tool — a ref so TldrawInner can write to it without re-renders
  const onEquationRef = useRef<((latex: string, label?: string) => Promise<void>) | null>(null);

  useEffect(() => {
    async function getDevices() {
      try {
        await navigator.mediaDevices?.getUserMedia({ audio: true });
        const dev = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = dev.filter((d) => d.kind === 'audioinput');
        setDevices(audioInputs);
        if (audioInputs.length > 0) setSelectedAudioId(audioInputs[0].deviceId);
      } catch (err) {
        console.error('Failed to enumerate devices', err);
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
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    liveApiRef.current?.setMuted(nextMute);
  };

  const toggleConnection = async () => {
    if (connectionState === 'connected' || connectionState === 'connecting') {
      liveApiRef.current?.disconnect();
    } else {
      if (!liveApiRef.current) {
        liveApiRef.current = new GeminiLiveAPI();

        liveApiRef.current.onStateChange = (state, err) => {
          setConnectionState(state);
          if (err) setErrorMsg(err);
        };

        liveApiRef.current.onVolumeChange = (vol) => {
          const normalized = Math.min(100, Math.max(0, (vol / 4000) * 100));
          setVolume(normalized);
        };

        // Wire up the show_equation tool call handler
        liveApiRef.current.onToolCall = async (name, args, id) => {
          console.log(`%c[Gemini Tool Call] %c${name}`, "color: blue; font-weight: bold", "color: black", args);

          if (name === 'show_equation') {
            const { latex, label } = args as { latex: string; label?: string };
            try {
              if (onEquationRef.current) {
                await onEquationRef.current(latex, label);
              }
              console.log(`%c[Gemini Tool Success] %cEquation rendered`, "color: green; font-weight: bold", "color: black");
              // Confirm success back to Gemini so it can continue speaking
              liveApiRef.current?.sendToolResponse(id, name, {
                success: true,
                message: `Equation rendered on the whiteboard${label ? `: ${label}` : ''}.`
              });
            } catch (e: any) {
              console.error(`[Gemini Tool Error]`, e);
              liveApiRef.current?.sendToolResponse(id, name, {
                success: false,
                error: e?.message ?? 'Failed to render equation'
              });
            }
          } else {
            // Unknown tool — respond gracefully
            liveApiRef.current?.sendToolResponse(id, name, { success: false, error: 'Unknown tool' });
          }
        };
      }

      setErrorMsg('');
      liveApiRef.current.setAudioDevice(selectedAudioId);
      liveApiRef.current.setMuted(isMuted);
      await liveApiRef.current.connect();
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-zinc-50 border-b border-zinc-200">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-zinc-900 tracking-tight">Senti</h1>
          <nav className="hidden sm:flex items-center gap-4 text-sm font-medium text-zinc-600">
            <a href="#" className="hover:text-zinc-900 transition-colors">Home</a>
            <a href="#" className="hover:text-zinc-900 transition-colors">About</a>
            <a href="#" className="hover:text-zinc-900 transition-colors">Settings</a>
          </nav>
        </div>

        {/* Connection Controls */}
        <div className="flex items-center gap-3">
          {connectionState === 'error' && (
            <span className="text-sm font-medium text-red-600 max-w-[200px] truncate" title={errorMsg}>
              {errorMsg}
            </span>
          )}

          {/* Device selector */}
          <select
            className="text-sm border border-zinc-300 rounded-md px-2 py-1 bg-white truncate max-w-[150px]"
            value={selectedAudioId}
            onChange={handleDeviceChange}
          >
            {devices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 5)}...`}</option>
            ))}
          </select>

          {/* Mute toggle with volume ring */}
          <button
            onClick={handleMuteToggle}
            className={`p-2 rounded-full border transition-colors flex items-center justify-center ${
              isMuted ? 'bg-red-100 border-red-300 text-red-600' : 'bg-white border-zinc-300 text-zinc-600 hover:bg-zinc-100'
            }`}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
            ) : (
              <div className="relative">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                {connectionState === 'connected' && volume > 0 && (
                  <div
                    className="absolute rounded-full border-2 border-green-500 opacity-50"
                    style={{
                      top: '-4px', left: '-4px', right: '-4px', bottom: '-4px',
                      transform: `scale(${1 + (volume / 100)})`,
                      transition: 'transform 0.1s ease-out'
                    }}
                  />
                )}
              </div>
            )}
          </button>

          <div className="flex items-center gap-2 text-sm font-medium mr-2">
            <div className={`w-2.5 h-2.5 rounded-full ${
              connectionState === 'connected' ? 'bg-green-500' :
              connectionState === 'connecting' ? 'bg-yellow-500 animate-pulse' :
              connectionState === 'error' ? 'bg-red-500' : 'bg-zinc-400'
            }`} />
            <span className="capitalize text-zinc-700">{connectionState}</span>
          </div>

          <button
            onClick={toggleConnection}
            disabled={connectionState === 'connecting'}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              connectionState === 'connected'
                ? 'bg-zinc-200 text-zinc-900 hover:bg-zinc-300'
                : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
            }`}
          >
            {connectionState === 'connected' ? 'Disconnect' : 'Connect AI'}
          </button>
        </div>
      </header>

      {/* Main Tldraw Area */}
      <main className="flex-1 relative">
        <div className="absolute inset-0">
          <Tldraw persistenceKey="senti-tldraw" shapeUtils={customShapeUtils}>
            <TldrawInner
              isConnected={connectionState === 'connected'}
              liveApiRef={liveApiRef}
              onEquationRef={onEquationRef}
            />
          </Tldraw>
        </div>
      </main>
    </div>
  );
}

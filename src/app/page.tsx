'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { 
  Tldraw, 
  useEditor, 
  createShapeId,
  Geometry2d, 
  HTMLContainer, 
  RecordProps, 
  Rectangle2d, 
  ShapeUtil, 
  T, 
  TLShape, 
  resizeBox, 
  TLResizeInfo,
  AssetRecordType
} from "tldraw";
import "tldraw/tldraw.css";
import katex from "katex";
import "katex/dist/katex.min.css";
import mermaid from 'mermaid';
import functionPlot from 'function-plot';
import { GeminiLiveAPI } from "@/lib/live-api";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AgentOrb, AgentStatusType } from "@/components/AgentOrb";

// Initialize Mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
});

const MY_LATEX_SHAPE_TYPE = 'latex'
const MY_MERMAID_SHAPE_TYPE = 'mermaid'
const MY_CHART_SHAPE_TYPE = 'chart'

// [1] Define the shape props
declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[MY_LATEX_SHAPE_TYPE]: { w: number; h: number; latex: string; label: string }
		[MY_MERMAID_SHAPE_TYPE]: { w: number; h: number; code: string }
		[MY_CHART_SHAPE_TYPE]: { w: number; h: number; config: any }
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

// [3] Mermaid Shape Util
type IMermaidShape = TLShape<typeof MY_MERMAID_SHAPE_TYPE>
export class MermaidShapeUtil extends ShapeUtil<IMermaidShape> {
  static override type = MY_MERMAID_SHAPE_TYPE
  static override props: RecordProps<IMermaidShape> = {
    w: T.number,
    h: T.number,
    code: T.string,
  }

  override getDefaultProps(): IMermaidShape['props'] {
    return { w: 400, h: 300, code: 'graph TD; A-->B;' }
  }

  override canEdit() { return false }
  override canResize() { return true }

  override getGeometry(shape: IMermaidShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onResize(shape: any, info: TLResizeInfo<any>) {
    return resizeBox(shape, info)
  }

  override component(shape: IMermaidShape) {
    const [svg, setSvg] = useState<string>('');
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      let isMounted = true;
      const render = async () => {
        try {
          const id = `mermaid-${shape.id.replace(/:/g, '-')}`;
          let { svg: svgContent } = await mermaid.render(id, shape.props.code);
          // Force SVG to fill container and scale properly without conflicting styles (fixes flickers for flow diagrams)
          svgContent = svgContent
            .replace(/(<svg[^>]*)width="[^"]*"/i, '$1')
            .replace(/(<svg[^>]*)height="[^"]*"/i, '$1')
            .replace(/(<svg[^>]*)style="[^"]*"/i, '$1')
            .replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; object-fit: contain;" ');
          if (isMounted) setSvg(svgContent);
        } catch (e) {
          console.error('Mermaid render error', e);
        }
      };
      render();
      return () => { isMounted = false; };
    }, [shape.props.code, shape.id]);

    return (
      <HTMLContainer style={{ 
        backgroundColor: 'white', 
        padding: '16px', 
        borderRadius: '12px', 
        boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        border: '1px solid #eee'
      }}>
        <div 
          ref={containerRef}
          style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          dangerouslySetInnerHTML={{ __html: svg }} 
        />
      </HTMLContainer>
    );
  }

  override indicator(shape: IMermaidShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx="12" ry="12" />
  }
}

// [4] Chart Shape Util
type IChartShape = TLShape<typeof MY_CHART_SHAPE_TYPE>
export class ChartShapeUtil extends ShapeUtil<IChartShape> {
  static override type = MY_CHART_SHAPE_TYPE
  static override props: RecordProps<IChartShape> = {
    w: T.number,
    h: T.number,
    config: T.any,
  }

  override getDefaultProps(): IChartShape['props'] {
    return { 
      w: 400, 
      h: 300, 
      config: { 
        title: 'Function Plot',
        data: [{ fn: 'x^2', color: 'blue' }] 
      } 
    }
  }

  override canEdit() { return false }
  override canResize() { return true }

  override getGeometry(shape: IChartShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onResize(shape: any, info: TLResizeInfo<any>) {
    return resizeBox(shape, info)
  }

  override component(shape: IChartShape) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!containerRef.current) return;
      try {
        // Map the Gemini tool args to function-plot's expected config
        const { title, functions, data, xRange, yRange, ...rest } = shape.props.config;
        
        const config: any = {
          target: containerRef.current,
          width: shape.props.w - 40,
          height: shape.props.h - 80,
          grid: true,
          // Deep clone the data to allow function-plot to mutate it
          data: JSON.parse(JSON.stringify(functions || data || [])),
          ...rest
        };

        if (xRange) config.xAxis = { domain: xRange };
        if (yRange) config.yAxis = { domain: yRange };

        // Ensure we don't pass the title to functionPlot to avoid double rendering
        // as we render it ourselves in the component UI below.
        delete config.title;

        functionPlot(config);
      } catch (e) {
        console.error('FunctionPlot render error', e);
      }
    }, [shape.props.config, shape.props.w, shape.props.h]);

    return (
      <HTMLContainer style={{ 
        backgroundColor: 'white', 
        padding: '16px', 
        borderRadius: '12px', 
        boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        border: '1px solid #eee'
      }}>
        {shape.props.config.title && (
          <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '8px', color: '#333' }}>
            {shape.props.config.title}
          </div>
        )}
        <div ref={containerRef} />
      </HTMLContainer>
    );
  }

  override indicator(shape: IChartShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx="12" ry="12" />
  }
}

const customShapeUtils = [LatexShapeUtil, MermaidShapeUtil, ChartShapeUtil]

interface LearningTopic {
  id: string;
  title: string;
  description: string;
  status: 'not_started' | 'in_progress' | 'completed';
  notes?: string;
}


function TldrawInner({ 
  isConnected, 
  liveApiRef,
  onEquationRef,
  onDiagramRef,
  onChartRef,
  onImageRef
}: { 
  isConnected: boolean; 
  liveApiRef: React.MutableRefObject<GeminiLiveAPI | null>;
  onEquationRef: React.MutableRefObject<((latex: string, label?: string) => Promise<void>) | null>;
  onDiagramRef: React.MutableRefObject<((code: string) => Promise<void>) | null>;
  onChartRef: React.MutableRefObject<((config: any) => Promise<void>) | null>;
  onImageRef: React.MutableRefObject<((url: string, w: number, h: number) => Promise<void>) | null>;
}) {
  const editor = useEditor();

  // Expose equation placement function via ref so parent can call it
  useEffect(() => {
    onEquationRef.current = async (latex: string, label?: string) => {
      console.log(`[Equation] Creating LaTeX Shape: ${latex}`);
      try {
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

    onDiagramRef.current = async (code: string) => {
      console.log(`[Diagram] Creating Mermaid Shape`);
      try {
        const vp = editor.getViewportPageBounds();
        const x = vp.midX - 200;
        const y = vp.midY - 150 + (Math.random() - 0.5) * 80;

        const shapeId = createShapeId();
        editor.createShape({
          id: shapeId,
          type: 'mermaid',
          x,
          y,
          props: { 
            code,
            w: 400,
            h: 300
          },
        });
        console.log(`[Diagram] Placed shape ${shapeId} at (${Math.round(x)}, ${Math.round(y)})`);
      } catch (err) {
        console.error('[Diagram] Failed to create diagram shape:', err);
      }
    };

    onChartRef.current = async (config: any) => {
      console.log(`[Chart] Creating Chart Shape`);
      try {
        const vp = editor.getViewportPageBounds();
        const x = vp.midX - 200;
        const y = vp.midY - 150 + (Math.random() - 0.5) * 80;

        const shapeId = createShapeId();
        editor.createShape({
          id: shapeId,
          type: 'chart',
          x,
          y,
          props: { 
            config,
            w: 400,
            h: 300
          },
        });
        console.log(`[Chart] Placed shape ${shapeId} at (${Math.round(x)}, ${Math.round(y)})`);
      } catch (err) {
        console.error('[Chart] Failed to create chart shape:', err);
      }
    };

    onImageRef.current = async (url: string, w: number, h: number) => {
      console.log(`[Image] Creating AI Image Asset: ${url}`);
      try {
        const vp = editor.getViewportPageBounds();
        const x = vp.midX - w / 2;
        const y = vp.midY - h / 2 + (Math.random() - 0.5) * 80;

        const assetId = AssetRecordType.createId();
        editor.createAssets([{
          id: assetId,
          type: 'image',
          typeName: 'asset',
          props: {
            w,
            h,
            name: 'ai-fetched-diagram',
            isAnimated: false,
            mimeType: 'image/jpeg',
            src: url,
          },
          meta: {},
        }]);

        const shapeId = createShapeId();
        editor.createShape({
          id: shapeId,
          type: 'image',
          x,
          y,
          props: {
            assetId,
            w,
            h,
          },
        });
        console.log(`[Image] Placed shape ${shapeId} at (${Math.round(x)}, ${Math.round(y)})`);
      } catch (err) {
        console.error('[Image] Failed to create image shape:', err);
      }
    };
  }, [editor, onEquationRef, onDiagramRef, onChartRef, onImageRef]);

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
  const [agentStatus, setAgentStatus] = useState<AgentStatusType>('disconnected');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const liveApiRef = useRef<GeminiLiveAPI | null>(null);

  // Audio controls
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string>('');
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState<number>(0);

  // Notifications state
  const [notifications, setNotifications] = useState<{ id: number; message: string; type: 'info' | 'error' | 'success' }[]>([]);
  const nextNotificationId = useRef(0);

  const addNotification = useCallback((message: string, type: 'info' | 'error' | 'success' = 'info') => {
    setNotifications(prev => {
      if (prev.some(n => n.message === message)) return prev;
      const id = nextNotificationId.current++;
      setTimeout(() => {
        setNotifications(curr => curr.filter(n => n.id !== id));
      }, 5000);
      return [...prev, { id, message, type }];
    });
  }, []);

  // Tools — refs so TldrawInner can write to them without re-renders
  const onEquationRef = useRef<((latex: string, label?: string) => Promise<void>) | null>(null);
  const onDiagramRef = useRef<((code: string) => Promise<void>) | null>(null);
  const onChartRef = useRef<((config: any) => Promise<void>) | null>(null);
  const onImageRef = useRef<((url: string, w: number, h: number) => Promise<void>) | null>(null);

  // Learning Plan State
  const [plan, setPlan] = useState<LearningTopic[]>([]);
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [sidebarTopic, setSidebarTopic] = useState<string>("");

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

  // Keep AI informed about the learning plan
  useEffect(() => {
    if (connectionState === 'connected' && plan.length > 0 && liveApiRef.current) {
      const planSummary = plan.map(t => `- [${t.status}] ${t.title}: ${t.description} ${t.notes ? `(Notes: ${t.notes})` : ''}`).join('\n');
      liveApiRef.current.sendClientContent(
        `SYSTEM UPDATE: Current Learning Plan status:\n${planSummary}`
      );
    }
  }, [plan, connectionState]);

  const toggleConnection = async () => {
    if (connectionState === 'connected' || connectionState === 'connecting') {
      liveApiRef.current?.disconnect();
    } else {
      if (!liveApiRef.current) {
        liveApiRef.current = new GeminiLiveAPI();
      }

      liveApiRef.current.onAgentStatusChange = (status) => {
        setAgentStatus(status);
      };

      liveApiRef.current.onStateChange = (state: 'disconnected' | 'connecting' | 'connected' | 'error', err?: string) => {
        setConnectionState(state);
        if (err) {
          setErrorMsg(err);
          // Special handling for reconnection or 1008
          if (err.includes('Attempting to reconnect')) {
            addNotification(err, 'info');
          } else if (err.includes('1008')) {
            addNotification('Connection policy violation. Retrying with corrected format...', 'error');
          } else {
            addNotification(`Connection Error: ${err}`, 'error');
          }
        }
        if (state === 'connected') addNotification('AI Tutor connected!', 'success');
        if (state === 'disconnected') addNotification('AI Tutor disconnected.', 'info');
      };

      liveApiRef.current.onVolumeChange = (vol: number) => {
        const normalized = Math.min(100, Math.max(0, (vol / 4000) * 100));
        setVolume(normalized);
      };

      liveApiRef.current.onToolCall = async (name: string, args: any, id: string) => {
        console.log(`%c[Gemini Tool Call] %c${name}`, "color: blue; font-weight: bold", "color: black", args);

        if (name === 'show_equation') {
          const { latex, label } = args as { latex: string; label?: string };
          try {
            if (onEquationRef.current) {
              await onEquationRef.current(latex, label);
            }
            liveApiRef.current?.sendToolResponse(id, name, {
              success: true,
              message: `Equation rendered on the whiteboard${label ? `: ${label}` : ''}.`
            });
          } catch (e: any) {
            liveApiRef.current?.sendToolResponse(id, name, {
              success: false,
              error: e?.message ?? 'Failed to render equation'
            });
          }
        } else if (name === 'create_learning_plan') {
          const { topic } = args as { topic: string };
          setIsGeneratingPlan(true);
          setSidebarTopic(topic);
          try {
            const res = await fetch('/api/plan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ topic })
            });
            
            if (!res.ok) {
              const errData = await res.json();
              throw new Error(errData.error || 'Failed to fetch plan');
            }

            const planNodes = await res.json() as any[];

            const processedPlan: LearningTopic[] = planNodes.map(node => ({
              ...node,
              status: 'not_started',
              notes: ''
            }));

            setPlan(processedPlan);
            setIsGeneratingPlan(false);
            addNotification(`Learning plan for ${topic} generated!`, 'success');

            liveApiRef.current?.sendToolResponse(id, name, {
              success: true,
              plan: processedPlan,
              message: `Learning plan for ${topic} created and displayed in the student's sidebar.`
            });
          } catch (err: any) {
            console.error("Plan creation failed", err);
            liveApiRef.current?.sendToolResponse(id, name, {
              success: false,
              error: err.message
            });
          }
        } else if (name === 'generate_diagram') {
          const { code } = args as { code: string };
          
          // Robustly clean any markdown ticks or leading "mermaid" declarations
          let cleanCode = code.trim();
          if (cleanCode.startsWith('```')) {
            cleanCode = cleanCode.replace(/^```[^\n]*\n?/i, '').replace(/```$/i, '').trim();
          }
          if (cleanCode.toLowerCase().startsWith('mermaid')) {
            cleanCode = cleanCode.substring(7).trim();
          }

          try {
            // Pre-validate diagram syntax to avoid placing blank white shapes on fail
            await mermaid.parse(cleanCode);

            if (onDiagramRef.current) {
              await onDiagramRef.current(cleanCode);
            }
            liveApiRef.current?.sendToolResponse(id, name, {
              success: true,
              message: `Diagram rendered on the whiteboard.`
            });
          } catch (e: any) {
            console.error('Mermaid pre-validation error', e);
            liveApiRef.current?.sendToolResponse(id, name, {
              success: false,
              error: `Mermaid Syntax Error: ${e?.message ?? 'Failed to parse diagram code. Please fix syntax and try again.'}`
            });
          }
        } else if (name === 'generate_graph') {
          const config = args;
          try {
            if (onChartRef.current) {
              await onChartRef.current(config);
            }
            liveApiRef.current?.sendToolResponse(id, name, {
              success: true,
              message: `Chart rendered on the whiteboard.`
            });
          } catch (e: any) {
            liveApiRef.current?.sendToolResponse(id, name, {
              success: false,
              error: e?.message ?? 'Failed to render chart'
            });
          }
        } else if (name === 'fetch_reference_image') {
          const { search_query } = args as { search_query: string };
          try {
            const apiRes = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(search_query)}&gsrnamespace=6&gsrlimit=1&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`);
            const data = await apiRes.json();
            const pages = data.query?.pages;
            if (!pages) throw new Error(`No images found for "${search_query}"`);
            
            const pageId = Object.keys(pages)[0];
            const info = pages[pageId].imageinfo[0];
            
            let { url, width, height } = info;
            
            // Normalize size
            const max = 600;
            if (width > max || height > max) {
              const r = width / height;
              if (width > height) { width = max; height = max / r; }
              else { height = max; width = max * r; }
            }

            if (onImageRef.current) {
              await onImageRef.current(url, width, height);
            }
            liveApiRef.current?.sendToolResponse(id, name, {
              success: true,
              message: `Reference image for "${search_query}" placed on board.`
            });
          } catch (e: any) {
            liveApiRef.current?.sendToolResponse(id, name, { success: false, error: e.message });
          }
        } else if (name === 'get_learning_plan') {
          liveApiRef.current?.sendToolResponse(id, name, {
            success: true,
            plan: plan,
            message: `Current learning plan retrieved. Total topics: ${plan.length}.`
          });
        } else if (name === 'update_learning_progress') {
          const { topic_id, status, notes } = args as { topic_id: string; status: 'not_started' | 'in_progress' | 'completed'; notes?: string };
          setPlan(prev => prev.map(t => 
            t.id === topic_id || t.title === topic_id ? { ...t, status, notes: notes ?? t.notes } : t
          ));
          liveApiRef.current?.sendToolResponse(id, name, {
            success: true,
            message: `Topic ID ${topic_id} is now ${status}. Notes updated: ${notes ? 'yes' : 'no'}.`
          });
        } else {
          liveApiRef.current?.sendToolResponse(id, name, { success: false, error: 'Unknown tool' });
        }
      };

      setErrorMsg('');
      if (liveApiRef.current) {
        liveApiRef.current.setAudioDevice(selectedAudioId);
        liveApiRef.current.setMuted(isMuted);
        await liveApiRef.current.connect();
      }
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-white">
      {/* Notifications Overlay */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {notifications.map(n => (
          <div 
            key={n.id} 
            className={`px-4 py-3 rounded-lg shadow-2xl text-sm font-medium border animate-in slide-in-from-right fade-in pointer-events-auto flex items-center gap-3 min-w-[300px] ${
              n.type === 'error' ? 'bg-red-50 border-red-200 text-red-700' :
              n.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
              'bg-blue-50 border-blue-200 text-blue-700'
            }`}
          >
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              n.type === 'error' ? 'bg-red-500' : n.type === 'success' ? 'bg-emerald-500' : 'bg-blue-500'
            }`} />
            {n.message}
          </div>
        ))}
      </div>

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
                {/* Volume Ring */}
                <div 
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/20 transition-all duration-75 pointer-events-none"
                  style={{ 
                    width: `${24 + volume * 0.8}px`, 
                    height: `${24 + volume * 0.8}px` 
                  }}
                />
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                
                {/* Threshold Dot */}
                <div 
                  className={`absolute -bottom-1 -right-1 w-2 h-2 rounded-full border border-white shadow-sm transition-colors ${
                    volume > 0.15 ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                  title={volume > 0.15 ? 'Mic signal clear' : 'Signal too low (Noise Gate active)'}
                />
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

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Whiteboard */}
        <main className="flex-1 relative">
          <div className="absolute inset-0">
            <Tldraw persistenceKey="senti-tldraw" shapeUtils={customShapeUtils}>
              <TldrawInner
                isConnected={connectionState === 'connected'}
                liveApiRef={liveApiRef}
                onEquationRef={onEquationRef}
                onDiagramRef={onDiagramRef}
                onChartRef={onChartRef}
                onImageRef={onImageRef}
              />
            </Tldraw>
          </div>

          {/* Agent Orb Visualization */}
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
            <AgentOrb status={agentStatus} />
          </div>
        </main>

        {/* Learning Plan Sidebar */}
        <aside className="w-80 bg-zinc-50 border-l border-zinc-200 flex flex-col shadow-xl overflow-hidden">
          <div className="p-6 border-b border-zinc-200 bg-white">
            <h2 className="text-lg font-bold text-zinc-900 tracking-tight flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
              Learning Plan
            </h2>
            {sidebarTopic && (
              <p className="mt-1 text-sm text-zinc-500 font-medium">Topic: <span className="text-blue-600">{sidebarTopic}</span></p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {isGeneratingPlan ? (
              <div className="flex flex-col items-center justify-center h-40 space-y-3">
                <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-sm font-medium text-zinc-500 italic">Designing your curriculum...</p>
              </div>
            ) : plan.length > 0 ? (
              plan.map((topic, index) => (
                <div 
                  key={topic.id} 
                  className={`p-4 rounded-xl border transition-all duration-300 ${
                    topic.status === 'in_progress' ? 'bg-blue-50 border-blue-200 shadow-sm ring-1 ring-blue-100' :
                    topic.status === 'completed' ? 'bg-green-50 border-green-200 opacity-80' : 
                    'bg-white border-zinc-200 hover:border-zinc-300'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                          topic.status === 'in_progress' ? 'bg-blue-600 text-white' :
                          topic.status === 'completed' ? 'bg-green-600 text-white' : 
                          'bg-zinc-200 text-zinc-500'
                        }`}>
                          {topic.status.replace('_', ' ')}
                        </span>
                        <span className="text-xs font-mono text-zinc-400">Step {index + 1}</span>
                      </div>
                      <h3 className={`font-bold text-sm ${
                        topic.status === 'completed' ? 'text-zinc-500 line-through' : 'text-zinc-900'
                      }`}>
                        {topic.title}
                      </h3>
                      <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                        {topic.description}
                      </p>
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
            )}
          </div>

          <div className="p-4 bg-zinc-100 border-t border-zinc-200">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Socratic AI Engine</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

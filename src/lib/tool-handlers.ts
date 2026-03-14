/**
 * Tool handler factory for Gemini Live API tool calls.
 * 
 * Returns a handler function that dispatches tool calls from Gemini to
 * the appropriate whiteboard action, and sends back the tool response.
 * 
 * Extracted from page.tsx to keep the main component lean.
 */

import mermaid from 'mermaid';
import { GeminiLiveAPI } from './live-api';

export interface LearningTopic {
  id: string;
  title: string;
  description: string;
  status: 'not_started' | 'in_progress' | 'completed';
  notes?: string;
  learning_outcome?: string;
  exercises?: string[];
  examples?: string[];
  flow?: string;
}

export interface ToolHandlerDeps {
  liveApi: GeminiLiveAPI;
  plan: LearningTopic[];
  setPlan: React.Dispatch<React.SetStateAction<LearningTopic[]>>;
  setIsGeneratingPlan: (v: boolean) => void;
  setSidebarTopic: (v: string) => void;
  setIsSpawning: (v: boolean) => void;
  spawnTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  addNotification: (msg: string, type?: 'info' | 'error' | 'success') => void;
  onEquationRef: React.MutableRefObject<((latex: string, label?: string, id?: string) => Promise<void>) | null>;
  onDiagramRef: React.MutableRefObject<((code: string, id?: string) => Promise<void>) | null>;
  onChartRef: React.MutableRefObject<((config: any, id?: string) => Promise<void>) | null>;
}

export function createToolHandler(deps: ToolHandlerDeps) {
  return async function handleToolCall(name: string, args: any, id: string) {
    const {
      liveApi, plan, setPlan, setIsGeneratingPlan, setSidebarTopic,
      setIsSpawning, spawnTimerRef, addNotification,
      onEquationRef, onDiagramRef, onChartRef
    } = deps;

    console.log(`%c[Tool] %c${name}`, 'color: blue; font-weight: bold', 'color: black', args);

    // Show visual "spawning" indicator for visual tools
    const isVisualTool = ['show_equation', 'generate_diagram', 'generate_graph'].includes(name);
    if (isVisualTool) {
      setIsSpawning(true);
      if (spawnTimerRef.current) clearTimeout(spawnTimerRef.current);
      spawnTimerRef.current = setTimeout(() => setIsSpawning(false), 2000);
    }

    // -----------------------------------------------------------------------
    // Tool: show_equation
    // -----------------------------------------------------------------------
    if (name === 'show_equation') {
      const { latex, label } = args as { latex: string; label?: string };
      try {
        await onEquationRef.current?.(latex, label, id);
        liveApi.sendToolResponse(id, name, {
          success: true,
          message: `Equation rendered on the whiteboard${label ? `: ${label}` : ''}.`,
        });
      } catch (e: any) {
        liveApi.sendToolResponse(id, name, { success: false, error: e?.message ?? 'Failed to render equation' });
      }

    // -----------------------------------------------------------------------
    // Tool: generate_learning_plan
    // -----------------------------------------------------------------------
    } else if (name === 'generate_learning_plan' || name === 'create_learning_plan') {
      const { topic, notes } = args as { topic: string; notes?: string };
      setIsGeneratingPlan(true);
      setSidebarTopic(topic);
      try {
        const res = await fetch('/api/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, notes }),
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to fetch plan');
        }
        const planNodes = await res.json() as any[];
        const processedPlan: LearningTopic[] = planNodes.map(node => ({
          ...node,
          status: 'not_started',
          notes: '',
        }));
        setPlan(processedPlan);
        setIsGeneratingPlan(false);
        addNotification(`Learning plan for "${topic}" generated!`, 'success');
        liveApi.sendToolResponse(id, name, {
          success: true,
          plan: processedPlan,
          message: `Learning plan for ${topic} created and displayed in the student's sidebar.`,
        });
      } catch (err: any) {
        console.error('[Tool] Plan creation failed:', err);
        setIsGeneratingPlan(false);
        liveApi.sendToolResponse(id, name, { success: false, error: err.message });
      }

    // -----------------------------------------------------------------------
    // Tool: generate_diagram
    // -----------------------------------------------------------------------
    } else if (name === 'generate_diagram') {
      let cleanCode = (args.code as string).trim();
      // Strip any markdown code block wrapping the AI may have added
      if (cleanCode.startsWith('```')) {
        cleanCode = cleanCode.replace(/^```[^\n]*\n?/i, '').replace(/```$/i, '').trim();
      }
      if (cleanCode.toLowerCase().startsWith('mermaid')) {
        cleanCode = cleanCode.substring(7).trim();
      }
      try {
        await mermaid.parse(cleanCode); // Validate syntax before placing on board
        await onDiagramRef.current?.(cleanCode, id);
        liveApi.sendToolResponse(id, name, { success: true, message: 'Diagram rendered on the whiteboard.' });
      } catch (e: any) {
        console.error('[Tool] Mermaid validation error:', e);
        liveApi.sendToolResponse(id, name, {
          success: false,
          error: `Mermaid Syntax Error: ${e?.message ?? 'Failed to parse diagram. Please fix syntax and try again.'}`,
        });
      }

    // -----------------------------------------------------------------------
    // Tool: generate_graph
    // -----------------------------------------------------------------------
    } else if (name === 'generate_graph') {
      try {
        await onChartRef.current?.(args, id);
        liveApi.sendToolResponse(id, name, { success: true, message: 'Chart rendered on the whiteboard.' });
      } catch (e: any) {
        liveApi.sendToolResponse(id, name, { success: false, error: e?.message ?? 'Failed to render chart' });
      }

    // -----------------------------------------------------------------------
    // Tool: see_learning_plan
    // -----------------------------------------------------------------------
    } else if (name === 'see_learning_plan' || name === 'get_learning_plan') {
      liveApi.sendToolResponse(id, name, {
        success: true,
        plan,
        message: `Current learning plan retrieved. Total topics: ${plan.length}.`,
      });

    // -----------------------------------------------------------------------
    // Tool: update_learning_progress
    // -----------------------------------------------------------------------
    } else if (name === 'update_learning_progress') {
      const { topic_id, status, notes } = args as {
        topic_id: string;
        status: 'not_started' | 'in_progress' | 'completed';
        notes?: string;
      };
      setPlan(prev => prev.map(t =>
        t.id === topic_id || t.title === topic_id
          ? { ...t, status, notes: notes ?? t.notes }
          : t
      ));
      liveApi.sendToolResponse(id, name, {
        success: true,
        message: `Topic "${topic_id}" is now ${status}. Notes updated: ${notes ? 'yes' : 'no'}.`,
      });

    // -----------------------------------------------------------------------
    // Unknown tool
    // -----------------------------------------------------------------------
    } else {
      console.warn(`[Tool] Unknown tool: "${name}"`);
      liveApi.sendToolResponse(id, name, { success: false, error: `Unknown tool: ${name}` });
    }
  };
}

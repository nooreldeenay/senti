/**
 * Tool handler factory for Gemini Live API tool calls.
 * 
 * Returns a handler function that dispatches tool calls from Gemini to
 * the appropriate whiteboard action, and sends back the tool response.
 * 
 * Extracted from page.tsx to keep the main component lean.
 */

import mermaid from 'mermaid';
import katex from 'katex';
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
  planRef: React.MutableRefObject<LearningTopic[]>;
  setPlan: React.Dispatch<React.SetStateAction<LearningTopic[]>>;
  setIsGeneratingPlan: (v: boolean) => void;
  setSidebarTopic: (v: string) => void;
  setIsSpawning: (v: boolean) => void;
  spawnTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  addNotification: (msg: string, type?: 'info' | 'error' | 'success') => void;
  sidebarTopicRef: React.MutableRefObject<string>;
  onEquationRef: React.MutableRefObject<((latex: string, label?: string, id?: string) => Promise<void>) | null>;
  onDiagramRef: React.MutableRefObject<((code: string, id?: string) => Promise<void>) | null>;
  onChartRef: React.MutableRefObject<((config: any, id?: string) => Promise<void>) | null>;
}

export function createToolHandler(deps: ToolHandlerDeps) {
  return async function handleToolCall(name: string, args: any, id: string) {
    const {
      liveApi, planRef, setPlan, setIsGeneratingPlan, setSidebarTopic,
      setIsSpawning, spawnTimerRef, addNotification, sidebarTopicRef,
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
        // Validate LaTeX syntax using KaTeX before sending to the UI
        katex.renderToString(latex, { throwOnError: true });
        
        await onEquationRef.current?.(latex, label, id);
        liveApi.sendToolResponse(id, name, {
          success: true,
          message: `Equation state: Rendered visually on the whiteboard${label ? ` as "${label}"` : ''}. Wait for student confirmation.`,
        });
      } catch (e: any) {
        console.error(`[Tool] LaTeX validation failed for: ${latex}`, e);
        liveApi.sendToolResponse(id, name, { 
          success: false, 
          error: `Invalid LaTeX syntax: ${e?.message || 'Check your formatting'}. Please correct the LaTeX code and try show_equation again.` 
        });
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
        plan: planRef.current,
        message: `Current learning plan retrieved. Total topics: ${planRef.current.length}.`,
      });

    // -----------------------------------------------------------------------
    // Tool: update_learning_progress
    // -----------------------------------------------------------------------
    } else if (name === 'update_learning_progress') {
      const { topic_id, status, notes } = args as { topic_id: string; status: string; notes?: string };
      
      setPlan(prev => prev.map(topic => 
        topic.id === topic_id ? { ...topic, status: status as any, notes: notes || topic.notes } : topic
      ));

      liveApi.sendToolResponse(id, name, {
        success: true,
        message: `Progress updated: Topic "${topic_id}" status is now "${status}". Sidebar updated. Wait for user command to proceed.`,
      });
    
    // -----------------------------------------------------------------------
    // Tool: save_learning_progress
    // -----------------------------------------------------------------------
    } else if (name === 'save_learning_progress') {
      try {
        const { getUserId } = await import('./user');
        const userId = getUserId();
        const currentTopic = planRef.current.find(t => t.status === 'in_progress');
        const res = await fetch('/api/sessions/save', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-user-id': userId
          },
          body: JSON.stringify({
            topic: sidebarTopicRef.current,
            plan: planRef.current,
            currentTopicId: currentTopic?.id || null,
          }),
        });

        if (!res.ok) throw new Error('Failed to save session');
        
        const data = await res.json();
        addNotification('Learning progress saved to cloud!', 'success');
        liveApi.sendToolResponse(id, name, {
          success: true,
          message: 'Session progress has been securely saved to Firestore. You can safely leave now.',
          sessionId: data.id
        });
      } catch (err: any) {
        console.error('[Tool] Save failed:', err);
        liveApi.sendToolResponse(id, name, { success: false, error: err.message });
      }

    // -----------------------------------------------------------------------
    // Unknown tool
    // -----------------------------------------------------------------------
    } else {
      console.warn(`[Tool] Unknown tool: "${name}"`);
      liveApi.sendToolResponse(id, name, { success: false, error: `Unknown tool: ${name}` });
    }
  };
}

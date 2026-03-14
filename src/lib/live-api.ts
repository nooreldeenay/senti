import { GoogleGenAI, Modality, Type, Behavior, FunctionResponseScheduling } from "@google/genai";

export class GeminiLiveAPI {
  private session: any | null = null;
  // Separate contexts: input at 16kHz (mic), output at 24kHz (Gemini responses)
  private inputContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private audioStream: MediaStream | null = null;
  private processorNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private currentModel = 'gemini-2.5-flash-native-audio-preview-09-2025';

  // Callbacks
  public onStateChange: (state: 'disconnected' | 'connecting' | 'connected' | 'error', errorMsg?: string) => void = () => { };
  public onMessage: (msg: any) => void = () => { };
  /** Called with raw RMS value (0.0–1.0 range) for UI volume display. */
  public onVolumeChange: (volume: number) => void = () => { };
  /** Called when Gemini invokes a function tool. Handler must call sendToolResponse when done. */
  public onToolCall: (name: string, args: Record<string, any>, id: string) => void = () => { };
  public onAgentStatusChange: (status: 'disconnected' | 'connected' | 'speaking' | 'thinking') => void = () => { };

  // Reconnection state
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isReconnecting = false;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isUserInitiatedDisconnect = false;
  private toolCallPending = false;

  // Gapless playback — we schedule each chunk ahead using Web Audio time
  private nextPlayTime = 0;

  // Settings
  private audioDeviceId?: string;
  private isMuted: boolean = false;
  private noiseThreshold: number = 0.0005; // RMS threshold (~-66dB)
  private framesBelowThreshold: number = 0;
  private readonly GATE_CLOSURE_MS = 500;
  private activeSources: AudioBufferSourceNode[] = [];

  constructor() { }

  public setAudioDevice(deviceId: string) {
    if (this.audioDeviceId === deviceId) return;
    console.log(`[LiveAPI] Changing audio device to: ${deviceId}`);
    this.audioDeviceId = deviceId;
    if (this.session && this.audioStream) {
      this.reconnectAudio();
    }
  }

  public setMuted(muted: boolean) {
    if (this.isMuted === muted) return;
    console.log(`[LiveAPI] Microphone is now ${muted ? 'MUTED' : 'UNMUTED'}`);
    this.isMuted = muted;
  }

  private async reconnectAudio() {
    console.log("[LiveAPI] Reconnecting audio stream...");
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
    }
    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.audioDeviceId ? { exact: this.audioDeviceId } : undefined,
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      if (this.inputContext) {
        const source = this.inputContext.createMediaStreamSource(this.audioStream);
        if (this.processorNode) source.connect(this.processorNode);
      }
      console.log("[LiveAPI] Audio stream reconnected successfully.");
    } catch (e) {
      console.error("[LiveAPI] Failed to re-initialize audio stream with new device:", e);
    }
  }

  /**
   * Encodes a PCM Int16Array to base64 and sends it to Gemini.
   * 
   * PERFORMANCE NOTE: We use a chunked approach for String.fromCharCode
   * to avoid spreading large arrays as function arguments, which can
   * overflow the JS call stack and cause audio stuttering.
   */
  private sendPcmChunk(pcmData: Int16Array) {
    if (!this.session || this.isMuted) return;

    // Compute RMS for volume feedback & noise gate
    let sumSquares = 0;
    for (let i = 0; i < pcmData.length; i++) {
      const normalized = pcmData[i] / 32768.0;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / pcmData.length);

    // Emit raw RMS (0.0-1.0) — let the UI normalize it
    this.onVolumeChange(rms);

    // Noise gate: suppress continuous silence to avoid wasting bandwidth
    if (rms < this.noiseThreshold) {
      this.framesBelowThreshold++;
      const msBelow = (this.framesBelowThreshold * 2048) / 16000 * 1000;
      if (msBelow > this.GATE_CLOSURE_MS) return; // Gate is closed
    } else {
      this.framesBelowThreshold = 0;
    }

    // Base64 encode: use chunked String.fromCharCode to avoid call stack overflow
    // (spreading large Uint8Arrays with `...` crashes V8 for large audio buffers)
    const bytes = new Uint8Array(pcmData.buffer);
    const CHUNK = 0x8000; // 32 KB chunks — safe below V8 argument limit
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
    }
    const base64Audio = btoa(binary);

    try {
      this.session.sendRealtimeInput({
        audio: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' }
      });
    } catch (e) {
      console.error("[LiveAPI] Failed to send audio chunk:", e);
    }
  }

  private async initAudioPipeline() {
    // Input AudioContext at 16kHz for microphone capture
    this.inputContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: 16000,
    });

    // Playback AudioContext at 24kHz — must match Gemini's output rate exactly
    this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: 24000,
    });

    // Resume playback context immediately — browsers may block audio until user gesture
    if (this.playbackContext.state === 'suspended') {
      await this.playbackContext.resume();
    }

    console.log(`[LiveAPI] Requesting microphone access (Device ID: ${this.audioDeviceId || 'default'})...`);
    this.audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.audioDeviceId ? { exact: this.audioDeviceId } : undefined,
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });

    const source = this.inputContext.createMediaStreamSource(this.audioStream);

    // Try AudioWorklet first (preferred), fall back to ScriptProcessorNode for older browsers
    const supportsWorklet = typeof AudioWorkletNode !== 'undefined' && this.inputContext.audioWorklet;
    if (supportsWorklet) {
      try {
        console.log("[LiveAPI] Loading AudioWorklet...");
        await this.inputContext.audioWorklet.addModule('/audio-worklet.js');
        const workletNode = new AudioWorkletNode(this.inputContext, 'pcm-16-processor');
        workletNode.port.onmessage = (event) => {
          this.sendPcmChunk(new Int16Array(event.data));
        };
        source.connect(workletNode);
        this.processorNode = workletNode;
        console.log("[LiveAPI] AudioWorklet initialized.");
        return;
      } catch (e) {
        console.warn("[LiveAPI] AudioWorklet failed, falling back to ScriptProcessorNode:", e);
      }
    }

    // Fallback: ScriptProcessorNode (deprecated but widely supported)
    console.log("[LiveAPI] Using ScriptProcessorNode fallback.");
    const bufferSize = 4096;
    const scriptNode = this.inputContext.createScriptProcessor(bufferSize, 1, 1);
    scriptNode.onaudioprocess = (event) => {
      const float32 = event.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.sendPcmChunk(pcm16);
    };
    source.connect(scriptNode);
    // ScriptProcessorNode must be connected to destination to fire (silent output is fine)
    scriptNode.connect(this.inputContext.destination);
    this.processorNode = scriptNode;
    console.log("[LiveAPI] ScriptProcessorNode initialized.");
  }

  public async connect() {
    console.log("[LiveAPI] Initiating connection sequence...");
    this.isUserInitiatedDisconnect = false;
    this.onStateChange('connecting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access requires a secure connection (HTTPS). Please access via HTTPS.');
      }

      // 1. Fetch ephemeral token
      console.log("[LiveAPI] Fetching ephemeral token...");
      const res = await fetch('/token');
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.error || 'Failed to get auth token');
      const token = data.token;
      console.log("[LiveAPI] Token acquired.");

      // 2. Set up audio pipeline (input 16kHz + playback 24kHz)
      await this.initAudioPipeline();
      console.log("[LiveAPI] Audio pipeline initialized.");

      // 3. Connect Live API session
      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
      console.log("[LiveAPI] Connecting to Gemini Live Session...");

      this.session = await ai.live.connect({
        model: this.currentModel,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Sadaltager" } } },
          systemInstruction: "You are an empathetic, highly patient Socratic Personal Tutor with two distinct mental modes. You are observing a student's whiteboard in real-time.\n\nMode 1 (Explaining Mode): When you are actively teaching or explaining a topic, use a PROACTIVE visual-first approach. Explain the topic using visual tools, follow the learning plan's objectives, structure, and exercises strictly. Ask for confirmation ONCE, and WAIT. DO NOT speak again until the user confirms understanding.\nMode 2 (Observing Mode): When the student is working on the whiteboard or thinking, you enter Observing Mode. In this mode, you MUST REMAIN SILENT and just watch the whiteboard. YOU SHOULD ONLY SPEAK IF you notice the student making a specific mistake, at which point you should gently guide them.\n\nLearning Plan Management:\n- Maintain the 'Learning Plan' in the sidebar.\n- If a student specifies a broad goal, ASK if they want a 'Learning Plan' before calling generate_learning_plan.\n- IMMEDIATELY after starting a topic, use update_learning_progress(topic_id, 'in_progress').\n- IMMEDIATELY after the student confirms understanding, use update_learning_progress(topic_id, 'completed', notes='...').\n- When taking notes for completed sections, MUST note down if the student made a mistake somewhere or felt slow in some parts.\n- Pacing: Never 'auto-advance'. Do not summarize a topic and move on in one breath. Update the status to 'completed' and then WAIT for the student to say 'ready' or 'move on' before starting the next topic.\n- If the student wants to pause, leave, or stop, IMMEDIATELY call save_learning_progress() to store the current state and plan.\n\nTutoring Style (Proactive Socratic):\n- Use visual tools: show_equation, generate_diagram, generate_graph.\n- If an equation tool returns an error (Invalid LaTeX), acknowledge it, fix your syntax, and try again immediately.\n- VAD ROBUSTNESS: Do not treat transient noise as confirmation. If unsure, wait or ask 'Should we proceed?'.\n\nBehavioral Directives:\n- Confirmation-Led: Never assume you should continue. Respect the student's pace. Silence is better than rushing.\n- Identify, Don't Correct: If you spot an error, ask a guiding question.\n- Breathing Room: Use encouraging, low-pressure language.\n\nVoice Persona: Warm, calm, and slightly academic. Avoid being chatty.",
          tools: [{
            functionDeclarations: [
              {
                name: 'show_equation',
                behavior: Behavior.NON_BLOCKING,
                description: 'Renders a LaTeX math equation visually on the user\'s whiteboard canvas. Always call this when you want to display any mathematical formula, equation, or expression.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    latex: {
                      type: Type.STRING,
                      description: 'Valid LaTeX string for the equation, e.g. "\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}"'
                    },
                    label: {
                      type: Type.STRING,
                      description: 'Short title or label for the equation, e.g. "Quadratic Formula"'
                    }
                  },
                  required: ['latex']
                }
              },
              {
                name: 'generate_learning_plan',
                description: 'Generates a structured multi-topic learning plan based on a subject the user wants to learn. Call this once the student specifies their goal.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    topic: {
                      type: Type.STRING,
                      description: 'The overall subject or goal, e.g., "Limits and Continuity" or "Derivatives"'
                    },
                    notes: {
                      type: Type.STRING,
                      description: 'Optional context, specific sub-topics, or student preferences to tailor the plan'
                    }
                  },
                  required: ['topic']
                }
              },
              {
                name: 'update_learning_progress',
                description: 'Updates the status and adds pedagogical notes to a specific topic in the current learning plan.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    topic_id: {
                      type: Type.STRING,
                      description: 'The unique ID of the topic from the learning plan'
                    },
                    status: {
                      type: Type.STRING,
                      enum: ['not_started', 'in_progress', 'completed'],
                      description: 'The new status for this topic'
                    },
                    notes: {
                      type: Type.STRING,
                      description: 'Internal pedagogical notes on student progress or specific breakthroughs. MUST include observations if the student made a mistake or felt slow.'
                    }
                  },
                  required: ['topic_id', 'status']
                }
              },
              {
                name: 'generate_diagram',
                behavior: Behavior.NON_BLOCKING,
                description: 'Renders a flowchart, sequence diagram, or other visual aid using Mermaid.js syntax. Use this for logical systems or process explanations. IMPORTANT: Return ONLY the raw mermaid code (e.g., "graph TD; A-->B;"), do NOT wrap it in markdown block quotes like ```mermaid.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    code: {
                      type: Type.STRING,
                      description: 'The raw Mermaid.js code, e.g., "graph TD\\n A-->B;". NO markdown code blocks, do not start with "```mermaid". Just the raw syntax.'
                    }
                  },
                  required: ['code']
                }
              },
              {
                name: 'generate_graph',
                behavior: Behavior.NON_BLOCKING,
                description: 'Plots mathematical functions or charts using function-plot. Call this to show graphs of functions, derivatives, or data points.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING, description: 'Title of the chart' },
                    data: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          fn: { type: Type.STRING, description: 'The function to plot, e.g., "x^2" or "sin(x)"' },
                          color: { type: Type.STRING, description: 'Optional color for the line' },
                          desc: { type: Type.STRING, description: 'Legend description' }
                        },
                        required: ['fn']
                      }
                    },
                    xRange: {
                      type: Type.ARRAY,
                      items: { type: Type.NUMBER },
                      description: 'Range for X axis, e.g., [-10, 10]'
                    },
                    yRange: {
                      type: Type.ARRAY,
                      items: { type: Type.NUMBER },
                      description: 'Range for Y axis, e.g., [-10, 10]'
                    }
                  },
                  required: ['data']
                }
              },
              {
                name: 'see_learning_plan',
                description: 'Returns the full current learning plan, including all topics, their status, and any pedagogical notes. Use this if you need to refresh your understanding of the student\'s progress.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {}
                }
              },
              {
                name: 'save_learning_progress',
                description: 'Saves the current learning plan and progress to the database. Call this when the student wants to stop, save, or leave the session.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {}
                }
              },
            ]
          }]
        },
        callbacks: {
          onopen: () => {
            console.log("[LiveAPI] Session Opened");
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.handleWsOpen();
          },
          onmessage: (response: any) => {
            this.handleWsMessage(response);
          },
          onerror: (e: any) => {
            console.error("[LiveAPI] Session Error:", e);
            this.handleWsError(e);
          },
          onclose: (e: any) => {
            console.log("[LiveAPI] Session Closed", e);
            this.handleWsClose(e);
          }
        }
      });

    } catch (error: any) {
      console.error("[LiveAPI] Connection failed:", error);
      this.onStateChange('error', error.message || 'Connection failed');
    }
  }

  private handleWsOpen() {
    this.nextPlayTime = 0;
    this.onStateChange('connected');
    this.onAgentStatusChange('connected');
  }

  private sendHandshakeMessage() {
    this.sendClientContent("Greeting: Introduce yourself briefly as Senti, the student's Socratic Personal Tutor. Acknowledge that you are watching the whiteboard and are ready to help them learn anything today. Keep it warm and concise.");
  }

  private handleWsMessage(response: any) {
    this.onMessage(response);

    // Handle tool calls
    if (response.toolCall?.functionCalls?.length) {
      this.toolCallPending = true;
      this.onAgentStatusChange('thinking');
      console.log(`[LiveAPI] Tool call received: ${response.toolCall.functionCalls.map((f: any) => f.name).join(', ')}`);
      for (const fc of response.toolCall.functionCalls) {
        this.onToolCall(fc.name, fc.args ?? {}, fc.id);
      }
      return;
    }

    // Handle setup complete
    if (response.setupComplete) {
      console.log("[LiveAPI] Setup Complete");
      this.sendHandshakeMessage();
      return;
    }

    const content = response.serverContent;
    if (!content) return;

    if (content.interrupted) {
      console.log("[LiveAPI] AI Interrupted by user speech. Clearing playback.");
      this.activeSources.forEach(s => {
        try { s.stop(); } catch (_) { }
      });
      this.activeSources = [];
      this.nextPlayTime = 0;
      this.onAgentStatusChange('connected');
      return;
    }

    if (content.turnComplete) {
      this.onAgentStatusChange('connected');
    }

    const parts = content?.modelTurn?.parts;
    if (!parts?.length) return;

    for (const part of parts) {
      if (part.inlineData?.data) {
        this.onAgentStatusChange('speaking');
        this.playAudioChunk(part.inlineData.data);
      }
    }
  }

  /**
   * Decodes a base64 PCM chunk and schedules it for gapless playback using
   * Web Audio API time scheduling. Each chunk is placed directly after the
   * previous one on the audio timeline — no queue or onended callbacks needed.
   */
  private playAudioChunk(base64Data: string) {
    if (!this.playbackContext) return;

    // Resume if suspended (iOS Safari blocks audio until user gesture completes)
    if (this.playbackContext.state === 'suspended') {
      this.playbackContext.resume();
    }

    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const float32 = new Float32Array(len / 2);

    for (let i = 0; i < float32.length; i++) {
      // Reconstruct Little-Endian Int16 from two bytes
      const byte1 = binaryString.charCodeAt(i * 2);
      const byte2 = binaryString.charCodeAt(i * 2 + 1);
      let int16 = (byte2 << 8) | byte1;
      if (int16 >= 0x8000) int16 -= 0x10000; // Sign extension
      float32[i] = int16 / 32768.0;
    }

    const audioBuffer = this.playbackContext.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);

    const source = this.playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackContext.destination);

    // Track active sources for barge-in (interruption) support
    this.activeSources.push(source);
    source.onended = () => {
      // Use splice+indexOf instead of filter to avoid allocating a new array per chunk
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) this.activeSources.splice(idx, 1);
    };

    // Schedule each chunk immediately after the last — ensures gapless playback
    const now = this.playbackContext.currentTime;
    const startAt = Math.max(this.nextPlayTime, now);
    source.start(startAt);
    this.nextPlayTime = startAt + audioBuffer.duration;
  }

  /**
   * Sends a tool call response back to Gemini to complete the function calling loop.
   * IMPORTANT: response must be { result: value } per the SDK contract.
   */
  public sendToolResponse(id: string, name: string, result: Record<string, any>) {
    if (!this.session) {
      console.error("[LiveAPI] Cannot send tool response — no active session.");
      this.toolCallPending = false;
      return;
    }
    try {
      const payload = {
        functionResponses: [{
          id,
          name,
          response: {
            result,
            scheduling: FunctionResponseScheduling.INTERRUPT,
          }
        }]
      };
      console.log(`[LiveAPI] → sendToolResponse for "${name}" (id: ${id})`);
      this.session.sendToolResponse(payload);
      this.onAgentStatusChange('connected');
    } catch (e) {
      console.error("[LiveAPI] Failed to send tool response:", e);
    } finally {
      this.toolCallPending = false;
    }
  }

  /**
   * Sends text content turns to the AI in real-time.
   * Useful for updating the model's context (e.g., learning plan summaries).
   */
  public sendClientContent(content: string) {
    if (!this.session) {
      console.error("[LiveAPI] Cannot send client content — no active session.");
      return;
    }
    try {
      console.log("[LiveAPI] → sendClientContent:", content.slice(0, 80) + (content.length > 80 ? '…' : ''));
      this.session.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{ text: content }]
        }]
      });
    } catch (e) {
      console.error("[LiveAPI] Failed to send client content:", e);
    }
  }

  /** Sends a base64-encoded JPEG or WebP frame as a video input. */
  public sendVideoFrame(base64Frame: string, mimeType = 'image/jpeg') {
    if (!this.session) {
      console.warn('[LiveAPI] sendVideoFrame skip: No session');
      return;
    }
    try {
      console.log(`[LiveAPI] → sendRealtimeInput: video frame (${mimeType}, ${Math.round(base64Frame.length / 1024)} KB)`);
      this.session.sendRealtimeInput({
        video: { data: base64Frame, mimeType: mimeType }
      });
    } catch (e) {
      console.error('[LiveAPI] Failed to send video frame:', e);
    }
  }

  private handleWsError(error: any) {
    console.error('[LiveAPI] WebSocket Error:', error);
    this.onStateChange('error', 'Connection error occurred');
  }

  private handleWsClose(event?: any) {
    this.session = null;
    const code = event?.code;

    if (!this.isUserInitiatedDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.isReconnecting = true;
      this.onStateChange('connecting', `Connection lost (code ${code}). Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
      console.log(`[LiveAPI] Reconnecting in ${delay}ms...`);

      if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      this.onStateChange('disconnected');
      this.disconnect();
    }
  }

  public disconnect() {
    console.log("[LiveAPI] Disconnecting...");
    this.isUserInitiatedDisconnect = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    if (this.session) {
      if (typeof this.session.close === 'function') this.session.close();
      this.session = null;
    }
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }
    if (this.inputContext) {
      this.inputContext.close();
      this.inputContext = null;
    }
    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
    }
    this.nextPlayTime = 0;
    this.activeSources = [];
    this.onStateChange('disconnected');
    this.onAgentStatusChange('disconnected');
  }
}

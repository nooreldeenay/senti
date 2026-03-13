import { GoogleGenAI, Modality, Type, Behavior, FunctionResponseScheduling } from "@google/genai";

export class GeminiLiveAPI {
  private session: any | null = null;
  // Separate contexts: input at 16kHz (mic), output at 24kHz (Gemini responses)
  private inputContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private audioStream: MediaStream | null = null;
  private processorNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private currentModel = 'gemini-2.5-flash-native-audio-preview-12-2025';

  // Callbacks
  public onStateChange: (state: 'disconnected' | 'connecting' | 'connected' | 'error', errorMsg?: string) => void = () => { };
  public onMessage: (msg: any) => void = () => { };
  public onVolumeChange: (volume: number) => void = () => { };
  // Called when Gemini invokes a function tool. Handler must call sendToolResponse when done.
  public onToolCall: (name: string, args: Record<string, any>, id: string) => void = () => { };

  // Gapless playback — we schedule each chunk ahead using Web Audio time
  private nextPlayTime = 0;

  // Settings
  private audioDeviceId?: string;
  private isMuted: boolean = false;

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

  // Sends a PCM Int16Array as base64 audio to Gemini
  private sendPcmChunk(pcmData: Int16Array) {
    if (!this.session || this.isMuted) return;

    // Volume feedback
    let sum = 0;
    for (let i = 0; i < pcmData.length; i++) sum += Math.abs(pcmData[i]);
    this.onVolumeChange(sum / pcmData.length);

    // Encode to base64
    const bytes = new Uint8Array(pcmData.buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
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
    // 2a. Input AudioContext at 16kHz for microphone capture
    this.inputContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: 16000,
    });

    // 2b. Playback AudioContext at 24kHz — must match Gemini's output rate exactly
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

    // Try AudioWorklet first (preferred), fall back to ScriptProcessorNode for older browsers (e.g. older iOS Safari)
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
    this.onStateChange('connecting');
    try {
      // Check mediaDevices availability (requires HTTPS on non-localhost)
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access requires a secure connection (HTTPS). Please access via HTTPS.');
      }

      // 1. Fetch ephemeral token
      console.log("[LiveAPI] Fetching ephemeral token...");
      const res = await fetch('/token');
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.error || 'Failed to get auth token');
      console.log("[LiveAPI] Token acquired.");
      const token = data.token;

      // 2. Set up audio pipeline (input 16kHz + playback 24kHz)
      await this.initAudioPipeline();
      console.log("[LiveAPI] Audio pipeline initialized.");

      // 3. Connect Live API session
      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
      console.log("[LiveAPI] Connecting to Gemini Live Session...");

      this.session = await ai.live.connect({
        model: this.currentModel,
        config: {
          // responseModalities must be at the top level of config (not generationConfig)
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are an empathetic, highly patient Socratic Math Tutor. You are observing a student's whiteboard in real-time. Your goal is to guide them without rushing or providing direct answers.\n\nBehavioral Directives:\n\n- The 'Silence is Golden' Rule: When you see the student drawing or writing, do not interrupt. Allow them to finish their thought. Only speak if they pause for more than 5 seconds or if they ask a direct question.\n\n- Identify, Don't Correct: If you spot a mathematical error (e.g., a sign error or a calculation mistake), do not say 'That is wrong.' Instead, ask a guiding question like: 'I noticed a change in the second step; does that negative sign carry over?'\n\n- The 'Breathing Room' Protocol: Use encouraging, low-pressure language. If the student seems frustrated, say: 'Take your time, I'm just here to support you. There's no rush.'\n\n- Proactive Visuals: Whenever you want to show or reference any mathematical equation, formula, or expression, ALWAYS call the show_equation tool to render it visually on the whiteboard. Never describe math verbally without also showing it. If the student is struggling to visualize a concept, use show_equation to provide a visual scaffold.\n\nVoice Persona: Your voice should be warm, calm, and slightly academic but accessible. Avoid being 'chatty'—stay focused on the work while being human.",
          tools: [{
            functionDeclarations: [{
              name: 'show_equation',
              // NON_BLOCKING: model doesn't wait for our response before continuing to speak.
              // Without this, the callback-based async flow creates a deadlock.
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
            }]
          }]
        },
        callbacks: {
          onopen: () => {
            console.log("[LiveAPI] Session Opened");
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
            this.handleWsClose();
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

    // Anchor the model to your tools before streaming audio
    this.session?.sendClientContent({
      turns: "Acknowledge my system instructions. I will speak to you now."
    });
  }

  private handleWsMessage(response: any) {
    this.onMessage(response);

    // Exhaustive logging for debugging tool calls (Uncomment only if needed)
    try {
      /*
      const keys = Object.keys(response);
      console.log(`[LiveAPI] Message Keys: ${keys.join(', ')}`);
      if (response.toolCall) console.log(`[LiveAPI] toolCall detected!`);
      if (response.serverContent) console.log(`[LiveAPI] serverContent Keys: ${Object.keys(response.serverContent).join(', ')}`);
      
      const safe = JSON.parse(JSON.stringify(response, (k, v) =>
        k === 'data' && typeof v === 'string' && v.length > 50 ? `[base64 ${v.length}c]` : v
      ));
      console.debug("[LiveAPI] ←", JSON.stringify(safe));
      */
    } catch { }

    // Handle tool calls
    if (response.toolCall?.functionCalls?.length) {
      console.log(`[LiveAPI] Tool call received: ${response.toolCall.functionCalls.map((f: any) => f.name).join(', ')}`);
      for (const fc of response.toolCall.functionCalls) {
        this.onToolCall(fc.name, fc.args ?? {}, fc.id);
      }
      return;
    }

    const content = response.serverContent;
    if (!content) {
      console.debug("[LiveAPI] Non-content message:", Object.keys(response).join(', '));
      return;
    }

    const parts = content?.modelTurn?.parts;
    if (!parts?.length) return;

    for (const part of parts) {
      if (part.inlineData?.data) {
        // console.debug(`[LiveAPI] Audio chunk: ${part.inlineData.mimeType}, ${part.inlineData.data.length} chars`);
        this.playAudioChunk(part.inlineData.data);
      } else if (part.text) {
        // console.log("[LiveAPI] Text response:", part.text);
      }
    }
  }

  /**
   * Decodes a base64 PCM chunk and schedules it for gapless playback using
   * Web Audio API time scheduling. Each chunk is placed directly after the
   * previous one on the audio timeline — no queue or onended callbacks needed.
   */
  private playAudioChunk(base64Data: string) {
    if (!this.playbackContext) {
      console.error("[LiveAPI] No playbackContext!");
      return;
    }

    // Resume if suspended (iOS Safari blocks audio until user gesture completes)
    if (this.playbackContext.state === 'suspended') {
      console.warn("[LiveAPI] Resuming suspended playbackContext...");
      this.playbackContext.resume();
    }

    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    const audioBuffer = this.playbackContext.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);

    const source = this.playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackContext.destination);

    // Schedule each chunk immediately after the last — ensures gapless playback
    const now = this.playbackContext.currentTime;
    const startAt = Math.max(this.nextPlayTime, now);
    source.start(startAt);
    this.nextPlayTime = startAt + audioBuffer.duration;

    // console.debug(`[LiveAPI] Scheduled ${(audioBuffer.duration * 1000).toFixed(0)}ms audio chunk @ t=${startAt.toFixed(3)}`);
  }

  // Send a tool call response back to Gemini to complete the function calling loop.
  // IMPORTANT: response must be { result: value } per the SDK contract — not the value directly.
  public sendToolResponse(id: string, name: string, result: Record<string, any>) {
    if (!this.session) {
      console.error("[LiveAPI] Cannot send tool response — no active session.");
      return;
    }
    try {
      const payload = {
        functionResponses: [{
          id,
          name,
          response: {
            // SDK requires result to be wrapped in { result: ... }
            result,
            // INTERRUPT: model interrupts to acknowledge the tool completed
            scheduling: FunctionResponseScheduling.INTERRUPT,
          }
        }]
      };
      console.log(`[LiveAPI] → sendToolResponse for "${name}" (id: ${id}):`, JSON.stringify(payload));
      this.session.sendToolResponse(payload);
    } catch (e) {
      console.error("[LiveAPI] Failed to send tool response:", e);
    }
  }

  // Expects base64 encoded jpeg or webp
  public sendVideoFrame(base64Frame: string, mimeType = 'image/jpeg') {
    if (!this.session) return;
    try {
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

  private handleWsClose() {
    this.onStateChange('disconnected');
    this.disconnect();
  }

  public disconnect() {
    console.log("[LiveAPI] Disconnecting...");
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
    this.onStateChange('disconnected');
  }
}

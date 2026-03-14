// An AudioWorkletProcessor script for capturing and downsampling audio.
// The Gemini Live API requires 16000Hz PCM audio.

class PCM16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048; // Send chunks every ~128ms at 16kHz
    this.buffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      
      for (let i = 0; i < channelData.length; i++) {
        const sample = Math.max(-1, Math.min(1, channelData[i]));
        this.buffer[this.bufferIndex++] = sample < 0 ? sample * 32768 : sample * 32767;
        
        if (this.bufferIndex >= this.bufferSize) {
          // Transfer ownership of the current buffer to the main thread
          this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
          // Allocate a new buffer for the next cycle
          this.buffer = new Int16Array(this.bufferSize);
          this.bufferIndex = 0;
        }
      }
    }

    return true; // Keep the processor alive
  }
}

registerProcessor("pcm-16-processor", PCM16Processor);

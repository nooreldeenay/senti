# Senti: Your Socratic AI Learning Companion

> [!IMPORTANT]
> **Project for the Gemini Live Agent Challenge**  
> **Submission Date:** March 16, 2026 (16/03/26)

**Senti** is a cutting-edge, multimodal AI tutor designed to make learning immersive, interactive, and deeply personalized. By combining the power of the **Gemini Multimodal Live API** with a dynamic **tldraw whiteboard**, Senti moves beyond simple text-based chat into a world where your tutor can hear you, see what you're drawing, and visualize complex concepts in real-time.

---

## ✨ Key Features

-   **🎙️ Real-time Voice Interaction**: Natural, low-latency conversation with a "Socratic" AI that guides you through discovery rather than just giving answers.
-   **🎨 Dynamic Whiteboard Integration**: The agent can manifest charts, diagrams, and LaTeX equations directly on a shared canvas using specialized tools.
-   **🧠 Vision-Aware Tutoring**: Senti "sees" your whiteboard. It reacts to your drawings, annotates your work, and corrects your steps by looking at the canvas.
-   **📚 Structured Curriculum**: Automated "Learning Plan" generation that breaks complex topics into manageable, tracked milestones.
-   **☁️ Persistent Multi-User Memory**: Secure, user-scoped session history powered by Firestore, allowing you to pick up exactly where you left off.
-   **💎 Premium Aesthetic**: A "slick and clean" interface featuring architectural typography (Plus Jakarta Sans) and ethereal micro-animations.

---

## 🏗️ System Architecture

Senti's architecture is built on a high-speed feedback loop between the browser, the Gemini Live API, and a robust Next.js backend.

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant C as Senti Client (tldraw)
    participant B as Next.js API
    participant G as Gemini Live API
    participant F as Firestore (Memory)

    %% Session Initialization
    Note over U, F: Session Initialization
    U->>B: Request Connection Token (/api/token)
    B-->>U: Secure Multimodal Token
    U->>G: Establish WebSocket (Voice/Vision)
    G-->>U: Agent "Awakened"

    %% Learning Flow
    Note over U, G: The Socratic Loop
    U->>G: User Voice Input / Board Screenshot
    G->>G: Multimodal Reasoning

    %% Tool Calling Flow
    Note over G, C: Tool Manifesting
    G->>U: Function Call: generate_diagram(code)
    U->>C: Execute Mermaid.js Render
    C->>U: Display Diagram on Board
    U-->>G: Tool Output Confirmation

    %% Persistence Flow
    Note over U, F: Memory & Persistence
    G->>U: Function Call: save_learning_progress()
    U->>B: POST /api/sessions/save (x-user-id)
    B->>F: Store Session Data
    F-->>B: Success
    B-->>U: Progress Cloud-Synced
```

### 🛰️ Data Flow & Governance

1.  **Identity**: Every user is assigned a unique, persistent `userId` via LocalStorage. This ensures that their learning history and curricula remain private and secure.
2.  **The Live Loop**: The client captures "change-driven" screenshots of the whiteboard during idle browser time. These are streamed to Gemini, giving the agent "eyes" without impacting UI performance.
3.  **Tool Orchestration**: Senti uses a robust tool-definition schema. When the AI decides to "show" a concept, it triggers a client-side tool (Equation, Diagram, or Graph) which is then rendered natively in the `tldraw` store.
4.  **Backend Logic**: Next.js serves as the orchestrator for curriculum generation and secure token exchange, while Firestore provides the scalable document store for thousands of unique learning plans.

---

## 🧪 Technology Stack

-   **Frontend**: Next.js (App Router), React, Tailwind CSS v4.
-   **State & Whiteboard**: [tldraw](https://tldraw.dev/) – A collaborative, programmable canvas.
-   **AI Core**: Google Gemini Multimodal Live API.
-   **Persistence**: Firebase / Firestore Admin SDK.
-   **Typography**: Plus Jakarta Sans (Architectural Geometric Sans-Serif).

---

## 🚀 Getting Started

### 1. Environment Configuration
Create a `.env` file in the root directory:
```env
# Gemini API Key
NEXT_PUBLIC_GEMINI_API_KEY=your_key_here

# Firebase Admin Credentials
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

### 2. Installation
```bash
npm install
npm run dev
```

### 3. Usage
Navigate to `localhost:3000`, click **"Awaken Senti"**, and simply start speaking. Tell the agent: *"Let's learn about Quantum Mechanics starting from the basics,"* and watch as it builds a plan and starts sketching on your board.

---

## 🏆 Gemini Live Agent Challenge: Bonus Points

### 🤖 Automating Cloud Deployment (Bonus)
This project includes a fully automated deployment pipeline to Google Cloud Run. You can find the automation logic here:
- [deploy.sh](file:///c:/Users/noore/Projects/web/senti/deploy.sh): A comprehensive shell script that handles building the container with Google Cloud Build and deploying the service to Cloud Run with optimized configurations.

---

*Made with ❤️ for the future of decentralized, AI-first education.*

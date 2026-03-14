import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { topic, notes } = await req.json();
    if (!topic) {
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GOOGLE_API_KEY not set on server" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

    const prompt = `You are a high-level academic curriculum designer. Generate a professional, multi-unit learning plan for a student who wants to learn about: "${topic}"${notes ? ` (Context/Notes: ${notes})` : ""}.
    
    Structure the plan like a university syllabus or a masterclass. 
    1. BREAK the subject into 4-6 contiguous Units/Sections.
    2. Units MUST be in a logical pedagogical sequence (e.g., Fundamentals -> Mechanics -> Synthesis -> Mastery).
    3. Each Unit must have:
       - "learning_outcome": A clear statement of what the student will be able to do.
       - "exercises": An array of strings, each describing a specific whiteboard exercise or practice problem.
       - "examples": An array of strings, each providing a specific example or use-case related to the unit.
       - "flow": A short note on how this unit connects to the next one.
    
    Return strictly a valid JSON array of objects. Each object MUST have:
    - "id": unique string
    - "title": Chapter/Unit title
    - "description": Detailed overview of the chapter
    - "learning_outcome": string
    - "exercises": string array
    - "examples": string array
    - "flow": string
    
    Ensure the JSON is well-formatted and contains no markdown backticks.`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    const text = result.response.text();
    const cleanJson = text.replace(/```json|```/g, '').trim();
    const planNodes = JSON.parse(cleanJson);

    return NextResponse.json(planNodes);
  } catch (error: any) {
    console.error("Plan generation error:", error);
    return NextResponse.json({ error: error.message || "Failed to generate plan" }, { status: 500 });
  }
}

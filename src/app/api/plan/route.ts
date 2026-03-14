import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { topic } = await req.json();
    if (!topic) {
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GOOGLE_API_KEY not set on server" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

    const prompt = `Generate a structured learning plan for a student who wants to learn about: "${topic}". 
    Return strictly a valid JSON array of objects. Each object MUST have:
    - "id": a short string ID (e.g., "intro", "derivatives-1")
    - "title": a human-readable title
    - "description": a one-sentence overview of what will be covered.
    Follow a logical Socratic skill-building order. Ensure the JSON is well-formatted and contains no markdown backticks.`;

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

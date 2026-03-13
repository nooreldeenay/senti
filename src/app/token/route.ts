import { GoogleGenAI, Modality } from "@google/genai";
import { NextResponse } from "next/server";

export async function GET() {
    const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY, httpOptions: { apiVersion: "v1alpha" } });

    try {
        const response = await genAI.authTokens.create({
            config: {
                uses: 1,
                expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                httpOptions: { apiVersion: "v1alpha" }
            },
        });

        return NextResponse.json({ token: response.name });
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: "Failed to create token" }, { status: 500 });
    }
}
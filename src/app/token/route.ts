import { GoogleGenAI, Modality } from "@google/genai";
import { NextResponse } from "next/server";

export async function GET() {
    const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    try {
        const response = await genAI.authTokens.create({
            config: {
                uses: 1,
                expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                liveConnectConstraints: {
                    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
                    config: {
                        responseModalities: [Modality.AUDIO]
                    }
                },
                httpOptions: { apiVersion: "v1alpha" }
            },
        });

        return NextResponse.json({ token: response.name });
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: "Failed to create token" }, { status: 500 });
    }
}
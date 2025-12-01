import * as Ably from "ably";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ABLY_API_KEY is not set" },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId") ?? "anonymous";

  try {
    const client = new Ably.Rest({ key: apiKey });
    const tokenRequest = await client.auth.createTokenRequest({ clientId });
    return NextResponse.json(tokenRequest);
  } catch (err) {
    console.error("Failed to create Ably token", err);
    return NextResponse.json({ error: "Unable to issue token" }, { status: 500 });
  }
}

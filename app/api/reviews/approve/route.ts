import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "../../../../src/server/runtime";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { reviewId?: string };
    if (!body.reviewId) return NextResponse.json({ error: "reviewId is required" }, { status: 400 });
    const run = await getRuntime().engine.approveReview(body.reviewId);
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not approve review" }, { status: 400 });
  }
}

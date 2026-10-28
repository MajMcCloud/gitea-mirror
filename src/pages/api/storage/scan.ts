import type { APIRoute } from "astro";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { isStorageScanActive, runStorageScan } from "@/lib/storage-service";

const MAX_BODY_BYTES = 10_000;

/**
 * Start a storage scan for the authenticated user.
 *
 * Fire-and-forget: the scan runs in the background so the HTTP request never
 * blocks on Gitea pagination. Progress is polled via /api/storage/scan-status.
 * Read-only API keys are refused by the global middleware (POST requires
 * write access).
 *
 * POST /api/storage/scan  { configId?, repositoryIds? }
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    if (isStorageScanActive(userId)) {
      return jsonResponse({
        data: { success: false, error: "A storage scan is already running", retryable: true },
        status: 409,
      });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return jsonResponse({ data: { success: false, error: "Request body too large" }, status: 413 });
    }

    let configId: string | undefined;
    let repositoryIds: string[] | undefined;
    if (raw.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return jsonResponse({ data: { success: false, error: "Invalid JSON body" }, status: 400 });
      }
      if (parsed && typeof parsed === "object") {
        const body = parsed as Record<string, unknown>;
        if (typeof body.configId === "string" && body.configId.trim()) {
          configId = body.configId.trim();
        }
        if (Array.isArray(body.repositoryIds)) {
          repositoryIds = body.repositoryIds
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            .slice(0, 500);
        }
      }
    }

    // Intentionally not awaited: the scan continues server-side.
    void runStorageScan(userId, { configId, repositoryIds }).catch((error) => {
      console.error("[storage/scan] background scan failed:", error instanceof Error ? error.message : error);
    });

    return jsonResponse({ data: { success: true, started: true }, status: 202 });
  } catch (error) {
    return createSecureErrorResponse(error, "storage scan start", 500);
  }
};

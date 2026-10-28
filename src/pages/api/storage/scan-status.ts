import type { APIRoute } from "astro";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { getStorageScanStatus } from "@/lib/storage-service";

/**
 * Current state of the background storage scan for this user.
 * GET /api/storage/scan-status
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const status = getStorageScanStatus(authResult.userId);
    return jsonResponse({
      data: {
        ...status,
        startedAt: status.startedAt?.toISOString() ?? null,
        finishedAt: status.finishedAt?.toISOString() ?? null,
      },
      status: 200,
    });
  } catch (error) {
    return createSecureErrorResponse(error, "storage scan status", 500);
  }
};

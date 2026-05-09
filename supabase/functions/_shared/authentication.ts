// Based on https://github.com/supabase/supabase/blob/master/examples/edge-functions/supabase/functions/_shared/jwt/default.ts
import * as jose from "jsr:@panva/jose@6";
import { createErrorResponse } from "./utils.ts";

export type AuthenticatedUser = {
  id: string;
  email?: string;
};

const SUPABASE_JWT_SECRET = new TextEncoder().encode(
  Deno.env.get("JWT_SECRET") ?? "",
);

function getAuthToken(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    throw new Error("Missing authorization header");
  }
  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer") {
    throw new Error(`Auth header is not 'Bearer {token}'`);
  }

  return token;
}

function verifySupabaseJWT(jwt: string) {
  return jose.jwtVerify(jwt, SUPABASE_JWT_SECRET, {
    algorithms: ["HS256"],
  });
}

async function getVerifiedUser(req: Request): Promise<AuthenticatedUser> {
  const token = getAuthToken(req);
  const { payload } = await verifySupabaseJWT(token);

  if (typeof payload.sub !== "string") {
    throw new Error("Missing subject claim");
  }

  return {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

/**
 * Validates the Authorization header to ensure that a user is authenticated.
 */
export const AuthMiddleware = async (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => {
  if (req.method === "OPTIONS") return await next(req);

  try {
    await getVerifiedUser(req);
    return await next(req);
  } catch (e) {
    return createErrorResponse(401, e?.toString() || "Unauthorized");
  }
};

/**
 * Get the authenticated user using the authorization header.
 * User will be undefined for OPTIONS requests.
 */
export const UserMiddleware = async (
  req: Request,
  next: (req: Request, user: AuthenticatedUser) => Promise<Response>,
) => {
  if (req.method === "OPTIONS") return await next(req);

  try {
    return next(req, await getVerifiedUser(req));
  } catch (err) {
    return createErrorResponse(401, err?.toString() || "Unauthorized");
  }
};

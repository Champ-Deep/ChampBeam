/**
 * FastAPI-compatible errors. The SPA reads `error.response.data.detail`, so
 * every error body keeps FastAPI's shape:
 *   HTTPException          -> {"detail": "<message>" | <object>}   (status as raised)
 *   request validation     -> 422 {"detail": [{type, loc, msg, input}]}
 *   unhandled exception    -> 500 {"detail": "Internal server error"}
 */

export class HTTPError extends Error {
  constructor(
    public status: number,
    public detail: unknown,
    public headers: Record<string, string> = {},
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "HTTPError";
  }
}

/** `raise HTTPException(status_code=..., detail=...)` */
export function httpError(status: number, detail: unknown, headers?: Record<string, string>): never {
  throw new HTTPError(status, detail, headers);
}

export const notFound = (detail = "Not found"): never => httpError(404, detail);
export const badRequest = (detail: unknown): never => httpError(400, detail);
export const forbidden = (detail: unknown): never => httpError(403, detail);
export const unauthorized = (detail: unknown = "Authentication required"): never =>
  httpError(401, detail, { "WWW-Authenticate": "Bearer" });

export interface ValidationIssue {
  type: string;
  loc: (string | number)[];
  msg: string;
  input?: unknown;
}

export function validationError(issues: ValidationIssue[]): never {
  throw new HTTPError(422, issues);
}

export function errorBody(err: HTTPError): { detail: unknown } {
  return { detail: err.detail };
}

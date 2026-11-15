import { Request } from 'express';

export interface SingleHeaderValue {
  present: boolean;
  value?: string;
}

/**
 * Preserve wire-level header multiplicity. Node's normalized header map may
 * keep only the first Authorization value even though rawHeaders contains
 * every occurrence.
 */
export function readSingleHeader(req: Request, name: string): SingleHeaderValue {
  const lowerName = name.toLowerCase();
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
    const values: string[] = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === lowerName) {
        values.push(req.rawHeaders[index + 1] ?? '');
      }
    }
    return {
      present: values.length > 0,
      value: values.length === 1 ? values[0] : undefined,
    };
  }

  const normalized = req.headers[lowerName];
  return {
    present: normalized !== undefined,
    value: typeof normalized === 'string' ? normalized : undefined,
  };
}

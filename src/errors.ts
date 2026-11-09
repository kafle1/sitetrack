export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const forbidden = (msg = 'You are not allowed to do this') => new HttpError(403, 'forbidden', msg);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);
export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);

export function checkDates(start: string, end: string) {
  if (end < start) throw badRequest('plannedEnd must be on or after plannedStart');
}

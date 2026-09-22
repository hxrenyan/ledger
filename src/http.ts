export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export function badRequest(message: string, code = 'bad_request') {
  return new HttpError(400, code, message)
}

export function unauthorized(message = '请先登录') {
  return new HttpError(401, 'unauthorized', message)
}

export function forbidden(message = '无权访问该账本') {
  return new HttpError(403, 'forbidden', message)
}

export function notFound(message = '记录不存在') {
  return new HttpError(404, 'not_found', message)
}

export function conflict(message: string) {
  return new HttpError(409, 'conflict', message)
}

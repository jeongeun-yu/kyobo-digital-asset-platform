/**
 * AppError 및 파생 에러 클래스 단위 테스트
 */

import {
  AppError,
  NotFoundError,
  InvalidStateError,
  ExternalServiceError,
} from '../errors/AppError';

describe('AppError', () => {
  it('message, code, statusCode 저장', () => {
    const err = new AppError('something went wrong', 'INTERNAL', 500);
    expect(err.message).toBe('something went wrong');
    expect(err.code).toBe('INTERNAL');
    expect(err.statusCode).toBe(500);
  });

  it('name이 "AppError"', () => {
    expect(new AppError('msg', 'CODE').name).toBe('AppError');
  });

  it('statusCode 기본값 500', () => {
    const err = new AppError('msg', 'CODE');
    expect(err.statusCode).toBe(500);
  });

  it('Error 클래스 상속', () => {
    expect(new AppError('msg', 'CODE')).toBeInstanceOf(Error);
  });
});

describe('NotFoundError', () => {
  it('code는 "NOT_FOUND"', () => {
    const err = new NotFoundError('MintRequest', 'req-001');
    expect(err.code).toBe('NOT_FOUND');
  });

  it('statusCode는 404', () => {
    expect(new NotFoundError('Policy', 'p-001').statusCode).toBe(404);
  });

  it('메시지에 resource와 id 포함', () => {
    const err = new NotFoundError('MintRequest', 'req-001');
    expect(err.message).toContain('MintRequest');
    expect(err.message).toContain('req-001');
  });

  it('AppError 상속', () => {
    expect(new NotFoundError('x', 'y')).toBeInstanceOf(AppError);
  });
});

describe('InvalidStateError', () => {
  it('code는 "INVALID_STATE"', () => {
    const err = new InvalidStateError('cannot transition');
    expect(err.code).toBe('INVALID_STATE');
  });

  it('statusCode는 422', () => {
    expect(new InvalidStateError('x').statusCode).toBe(422);
  });

  it('메시지 저장', () => {
    const err = new InvalidStateError('bad state');
    expect(err.message).toBe('bad state');
  });
});

describe('ExternalServiceError', () => {
  it('code는 "EXTERNAL_SERVICE_ERROR"', () => {
    const err = new ExternalServiceError('CoreBanking', 'timeout');
    expect(err.code).toBe('EXTERNAL_SERVICE_ERROR');
  });

  it('statusCode는 502', () => {
    expect(new ExternalServiceError('VASP', 'connection refused').statusCode).toBe(502);
  });

  it('메시지에 service와 cause 포함', () => {
    const err = new ExternalServiceError('CoreBanking', 'timeout');
    expect(err.message).toContain('CoreBanking');
    expect(err.message).toContain('timeout');
  });

  it('AppError 상속', () => {
    expect(new ExternalServiceError('s', 'c')).toBeInstanceOf(AppError);
  });
});

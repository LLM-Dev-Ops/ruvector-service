import { Request, Response } from 'express';
import { createPlanHandler } from '../../src/handlers/plans';
import { firePlanStoredHooks } from '../../src/utils/hooks';

jest.mock('../../src/utils/hooks', () => ({
  firePlanStoredHooks: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  __esModule: true,
}));

const validBody = {
  id: '11111111-1111-4111-8111-111111111111',
  intent: 'deploy safely',
  plan: { steps: ['validate', 'deploy'] },
  org_id: 'org-a',
  user_id: 'user-a',
  checksum: 'a'.repeat(64),
};

function mockRequest(): Request {
  return {
    headers: {},
    header: jest.fn().mockReturnValue(undefined),
    body: validBody,
  } as unknown as Request;
}

function mockResponse(): Response & {
  json: jest.Mock;
  status: jest.Mock;
  setHeader: jest.Mock;
} {
  const response: any = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  response.setHeader = jest.fn().mockReturnValue(response);
  return response;
}

describe('createPlanHandler ownership enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('atomically rejects a duplicate plan owned by another principal', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const response = mockResponse();

    await createPlanHandler(mockRequest(), response, { query } as any);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE plans.org_id = EXCLUDED.org_id'),
      [
        validBody.id,
        validBody.intent,
        JSON.stringify(validBody.plan),
        validBody.org_id,
        validBody.user_id,
        validBody.checksum,
      ]
    );
    expect(query.mock.calls[0][0]).toContain(
      'AND plans.user_id = EXCLUDED.user_id'
    );
    expect(query.mock.calls[0][0]).toContain('RETURNING id');
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'ownership_conflict',
        message: 'Plan ID is already owned by another principal',
      })
    );
    expect(firePlanStoredHooks).not.toHaveBeenCalled();
  });

  it.each([
    ['new plan insert'],
    ['same-owner idempotent update'],
  ])('accepts a successful %s and fires post-store hooks', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: validBody.id }],
      rowCount: 1,
    });
    const response = mockResponse();

    await createPlanHandler(mockRequest(), response, { query } as any);

    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        accepted: true,
        id: validBody.id,
      })
    );
    expect(firePlanStoredHooks).toHaveBeenCalledTimes(1);
    expect(firePlanStoredHooks).toHaveBeenCalledWith(
      {
        plan_id: validBody.id,
        intent: validBody.intent,
        org_id: validBody.org_id,
        checksum: validBody.checksum,
        plan: validBody.plan,
      },
      expect.any(String)
    );
  });
});

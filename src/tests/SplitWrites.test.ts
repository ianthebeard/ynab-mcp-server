import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as CreateTransactionTool from '../tools/CreateTransactionTool';
import * as UpdateTransactionTool from '../tools/UpdateTransactionTool';
import { buildSubtransactions } from '../tools/splits';

const categories = {
  data: {
    category_groups: [
      {
        id: 'group-1', name: 'Everyday', deleted: false, hidden: false,
        categories: [
          { id: 'category-groceries', name: 'Groceries', deleted: false, hidden: false },
          { id: 'category-household', name: 'Household', deleted: false, hidden: false },
        ],
      },
    ],
  },
};

function makeApi() {
  return {
    transactions: {
      createTransaction: vi.fn().mockResolvedValue({ data: { transaction: { id: 'txn-new' } } }),
      updateTransaction: vi.fn(),
      getTransactionById: vi.fn(),
    },
    categories: { getCategories: vi.fn().mockResolvedValue(categories) },
    accounts: { getAccounts: vi.fn() },
  };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe('buildSubtransactions', () => {
  let api: ReturnType<typeof makeApi>;
  beforeEach(() => { api = makeApi(); });

  it('converts legs to milliunits and resolves category names with one fetch', async () => {
    const result = await buildSubtransactions(
      [
        { amount: -60.1, categoryName: 'groceries', memo: 'food' },
        { amount: -39.9, categoryName: 'household' },
      ],
      -100000,
      'budget',
      api as any,
    );

    expect(result.subtransactions).toEqual([
      { amount: -60100, category_id: 'category-groceries', payee_id: undefined, payee_name: undefined, memo: 'food' },
      { amount: -39900, category_id: 'category-household', payee_id: undefined, payee_name: undefined, memo: undefined },
    ]);
    expect(result.matchedCategories).toEqual(['Groceries', 'Household']);
    expect(api.categories.getCategories).toHaveBeenCalledTimes(1);
  });

  it('skips the category fetch when every leg has an id', async () => {
    await buildSubtransactions(
      [{ amount: -1, categoryId: 'a' }, { amount: -2, categoryId: 'b' }],
      -3000, 'budget', api as any,
    );
    expect(api.categories.getCategories).not.toHaveBeenCalled();
  });

  it('rejects legs that do not add up to the total', async () => {
    await expect(
      buildSubtransactions([{ amount: -60 }, { amount: -30 }], -100000, 'budget', api as any),
    ).rejects.toThrow('Split legs add up to -90 but the transaction amount is -100');
  });

  it('rejects a single leg', async () => {
    await expect(
      buildSubtransactions([{ amount: -100 }], -100000, 'budget', api as any),
    ).rejects.toThrow('at least two legs');
  });
});

describe('creating a split transaction', () => {
  let api: ReturnType<typeof makeApi>;
  beforeEach(() => {
    api = makeApi();
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('sends subtransactions with no parent category', async () => {
    const result = await CreateTransactionTool.execute({
      accountId: 'account-1',
      date: '2026-11-19',
      amount: -100,
      payeeName: 'Costco',
      splits: [
        { amount: -60, categoryName: 'groceries' },
        { amount: -40, categoryId: 'category-household' },
      ],
    }, api as any);

    const sent = api.transactions.createTransaction.mock.calls[0][1].transaction;
    expect(sent.category_id).toBeNull();
    expect(sent.amount).toBe(-100000);
    expect(sent.subtransactions.map((s: any) => [s.amount, s.category_id])).toEqual([
      [-60000, 'category-groceries'],
      [-40000, 'category-household'],
    ]);

    const response = parse(result);
    expect(response.success).toBe(true);
    expect(response.matchedSplitCategories).toEqual(['Groceries', null]);
  });

  it('refuses a category alongside splits', async () => {
    const response = parse(await CreateTransactionTool.execute({
      accountId: 'account-1', date: '2026-11-19', amount: -100, payeeName: 'Costco',
      categoryName: 'groceries',
      splits: [{ amount: -60 }, { amount: -40 }],
    }, api as any));

    expect(response.success).toBe(false);
    expect(response.error).toContain('not both');
    expect(api.transactions.createTransaction).not.toHaveBeenCalled();
  });

  it('refuses legs that do not add up, without calling YNAB', async () => {
    const response = parse(await CreateTransactionTool.execute({
      accountId: 'account-1', date: '2026-11-19', amount: -100, payeeName: 'Costco',
      splits: [{ amount: -60 }, { amount: -30 }],
    }, api as any));

    expect(response.success).toBe(false);
    expect(response.error).toContain('add up to -90');
    expect(api.transactions.createTransaction).not.toHaveBeenCalled();
  });
});

describe('splitting an existing transaction', () => {
  let api: ReturnType<typeof makeApi>;
  beforeEach(() => {
    api = makeApi();
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
    api.transactions.getTransactionById.mockResolvedValue({
      data: { transaction: { id: 'txn-1', amount: -100000, subtransactions: [] } },
    });
    api.transactions.updateTransaction.mockResolvedValue({
      data: {
        transaction: {
          id: 'txn-1', amount: -100000, category_name: 'Split',
          subtransactions: [
            { amount: -60000, category_name: 'Groceries', deleted: false },
            { amount: -40000, category_name: 'Household', deleted: false },
          ],
        },
      },
    });
  });

  it('checks legs against the existing amount and sends them', async () => {
    const result = await UpdateTransactionTool.execute({
      transactionId: 'txn-1',
      splits: [
        { amount: -60, categoryName: 'groceries' },
        { amount: -40, categoryName: 'household' },
      ],
    }, api as any);

    const sent = api.transactions.updateTransaction.mock.calls[0][2].transaction;
    expect(sent.category_id).toBeNull();
    expect(sent.subtransactions).toHaveLength(2);

    const response = parse(result);
    expect(response.success).toBe(true);
    expect(response.transaction.subtransactions).toEqual([
      { amount: -60, category_name: 'Groceries' },
      { amount: -40, category_name: 'Household' },
    ]);
  });

  it('checks legs against a new amount when one is given', async () => {
    const response = parse(await UpdateTransactionTool.execute({
      transactionId: 'txn-1',
      amount: -120,
      splits: [{ amount: -60 }, { amount: -40 }],
    }, api as any));

    expect(response.success).toBe(false);
    expect(response.error).toContain('transaction amount is -120');
  });

  it('refuses to re-split a transaction that is already split', async () => {
    api.transactions.getTransactionById.mockResolvedValue({
      data: {
        transaction: {
          id: 'txn-1', amount: -100000,
          subtransactions: [{ amount: -100000, deleted: false }],
        },
      },
    });

    const response = parse(await UpdateTransactionTool.execute({
      transactionId: 'txn-1',
      splits: [{ amount: -60 }, { amount: -40 }],
    }, api as any));

    expect(response.success).toBe(false);
    expect(response.error).toContain('already split');
    expect(api.transactions.updateTransaction).not.toHaveBeenCalled();
  });

  it('leaves ordinary updates untouched', async () => {
    await UpdateTransactionTool.execute({ transactionId: 'txn-1', memo: 'hi' }, api as any);
    expect(api.transactions.getTransactionById).not.toHaveBeenCalled();
    expect(api.transactions.updateTransaction.mock.calls[0][2].transaction).toEqual({ memo: 'hi' });
  });
});

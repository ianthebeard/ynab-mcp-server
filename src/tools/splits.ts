import { z } from "zod";
import * as ynab from "ynab";
import { toDollars, toMilliunits } from "./money.js";
import { resolveName, NamedEntity } from "./match.js";

/** One leg of a split transaction, in plain currency amounts. */
export interface SubtransactionData {
  amount: number;
  category_name?: string | null;
  payee_name?: string | null;
  memo?: string | null;
}

/**
 * Maps the legs of a split transaction for output.
 *
 * YNAB reports a split's parent row as the category "Split" and puts the real
 * categories on the subtransactions. Without them a split reads as though it
 * were uncategorized, so any tool that lists transactions has to carry them.
 *
 * Returns undefined for an ordinary transaction, so the field is simply absent
 * rather than an empty array.
 */
export function mapSubtransactions(
  subtransactions: ynab.SubTransaction[] | undefined,
): SubtransactionData[] | undefined {
  const active = (subtransactions ?? []).filter((sub) => !sub.deleted);
  if (active.length === 0) {
    return undefined;
  }

  return active.map((sub) => ({
    amount: toDollars(sub.amount),
    category_name: sub.category_name,
    payee_name: sub.payee_name,
    memo: sub.memo,
  }));
}

/**
 * Input schema for the legs of a split, shared by the create and update tools.
 * Amounts are plain currency, signed the same way as the parent transaction.
 */
export const splitsInputSchema = z
  .array(
    z.object({
      amount: z.number().describe("The amount of this leg in dollars, signed like the parent (e.g. -12.50 for spending)"),
      categoryId: z.string().optional().describe("The category id for this leg (optional)"),
      categoryName: z.string().optional().describe("The category name for this leg, matched loosely (optional; ignored if categoryId is provided)"),
      payeeId: z.string().optional().describe("A payee id for this leg, if it differs from the parent (optional)"),
      payeeName: z.string().optional().describe("A payee name for this leg, if it differs from the parent (optional)"),
      memo: z.string().optional().describe("A memo for this leg (optional)"),
    }),
  )
  .min(2)
  .optional()
  .describe(
    "Split the transaction across categories. Give at least two legs whose amounts add up exactly to the transaction amount. Don't combine with a top-level category.",
  );

export interface SplitInput {
  amount: number;
  categoryId?: string;
  categoryName?: string;
  payeeId?: string;
  payeeName?: string;
  memo?: string;
}

/**
 * Turns split legs into the subtransactions YNAB expects.
 *
 * Checks the legs add up to the parent amount before anything is sent: YNAB
 * rejects a mismatch anyway, but with a far less useful message. Category
 * names are resolved with a single categories fetch, and only if a leg needs it.
 */
export async function buildSubtransactions(
  splits: SplitInput[],
  totalMilliunits: number,
  budgetId: string,
  api: ynab.API,
): Promise<{ subtransactions: ynab.SaveSubTransaction[]; matchedCategories: (string | undefined)[] }> {
  if (splits.length < 2) {
    throw new Error("A split needs at least two legs");
  }

  const legMilliunits = splits.map((leg) => toMilliunits(leg.amount));
  const sum = legMilliunits.reduce((acc, value) => acc + value, 0);
  if (sum !== totalMilliunits) {
    throw new Error(
      `Split legs add up to ${toDollars(sum)} but the transaction amount is ${toDollars(totalMilliunits)}`,
    );
  }

  let categories: NamedEntity[] | undefined;
  const matchedCategories: (string | undefined)[] = [];
  const subtransactions: ynab.SaveSubTransaction[] = [];

  for (const [index, leg] of splits.entries()) {
    let categoryId = leg.categoryId;
    let matched: string | undefined;

    if (!categoryId && leg.categoryName) {
      categories ??= await loadCategories(budgetId, api);
      const match = resolveName(leg.categoryName, categories, "category");
      categoryId = match.id;
      matched = match.name;
    }

    matchedCategories.push(matched);
    subtransactions.push({
      amount: legMilliunits[index],
      category_id: categoryId,
      payee_id: leg.payeeId,
      payee_name: leg.payeeName,
      memo: leg.memo,
    });
  }

  return { subtransactions, matchedCategories };
}

/** The visible categories of a budget, for name matching. */
export async function loadCategories(budgetId: string, api: ynab.API): Promise<NamedEntity[]> {
  const response = await api.categories.getCategories(budgetId);
  return response.data.category_groups
    .filter((group) => !group.deleted && !group.hidden)
    .flatMap((group) => group.categories)
    .filter((category) => !category.deleted && !category.hidden);
}

/** True when a transaction is already a split (YNAB won't re-split it). */
export function isSplit(transaction: { subtransactions?: ynab.SubTransaction[] }): boolean {
  return (transaction.subtransactions ?? []).some((sub) => !sub.deleted);
}

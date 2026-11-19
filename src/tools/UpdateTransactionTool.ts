import { z } from "zod";
import * as ynab from "ynab";
import { getErrorMessage } from "./errorUtils.js";
import { toDollars, toMilliunits } from "./money.js";
import { buildSubtransactions, isSplit, mapSubtransactions, splitsInputSchema, SplitInput } from "./splits.js";

export const name = "ynab_update_transaction";
export const description = "Updates an existing transaction. All fields except transactionId are optional - only provide fields you want to change. Pass `splits` to split an unsplit transaction across categories; YNAB does not allow changing the legs of a transaction that is already split (delete and recreate it instead).";
export const inputSchema = {
  budgetId: z.string().optional().describe("The ID of the budget (optional, defaults to YNAB_BUDGET_ID environment variable)"),
  transactionId: z.string().describe("The ID of the transaction to update"),
  accountId: z.string().optional().describe("Move transaction to a different account"),
  date: z.string().optional().describe("The date of the transaction in ISO format (e.g. 2024-03-24)"),
  amount: z.number().optional().describe("The amount in dollars (e.g. -10.99 for outflow, 10.99 for inflow)"),
  payeeId: z.string().optional().describe("The ID of the payee"),
  payeeName: z.string().optional().describe("The name of the payee (creates new payee if doesn't exist)"),
  categoryId: z.string().optional().describe("The category ID for the transaction"),
  memo: z.string().optional().describe("A memo/note for the transaction"),
  cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional().describe("The cleared status"),
  approved: z.boolean().optional().describe("Whether the transaction is approved"),
  flagColor: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).optional().describe("The transaction flag color"),
  splits: splitsInputSchema,
};

interface UpdateTransactionInput {
  budgetId?: string;
  transactionId: string;
  accountId?: string;
  date?: string;
  amount?: number;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  memo?: string;
  cleared?: "cleared" | "uncleared" | "reconciled";
  approved?: boolean;
  flagColor?: "red" | "orange" | "yellow" | "green" | "blue" | "purple";
  splits?: SplitInput[];
}

function getBudgetId(inputBudgetId?: string): string {
  const budgetId = inputBudgetId || process.env.YNAB_BUDGET_ID || "";
  if (!budgetId) {
    throw new Error("No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.");
  }
  return budgetId;
}

function mapClearedStatus(cleared: string): ynab.TransactionClearedStatus {
  switch (cleared) {
    case "cleared":
      return ynab.TransactionClearedStatus.Cleared;
    case "reconciled":
      return ynab.TransactionClearedStatus.Reconciled;
    default:
      return ynab.TransactionClearedStatus.Uncleared;
  }
}

export async function execute(input: UpdateTransactionInput, api: ynab.API) {
  try {
    const budgetId = getBudgetId(input.budgetId);

    // Build the update object with only provided fields
    const transactionUpdate: ynab.SaveTransactionWithOptionalFields = {};

    if (input.accountId !== undefined) {
      transactionUpdate.account_id = input.accountId;
    }
    if (input.date !== undefined) {
      transactionUpdate.date = input.date;
    }
    if (input.amount !== undefined) {
      transactionUpdate.amount = toMilliunits(input.amount);
    }
    if (input.payeeId !== undefined) {
      transactionUpdate.payee_id = input.payeeId;
    }
    if (input.payeeName !== undefined) {
      transactionUpdate.payee_name = input.payeeName;
    }
    if (input.categoryId !== undefined) {
      transactionUpdate.category_id = input.categoryId;
    }
    if (input.memo !== undefined) {
      transactionUpdate.memo = input.memo;
    }
    if (input.cleared !== undefined) {
      transactionUpdate.cleared = mapClearedStatus(input.cleared);
    }
    if (input.approved !== undefined) {
      transactionUpdate.approved = input.approved;
    }
    if (input.flagColor !== undefined) {
      transactionUpdate.flag_color = input.flagColor as ynab.TransactionFlagColor;
    }

    let matchedSplitCategories: (string | undefined)[] | undefined;
    if (input.splits) {
      if (input.categoryId !== undefined) {
        throw new Error("Give either categoryId or splits, not both - each split leg carries its own category");
      }

      // Look first: YNAB refuses to re-split, and the legs must add up to the
      // amount, which may not be part of this update.
      const existing = await api.transactions.getTransactionById(budgetId, input.transactionId);
      if (isSplit(existing.data.transaction)) {
        throw new Error(
          "This transaction is already split, and YNAB does not allow changing its legs. Delete it and create it again with the new splits.",
        );
      }

      const total = transactionUpdate.amount ?? existing.data.transaction.amount;
      const split = await buildSubtransactions(input.splits, total, budgetId, api);
      transactionUpdate.category_id = null;
      transactionUpdate.subtransactions = split.subtransactions;
      matchedSplitCategories = split.matchedCategories;
    }

    const response = await api.transactions.updateTransaction(
      budgetId,
      input.transactionId,
      { transaction: transactionUpdate }
    );

    if (!response.data.transaction) {
      throw new Error("Failed to update transaction - no transaction data returned");
    }

    const txn = response.data.transaction;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          transaction: {
            id: txn.id,
            date: txn.date,
            amount: toDollars(txn.amount),
            payee_name: txn.payee_name,
            category_name: txn.category_name,
            memo: txn.memo,
            cleared: txn.cleared,
            approved: txn.approved,
            account_name: txn.account_name,
            flag_color: txn.flag_color,
            subtransactions: mapSubtransactions(txn.subtransactions),
          },
          matchedSplitCategories,
          message: "Transaction updated successfully",
        }, null, 2),
      }],
    };
  } catch (error) {
    console.error("Error updating transaction:", error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: getErrorMessage(error),
        }, null, 2),
      }],
    };
  }
}

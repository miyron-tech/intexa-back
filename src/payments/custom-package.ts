import { BadRequestException } from '@nestjs/common';

export const CUSTOM_PACKAGE = {
  minAmountCents: 500,
  maxAmountCents: 50_000,
  stepAmountCents: 500,
  creditsPerStep: 250,
  defaultAmountCents: 2_000,
};

export function quoteCustomPackage(amountCents: unknown) {
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents)
    || amountCents < CUSTOM_PACKAGE.minAmountCents || amountCents > CUSTOM_PACKAGE.maxAmountCents
    || amountCents % CUSTOM_PACKAGE.stepAmountCents !== 0) {
    throw new BadRequestException('Choose a custom amount from $5 to $500 in $5 steps.');
  }
  return {
    id: 'custom', name: 'Custom credits', monthly_cents: amountCents,
    credits: amountCents / CUSTOM_PACKAGE.stepAmountCents * CUSTOM_PACKAGE.creditsPerStep,
  };
}

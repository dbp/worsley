"""Discount codes and tax."""

TAX_RATE = 0.10

# Each code takes a percentage off the subtotal.
DISCOUNTS = {
    "SAVE10": 0.10,
    "HALF": 0.50,
}


def apply_discount(amount: float, code: str | None) -> float:
    """The amount after the discount for `code`; unknown codes change nothing."""
    if code is None:
        return amount
    rate = DISCOUNTS.get(code.upper())
    if rate is None:
        return amount
    return amount * (1 - rate)


def add_tax(amount: float) -> float:
    return amount * (1 + TAX_RATE)

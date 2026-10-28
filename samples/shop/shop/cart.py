"""What is being bought, and what it costs."""

from dataclasses import dataclass, field

from .pricing import add_tax, apply_discount


@dataclass
class Item:
    name: str
    price: float


@dataclass
class Cart:
    items: list[Item] = field(default_factory=list)
    code: str | None = None

    def add(self, item: Item) -> None:
        self.items.append(item)

    def subtotal(self) -> float:
        return sum(item.price for item in self.items)

    def total(self) -> float:
        """The discount comes off before tax, so tax is only on what is paid."""
        discounted = apply_discount(self.subtotal(), self.code)
        return round(add_tax(discounted), 2)

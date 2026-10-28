"""The command line: `python3 -m shop.cli apple=0.50 bread=1.20 --code SAVE10`."""

import argparse
import sys

from .cart import Cart, Item


def parse_item(text: str) -> Item:
    name, _, price = text.partition("=")
    if not price:
        raise argparse.ArgumentTypeError(f"expected name=price, not {text!r}")
    return Item(name, float(price))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Add up a shopping cart.")
    parser.add_argument("items", nargs="+", type=parse_item, help="name=price")
    parser.add_argument("--code", help="a discount code")
    args = parser.parse_args(argv)

    cart = Cart(code=args.code)
    for item in args.items:
        cart.add(item)
    print(f"{cart.total():.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

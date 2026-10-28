import unittest

from shop.cart import Cart, Item
from shop.pricing import apply_discount


class CartTest(unittest.TestCase):
    def test_total_adds_tax(self):
        cart = Cart([Item("apple", 0.50), Item("bread", 1.50)])
        self.assertEqual(cart.total(), 2.20)

    def test_discount_before_tax(self):
        cart = Cart([Item("book", 10.00)], code="SAVE10")
        self.assertEqual(cart.total(), 9.90)

    def test_unknown_code_changes_nothing(self):
        self.assertEqual(apply_discount(5.0, "NOPE"), 5.0)


if __name__ == "__main__":
    unittest.main()
